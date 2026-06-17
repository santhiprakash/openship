/**
 * Pre-deploy checks - validate prerequisites before the build pipeline starts.
 *
 * Called after the user clicks Deploy but BEFORE any build work begins.
 * If any check fails, the deployment is rejected with actionable errors -
 * no resources are provisioned, no build session started.
 *
 * Cloud checks are SaaS-owned:
 *   - SaaS mode calls the shared cloud preflight service directly
 *   - Desktop/local mode calls the SaaS preflight endpoint
 *   - Local/desktop never talks to Oblien directly for preflight
 */

import type { DeploymentConfigSnapshot } from "./build.service";
import { platform } from "../../lib/controller-helpers";
import { resolveServiceHostnameLabel } from "@repo/core";
import { getCloudPreflight } from "../../lib/cloud-client";
import { runCloudPreflight, type CloudPreflightData } from "../../lib/cloud-preflight";
import type { DeployableService } from "../../lib/deployable-service";
import { serviceKind } from "./compose/project-services";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { resolveServerHost } from "../../lib/server-target";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import {
  getInstallationId,
  getInstallationIdByOrg,
  getGitHubAuthMode,
  getInstallUrl,
  resolveGitHubAuthMode,
} from "../github/github.auth";
import { canResolveTokenFor } from "../github/github.token";
import { resolveRecords, lookupAddresses } from "../../lib/dns-resolver";

export interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  message?: string;
  code?: string;
}

export const PREFLIGHT_ERROR_CODES = {
  CLOUD_REQUIRED_TARGET: "CLOUD_REQUIRED_TARGET",
  CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN: "CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN",
  CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS: "CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS",
  GITHUB_APP_INSTALLATION_REQUIRED: "GITHUB_APP_INSTALLATION_REQUIRED",
  REMOTE_BUILD_TOKEN_LEAK_RISK: "REMOTE_BUILD_TOKEN_LEAK_RISK",
  /** gh CLI auth + remote-server build target. clone-auth.ts will throw
   *  GITHUB_CLI_REMOTE_BUILD_REJECTED at deploy time — surface it earlier
   *  so the user can fix it before provisioning starts. */
  GITHUB_CLI_REMOTE_BUILD_REJECTED: "GITHUB_CLI_REMOTE_BUILD_REJECTED",
  /** No remote-safe clone token resolvable for the project's owner.
   *  Atomic — same `tokenFor(purpose:"remote")` resolver that clone-auth
   *  uses at deploy time. Failing here surfaces the missing-credential
   *  modal up-front instead of letting the build pipeline fail later. */
  GITHUB_REMOTE_TOKEN_REQUIRED: "GITHUB_REMOTE_TOKEN_REQUIRED",
} as const;

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  customDomain?: string;
  slug?: string;
  userId?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  composeServices?: DeployableService[];
  multiService?: boolean;
  /** Git owner (org / user) for the project's source repo. When the
   *  deployment targets cloud, we check that the GitHub App is installed
   *  on this owner - otherwise the build will fail with a token error
   *  AFTER provisioning resources. Catching it here surfaces a clear
   *  "install the App on <owner>" message and skips the wasted work. */
  gitOwner?: string | null;
  /** Project id — passed to `tokenFor` so per-project clone tokens are
   *  considered as a valid remote-clone source. Optional because the
   *  project row may not exist yet during a first-deploy preflight. */
  projectId?: string;
  /** Active organization id — when set, App installation lookup prefers
   *  `(organizationId, owner)` over the `(userId, owner)` path.
   *  Multi-user safety: a teammate's deploy shouldn't depend on whichever
   *  org member happened to install the App. */
  organizationId?: string;
  /** Whether the build runs on the API host (`local`) or on the deploy
   *  target (`server`). For non-App auth modes, only `local` keeps the
   *  user's broad-scope token from leaving the API process. */
  buildStrategy?: "local" | "server";
}

/**
 * Check the GitHub App is installed for the project's owner. Cloud builds
 * REQUIRE an installation token (no OAuth fallback - sending a long-lived
 * user-scope token to cloud infra would be too broad). If the owner has
 * no installation row, every cloud build for this project will fail with
 * a 403 from `resolveBuildGitToken`. Catch it in preflight so the user
 * sees an actionable message + the install URL.
 */
async function checkGitHubAppInstallation(
  userId: string | undefined,
  owner: string | null | undefined,
  organizationId?: string,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "github-app-installation",
    label: "GitHub App access",
  };
  if (!userId) {
    return { ...baseCheck, status: "warn", message: "User session missing - skipping check." };
  }
  if (!owner) {
    return { ...baseCheck, status: "pass" };
  }
  // Per-user mode resolution — picks "cloud-app" on self-hosted +
  // cloud-connected. Both App-scoped modes need an installation on
  // the owner; cli / oauth / token modes don't (they use the user's
  // own credentials, not installation-scoped tokens).
  const mode = await resolveGitHubAuthMode(userId);
  if (mode !== "app" && mode !== "cloud-app") {
    return { ...baseCheck, status: "pass" };
  }
  // Mirror tokenFor: prefer org-scoped installation row, fall back to
  // the per-user row.
  let installationId: number | null = null;
  if (organizationId) {
    installationId = await getInstallationIdByOrg(organizationId, owner).catch(() => null);
  }
  if (!installationId) {
    installationId = await getInstallationId(userId, owner).catch(() => null);
  }
  if (installationId) {
    return { ...baseCheck, status: "pass" };
  }
  return {
    ...baseCheck,
    status: "fail",
    code: PREFLIGHT_ERROR_CODES.GITHUB_APP_INSTALLATION_REQUIRED,
    message:
      `The Openship GitHub App is not installed on "${owner}". ` +
      `Deploys need it to mint a scoped token for cloning the repo. ` +
      `Install it at ${getInstallUrl()} and deploy again.`,
  };
}

/**
 * Warn when a deploy will ship the user's broad-scope token to a remote
 * build worker. This happens specifically when:
 *
 *   - The API runs in a non-App mode (oauth / cli / token) - no short-lived
 *     installation token exists to mint.
 *   - The build runs on the deploy target (`buildStrategy === "server"`),
 *     not on the API host - so the token has to travel.
 *   - The deploy target is remote (not the same host as the API).
 *
 * In that combination, today we ship the OAuth / gh / static PAT to the
 * remote target as `x-access-token` for clone. That token has access to
 * the user's entire GitHub footprint. A future phase will route this via
 * API-proxied clone + tarball ship so no token leaves the API process.
 * Until then, this preflight check surfaces the trade-off and recommends
 * switching to `buildStrategy=local` (which is already safe).
 */
async function checkRemoteBuildTokenLeak(
  userId: string | undefined,
  effectiveTarget: string,
  buildStrategy: "local" | "server" | undefined,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "remote-build-token",
    label: "Remote build credential",
  };
  // Per-user resolution so cloud-app (self-hosted + cloud-connected)
  // gets recognised as App-scoped. Fall back to sync resolution when
  // no userId is available (e.g. preflight invoked from a CLI tool).
  const mode = userId ? await resolveGitHubAuthMode(userId) : getGitHubAuthMode();
  // App-scoped modes (local-signed or cloud-proxied) already use
  // short-lived installation tokens — safe to ship to a remote build.
  if (mode === "app" || mode === "cloud-app") return { ...baseCheck, status: "pass" };
  if (buildStrategy === "local") return { ...baseCheck, status: "pass" };
  if (effectiveTarget === "cloud") return { ...baseCheck, status: "pass" };

  // gh CLI tokens are the user's personal long-lived PAT. clone-auth.ts
  // hard-refuses these on remote builds (GITHUB_CLI_REMOTE_BUILD_REJECTED).
  // Surface that here so the user fixes it BEFORE provisioning starts.
  if (mode === "cli") {
    return {
      ...baseCheck,
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.GITHUB_CLI_REMOTE_BUILD_REJECTED,
      message:
        `gh CLI auth only works for local builds. ` +
        `Connect the Openship App in Settings → GitHub, or set a per-project ` +
        `clone token, then deploy again.`,
    };
  }

  // Other non-App modes (oauth / static token) — ship-the-token risk
  // is the user/operator's explicit choice. Warn but don't refuse.
  return {
    ...baseCheck,
    status: "warn",
    code: PREFLIGHT_ERROR_CODES.REMOTE_BUILD_TOKEN_LEAK_RISK,
    message:
      `Building on the remote target will ship your GitHub credential there. ` +
      `Switch to "Build on this machine" (buildStrategy=local) to keep the token ` +
      `on the API host, or install the GitHub App to mint short-lived per-repo tokens.`,
  };
}

/**
 * Atomic remote-clone-token check. The single source of truth for
 * "can this deploy actually clone the repo on the build worker?" — runs
 * the same `tokenFor(userId, "remote", ...)` resolver clone-auth uses at
 * deploy time, but non-throwing.
 *
 * Skipped when:
 *   - no userId / no owner (nothing to resolve)
 *   - buildStrategy === "local" (clone happens on the API host, not remote)
 *   - effectiveTarget === "local" (no remote at all)
 *
 * On fail, emits GITHUB_REMOTE_TOKEN_REQUIRED — the dashboard maps that
 * code to DeployCredentialModal (install App / add PAT /
 * build locally). This subsumes the per-mode App-installation check
 * for the remote-clone case but we keep `checkGitHubAppInstallation`
 * for clearer error copy when the App is configured but uninstalled.
 */
async function checkRemoteCloneToken(
  userId: string | undefined,
  owner: string | null | undefined,
  projectId: string | undefined,
  effectiveTarget: string,
  buildStrategy: "local" | "server" | undefined,
  organizationId?: string,
): Promise<PreflightCheck> {
  const baseCheck = {
    id: "remote-clone-token",
    label: "Remote clone credential",
  };
  if (!userId || !owner) return { ...baseCheck, status: "pass" };
  if (buildStrategy === "local") return { ...baseCheck, status: "pass" };
  if (effectiveTarget === "local") return { ...baseCheck, status: "pass" };

  // Existence check only — no mint. The real mint happens later in the
  // build pipeline when we actually need to clone.
  const source = await canResolveTokenFor(userId, "remote", {
    projectId,
    owner,
    organizationId,
  }).catch(() => null);
  if (source) return { ...baseCheck, status: "pass" };

  return {
    ...baseCheck,
    status: "fail",
    code: PREFLIGHT_ERROR_CODES.GITHUB_REMOTE_TOKEN_REQUIRED,
    message:
      `No GitHub credential available to clone "${owner}" onto the build worker. ` +
      `Install the Openship App on this owner, add a per-project clone token, ` +
      `or switch to "Build on this machine" so the credential stays on the API host.`,
  };
}

async function checkPublicEndpoints(
  snapshot: DeploymentConfigSnapshot,
  endpoints: NonNullable<PreflightOptions["publicEndpoints"]>,
  cloud: CloudPreflightData | null,
  userId?: string,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const seenHostnames = new Set<string>();
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;
  const isCloudStatic = effectiveTarget === "cloud" && !snapshot.hasServer;

  if (isCloudStatic) {
    const staticPathEndpoints = endpoints.filter((endpoint) => typeof endpoint.targetPath === "string");

    if (staticPathEndpoints.length > 1) {
      checks.push({
        id: "endpoint-static-cloud-shape",
        label: "Static endpoint routing",
        status: "fail",
        message: "Cloud static deployments currently support only one explicit path-targeted public endpoint.",
      });
    }
  }

  for (const endpoint of endpoints) {
    const normalizedTargetPath = normalizeTargetPath(endpoint.targetPath);
    const hasPortTarget = endpoint.port !== undefined;
    const hasPathTarget = Boolean(normalizedTargetPath);
    const endpointPort = endpoint.port;
    const destinationLabel = hasPathTarget
      ? normalizedTargetPath!
      : endpointPort != null
        ? String(endpointPort)
        : "unknown";

    if (hasPortTarget === hasPathTarget) {
      checks.push({
        id: `endpoint-target-${destinationLabel}`,
        label: `Endpoint target (${destinationLabel})`,
        status: "fail",
        message: "Each endpoint must target exactly one destination: either a port or a static path.",
      });
      continue;
    }

    if (hasPortTarget) {
      const port = endpointPort as number;

      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        checks.push({
          id: `endpoint-port-${destinationLabel}`,
          label: `Endpoint port (${destinationLabel})`,
          status: "fail",
          message: "Port must be between 1 and 65535.",
        });
      }
    }

    if (hasPathTarget && !normalizedTargetPath) {
      checks.push({
        id: `endpoint-path-${destinationLabel}`,
        label: `Endpoint path (${destinationLabel})`,
        status: "fail",
        message: "Static target paths must be rooted, normalized paths inside the build output.",
      });
    }

    if (hasPortTarget && !snapshot.hasServer) {
      checks.push({
        id: `endpoint-shape-${destinationLabel}`,
        label: `Endpoint target (${destinationLabel})`,
        status: "fail",
        message: "Static deployments cannot expose port-targeted routes. Use a static target path instead.",
      });
    }

    if (hasPathTarget && snapshot.hasServer) {
      checks.push({
        id: `endpoint-shape-${destinationLabel}`,
        label: `Endpoint target (${destinationLabel})`,
        status: "fail",
        message: "Server deployments must expose port-targeted routes. Static target paths are only valid for static deployments.",
      });
    }

    if (endpoint.domainType === "custom") {
      const hostname = endpoint.customDomain?.trim().toLowerCase();
      if (!hostname) {
        checks.push({
          id: `endpoint-domain-${destinationLabel}`,
          label: `Endpoint domain (${destinationLabel})`,
          status: "fail",
          message: "Custom endpoint domains cannot be empty.",
        });
        continue;
      }

      if (seenHostnames.has(hostname)) {
        checks.push({
          id: `endpoint-domain-${destinationLabel}`,
          label: `Endpoint domain (${destinationLabel})`,
          status: "fail",
          message: `Duplicate domain configured: ${hostname}`,
        });
        continue;
      }

      seenHostnames.add(hostname);
      const endpointCloud = cloud?.runtime.ok && userId
        ? await requestCloudPreflight(snapshot, userId, { customDomain: hostname })
        : cloud;
      const result = await checkCustomDomain(hostname, endpointCloud, snapshot);
      checks.push({
        ...result,
        id: `endpoint-domain-${destinationLabel}`,
        label: `Endpoint domain (${destinationLabel})`,
      });
      continue;
    }

    const slug = endpoint.domain?.trim().toLowerCase();
    if (!slug) {
      checks.push({
        id: `endpoint-slug-${destinationLabel}`,
        label: `Endpoint subdomain (${destinationLabel})`,
        status: "fail",
        message: "Free endpoint subdomains cannot be empty.",
      });
      continue;
    }

    const slugCheck = checkSlugFormat(slug);
    checks.push({
      ...slugCheck,
      id: `endpoint-slug-${destinationLabel}`,
      label: `Endpoint subdomain (${destinationLabel})`,
    });

    const hostname = `${slug}.${getRoutingBaseDomain()}`;
    if (seenHostnames.has(hostname)) {
      checks.push({
        id: `endpoint-domain-${destinationLabel}`,
        label: `Endpoint domain (${destinationLabel})`,
        status: "fail",
        message: `Duplicate domain configured: ${hostname}`,
      });
      continue;
    }

    seenHostnames.add(hostname);

    if (cloud?.runtime.ok && userId) {
      const endpointCloud = await requestCloudPreflight(snapshot, userId, { slug });
      const availability = await checkSlug(slug, endpointCloud);
      checks.push({
        ...availability,
        id: `endpoint-slug-available-${destinationLabel}`,
        label: `Endpoint availability (${destinationLabel})`,
      });
    }
  }

  return checks;
}

async function checkComposeServiceDomains(
  composeServices: DeployableService[],
  projectSlug: string | undefined,
  cloud: CloudPreflightData | null,
  snapshot?: DeploymentConfigSnapshot,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const seen = new Set<string>();
  const baseDomain = getRoutingBaseDomain();

  for (const service of composeServices) {
    if (!service.exposed) continue;

    if (service.domainType === "custom" && service.customDomain?.trim()) {
      const domain = service.customDomain.trim().toLowerCase();
      if (seen.has(domain)) {
        checks.push({
          id: `service-domain-${service.name}`,
          label: `Service domain (${service.name})`,
          status: "fail",
          message: `Duplicate custom domain configured: ${domain}`,
        });
        continue;
      }
      seen.add(domain);

      const result = await checkCustomDomain(domain, cloud, snapshot);
      checks.push({
        ...result,
        id: `service-domain-${service.name}`,
        label: `Service domain (${service.name})`,
      });
      continue;
    }

    const subdomain = resolveServiceHostnameLabel(
      projectSlug || "project",
      service.name,
      service.domain,
      serviceKind(service),
    );
    const fqdn = `${subdomain}.${baseDomain}`;

    // Free subdomains require cloud - fail early if not connected
    if (!cloud) {
      checks.push({
        id: `service-domain-${service.name}`,
        label: `Service subdomain (${service.name})`,
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS,
        message: `Free subdomain "${fqdn}" requires Openship Cloud. Connect your account or switch to a custom domain.`,
      });
      continue;
    }

    if (seen.has(fqdn)) {
      checks.push({
        id: `service-domain-${service.name}`,
        label: `Service domain (${service.name})`,
        status: "fail",
        message: `Duplicate service subdomain configured: ${subdomain}`,
      });
      continue;
    }
    seen.add(fqdn);

    const result = checkSlugFormat(subdomain);
    checks.push({
      ...result,
      id: `service-domain-${service.name}`,
      label: `Service subdomain (${service.name})`,
    });
  }

  return checks;
}

async function requestCloudPreflight(
  snapshot: DeploymentConfigSnapshot,
  userId: string,
  input: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData | null> {
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;

  if (plat.target === "cloud") {
    return runCloudPreflight(userId, input);
  }

  if (effectiveTarget === "cloud" || plat.target === "desktop") {
    if (!snapshot.organizationId) return null;
    return getCloudPreflight(snapshot.organizationId, input);
  }

  return null;
}

async function resolveCloudPreflight(
  snapshot: DeploymentConfigSnapshot,
  opts?: PreflightOptions,
): Promise<CloudPreflightData | null> {
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;

  // MUST match deployment-runtime.ts:usesManagedRouting. If these two
  // calculations drift, the preflight gate (CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN)
  // becomes meaningless: a project that would crash at deploy time inside
  // ensureManagedEdgeProxy (because no cloud account is linked) sails
  // through preflight and dies AFTER the build runs.
  const usesManagedRouting =
    plat.target === "selfhosted" ||
    (plat.target === "desktop" && (effectiveTarget === "server" || effectiveTarget === "local"));
  const hasManagedPublicEndpoints =
    opts?.publicEndpoints?.some((endpoint) => endpoint.domainType !== "custom") ?? false;
  const needsManagedProjectDomain =
    (!!opts?.slug && !opts?.customDomain && usesManagedRouting) ||
    (usesManagedRouting && hasManagedPublicEndpoints);
  const needsManagedComposeDomains =
    opts?.composeServices?.some((service) => service.exposed && service.domainType !== "custom") ??
    false;
  const needsCloudPreflight =
    effectiveTarget === "cloud" || needsManagedProjectDomain || needsManagedComposeDomains;
  const requestInput = opts?.publicEndpoints?.length
    ? {}
    : {
        slug: opts?.slug,
        customDomain: opts?.customDomain,
      };

  if (!needsCloudPreflight || !opts?.userId) {
    return null;
  }

  return requestCloudPreflight(snapshot, opts.userId, requestInput);
}

function checkConfig(snapshot: DeploymentConfigSnapshot, opts?: PreflightOptions): PreflightCheck {
  const missing: string[] = [];

  if (!snapshot.repoUrl && !snapshot.localPath) missing.push("repository URL or local path");
  if (!snapshot.branch && !snapshot.localPath) missing.push("branch");

  if (opts?.multiService) {
    if (missing.length > 0) {
      return {
        id: "config",
        label: "Service configuration",
        status: "fail",
        message: `Missing required fields: ${missing.join(", ")}`,
      };
    }

    // Monorepo sub-app sanity: every kind="monorepo" row with a buildable
    // shape must end up with an installCommand somewhere - either set on
    // the row itself OR inherited from the project-level snapshot. Without
    // that, the runtime synthesizes a Dockerfile that runs an empty install
    // step and fails opaquely deep into the build. Surface the missing
    // value here so the operator sees "sub-app X has no install command"
    // before resources are provisioned.
    const subAppFailures: string[] = [];
    for (const svc of opts.composeServices ?? []) {
      if (svc.kind !== "monorepo") continue;
      // Disabled sub-apps never run; skip. `enabled === false` is the
      // explicit opt-out - `exposed` is a routing concept (does the
      // sub-app get a public URL) and conflating them lets enabled-but-
      // not-exposed sub-apps slip past this check with no install command.
      if (svc.enabled === false) continue;
      if (!svc.rootDirectory) {
        subAppFailures.push(`sub-app "${svc.name}" missing rootDirectory`);
        continue;
      }
      const installFallback = svc.installCommand ?? snapshot.installCommand;
      const buildFallback = svc.buildCommand ?? snapshot.buildCommand;
      const startFallback = svc.startCommand ?? snapshot.startCommand;
      // hasBuild/hasServer aren't per-service today - fall back to the
      // project-level booleans on the snapshot. Conservative: if either
      // the project says it has a build OR has a server, the sub-app must
      // expose enough commands to honor that contract.
      if (snapshot.hasBuild && !installFallback) {
        subAppFailures.push(`sub-app "${svc.name}" missing install command`);
      }
      if (snapshot.hasBuild && !buildFallback) {
        subAppFailures.push(`sub-app "${svc.name}" missing build command`);
      }
      if (snapshot.hasServer && !startFallback) {
        subAppFailures.push(`sub-app "${svc.name}" missing start command`);
      }
    }
    if (subAppFailures.length > 0) {
      return {
        id: "config",
        label: "Service configuration",
        status: "fail",
        message: subAppFailures.join("; "),
      };
    }

    return { id: "config", label: "Service configuration", status: "pass" };
  }

  if (!snapshot.buildImage) missing.push("build image");

  if (snapshot.hasBuild && !snapshot.installCommand) {
    missing.push("install command");
  }

  if (snapshot.hasServer) {
    if (!snapshot.startCommand) missing.push("start command");
    if (!snapshot.port) missing.push("port");
  }

  if (missing.length > 0) {
    return {
      id: "config",
      label: "Build configuration",
      status: "fail",
      message: `Missing required fields: ${missing.join(", ")}`,
    };
  }

  return { id: "config", label: "Build configuration", status: "pass" };
}

function checkStack(snapshot: DeploymentConfigSnapshot): PreflightCheck {
  if (!snapshot.hasServer && snapshot.startCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message:
        "Static site has a start command configured - it will be ignored. Files will be served from the edge.",
    };
  }

  if (snapshot.hasBuild && !snapshot.buildCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message:
        "Build is enabled but no build command configured - deployment will use source files directly.",
    };
  }

  if (!snapshot.hasBuild && snapshot.buildCommand) {
    return {
      id: "stack",
      label: "Stack configuration",
      status: "warn",
      message: "Build is disabled but a build command exists - it will be skipped.",
    };
  }

  return { id: "stack", label: "Stack configuration", status: "pass" };
}

function checkSlugFormat(slug: string): PreflightCheck {
  if (slug.length < 1 || slug.length > 63) {
    return {
      id: "slug",
      label: "Subdomain",
      status: "fail",
      message: `Slug must be between 1 and 63 characters (got ${slug.length}).`,
    };
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return {
      id: "slug",
      label: "Subdomain",
      status: "fail",
      message: `"${slug}" is not a valid subdomain. Use only lowercase letters, numbers, and hyphens. Must start and end with a letter or number.`,
    };
  }

  return { id: "slug", label: "Subdomain", status: "pass" };
}

async function checkSlug(slug: string, cloud: CloudPreflightData | null): Promise<PreflightCheck> {
  const fqdn = `${slug}.${getRoutingBaseDomain()}`;

  if (!cloud) {
    return { id: "slug-available", label: "Subdomain availability", status: "pass" };
  }

  if (!cloud.runtime.ok) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "warn",
      message: "Could not verify subdomain availability",
    };
  }

  if (cloud.slug?.available === false) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "fail",
      message: cloud.slug.message ?? `"${fqdn}" is already taken. Choose a different subdomain.`,
    };
  }

  if (cloud.slug?.message) {
    return {
      id: "slug-available",
      label: "Subdomain availability",
      status: "warn",
      message: cloud.slug.message,
    };
  }

  return { id: "slug-available", label: "Subdomain availability", status: "pass" };
}

const CLOUD_EDGE_CNAME = "edge.openship.io";
const DOMAIN_CHECK_TIMEOUT_MS = 4_000;

/**
 * Cloud route flow — the SaaS preflight result is the source of truth.
 * No local DNS check is needed: the cloud has already resolved the
 * customer-facing CNAME and cert state. Mirrors the verified/pending
 * statuses that the Domains tab shows so the deploy modal stays
 * consistent with the dashboard's verification UI.
 */
function checkCustomDomainCloudVerified(
  customDomain: string,
  cloud: NonNullable<CloudPreflightData["customDomain"]>,
): PreflightCheck {
  if (cloud.verified) {
    if (cloud.message) {
      return { id: "domain", label: "Domain DNS", status: "warn", message: cloud.message };
    }
    return { id: "domain", label: "Domain DNS", status: "pass" };
  }

  // Unverified custom domain on a cloud deploy — deploy proceeds via
  // the free `.opsh.io` slug attached alongside the custom one. The
  // custom domain shows as "pending" on the Domains tab with a Verify
  // button; once DNS resolves, the cloud edge attaches a cert.
  return {
    id: "domain",
    label: "Domain DNS",
    status: "warn",
    message:
      cloud.message ??
      `${customDomain} isn't DNS-verified yet — deploy continues on the free .opsh.io domain; verify the custom domain from the Domains tab to attach it.`,
  };
}

/**
 * Self-hosted route flow — operator points the domain at their own
 * server. We compare resolved A records against the server's IPs so
 * the most common DNS mistakes (typo'd IP, leftover parked-domain
 * placeholder) get flagged before the build pipeline wastes ~60s only
 * to fail at certbot. Both lookups are time-bounded so a black-holed
 * resolver can't stall the preflight modal.
 */
async function checkCustomDomainSelfHosted(
  customDomain: string,
  snapshot?: DeploymentConfigSnapshot,
): Promise<PreflightCheck> {
  // Resolve every record type the deploy might care about. Each
  // lookup is capped individually so one slow query can't drag the
  // preflight past its budget.
  const [a, aaaa, cname] = await Promise.all([
    resolveRecords(customDomain, "A", { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS }),
    resolveRecords(customDomain, "AAAA", { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS }),
    resolveRecords(customDomain, "CNAME", { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS }),
  ]);
  const anyResolved = a.length > 0 || aaaa.length > 0 || cname.length > 0;

  if (!anyResolved) {
    return {
      id: "domain",
      label: "Domain DNS",
      status: "warn",
      message: `No DNS records found yet for ${customDomain}. Point it at your server's IP; the deploy continues on the free .opsh.io domain — TLS issuance for ${customDomain} retries after Verify.`,
    };
  }

  // Resolve the server's IP set. If the configured "host" is a
  // hostname (not an IP literal), look it up too — we can't compare
  // an IP record against a hostname string.
  const serverHost = snapshot?.organizationId
    ? await resolveServerHost(snapshot.organizationId, snapshot.serverId).catch(() => null)
    : null;
  let serverIps: string[] = [];
  if (serverHost) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(serverHost) || serverHost.includes(":")) {
      serverIps = [serverHost];
    } else {
      serverIps = await lookupAddresses(serverHost, { timeoutMs: DOMAIN_CHECK_TIMEOUT_MS });
    }
  }

  // Only enforce the IP comparison when we actually have a server IP
  // to compare against. On local-only setups without one, fall
  // through to the permissive "something resolved" check — the
  // operator owns DNS and we can't second-guess.
  if (serverIps.length > 0 && a.length > 0) {
    const matchesServer = a.some((ip) => serverIps.includes(ip));
    if (!matchesServer) {
      return {
        id: "domain",
        label: "Domain DNS",
        status: "warn",
        message: `${customDomain} resolves to ${a.join(", ")} but the server is at ${serverIps.join(", ")}. Point the A record at the server's IP; cert issuance will fail until DNS matches.`,
      };
    }
  }

  return { id: "domain", label: "Domain DNS", status: "pass" };
}

/**
 * Cloud route fallback — caller is targeting cloud but the SaaS-side
 * preflight didn't return customDomain data. Verify the CNAME points
 * at the cloud edge directly. Non-blocking; the .opsh.io free domain
 * stays attached so the deploy still ships.
 */
async function checkCustomDomainCloudCname(
  customDomain: string,
): Promise<PreflightCheck> {
  const records = await resolveRecords(customDomain, "CNAME", {
    timeoutMs: DOMAIN_CHECK_TIMEOUT_MS,
  });
  if (records.length === 0) {
    return {
      id: "domain",
      label: "Domain DNS",
      status: "warn",
      message: `No CNAME record found for ${customDomain} yet. Add a CNAME pointing to ${CLOUD_EDGE_CNAME}, then click Verify on the Domains tab. Deploy continues on the free .opsh.io domain.`,
    };
  }
  if (records.some((record) => record.toLowerCase() === CLOUD_EDGE_CNAME)) {
    return { id: "domain", label: "Domain DNS", status: "pass" };
  }
  return {
    id: "domain",
    label: "Domain DNS",
    status: "warn",
    message: `CNAME for ${customDomain} doesn't point to ${CLOUD_EDGE_CNAME} yet (current: ${records.join(", ")}). Deploy continues on the free .opsh.io domain; fix DNS and verify from the Domains tab to attach the custom domain.`,
  };
}

/**
 * Domain DNS check dispatcher. Picks the right branch based on the
 * effective deploy target — keeps the body of each branch focused.
 */
async function checkCustomDomain(
  customDomain: string,
  cloud: CloudPreflightData | null,
  snapshot?: DeploymentConfigSnapshot,
): Promise<PreflightCheck> {
  if (cloud?.runtime.ok && cloud.customDomain) {
    return checkCustomDomainCloudVerified(customDomain, cloud.customDomain);
  }
  const plat = platform();
  const isSelfHostedTarget =
    plat.target === "selfhosted" ||
    snapshot?.deployTarget === "server" ||
    snapshot?.deployTarget === "local";
  if (isSelfHostedTarget) {
    return checkCustomDomainSelfHosted(customDomain, snapshot);
  }
  return checkCustomDomainCloudCname(customDomain);
}

async function checkCloudRuntime(
  cloud: CloudPreflightData | null,
  requirement: "none" | "cloud-runtime" | "managed-project-domain" | "managed-compose-domains",
): Promise<PreflightCheck> {
  if (requirement === "none") {
    return { id: "runtime", label: "Runtime", status: "pass" };
  }

  if (!cloud) {
    if (requirement === "managed-project-domain") {
      return {
        id: "runtime",
        label: "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_PROJECT_DOMAIN,
        message: `Free .${getRoutingBaseDomain()} domains require Openship Cloud for routing. To deploy to your own server, either connect Openship Cloud or switch this project to a custom domain.`,
      };
    }

    if (requirement === "managed-compose-domains") {
      return {
        id: "runtime",
        label: "Free domain routing",
        status: "fail",
        code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_MANAGED_COMPOSE_DOMAINS,
        message: `One or more exposed services use free .${getRoutingBaseDomain()} domains. Connect Openship Cloud or switch those services to custom domains before deploying to your own server.`,
      };
    }

    return {
      id: "runtime",
      label: "Openship Cloud",
      status: "fail",
      code: PREFLIGHT_ERROR_CODES.CLOUD_REQUIRED_TARGET,
      message:
        "This deployment target runs on Openship Cloud, but no cloud account is connected. Connect your account first.",
    };
  }

  if (cloud.runtime.ok) {
    return {
      id: "runtime",
      label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
      status: "pass",
    };
  }

  return {
    id: "runtime",
    label: requirement === "cloud-runtime" ? "Openship Cloud" : "Free domain routing",
    status: "fail",
    message: cloud.runtime.message,
  };
}

export async function runPreflightChecks(
  snapshot: DeploymentConfigSnapshot,
  opts?: PreflightOptions,
): Promise<PreflightResult> {
  const cloudPreflight = await resolveCloudPreflight(snapshot, opts);

  // Determine whether this deployment requires cloud directly or via managed routing
  const plat = platform();
  const effectiveTarget =
    plat.target === "desktop" ? (snapshot.deployTarget ?? "cloud") : plat.target;
  // Keep in sync with deployment-runtime.ts:usesManagedRouting — same
  // calculation, same outcome. See note inside resolveCloudPreflight.
  const usesManagedRouting =
    plat.target === "selfhosted" ||
    (plat.target === "desktop" && (effectiveTarget === "server" || effectiveTarget === "local"));
  const hasEndpointRouting = !!opts?.publicEndpoints?.length;
  const hasManagedProjectDomain =
    !hasEndpointRouting && !!opts?.slug && !opts?.customDomain && usesManagedRouting;
  const hasManagedPublicEndpoints =
    opts?.publicEndpoints?.some((endpoint) => endpoint.domainType !== "custom") ?? false;
  const hasManagedComposeDomains =
    opts?.composeServices?.some((service) => service.exposed && service.domainType !== "custom") ??
    false;
  const cloudRequirement =
    effectiveTarget === "cloud"
      ? "cloud-runtime"
      : hasManagedProjectDomain || hasManagedPublicEndpoints
        ? "managed-project-domain"
        : hasManagedComposeDomains
          ? "managed-compose-domains"
          : "none";

  const checks: PreflightCheck[] = [
    checkConfig(snapshot, opts),
    opts?.multiService
      ? { id: "stack", label: "Service stack", status: "pass" }
      : checkStack(snapshot),
  ];

  if (!hasEndpointRouting && opts?.slug && !opts?.customDomain) {
    checks.push(checkSlugFormat(opts.slug));
    checks.push(await checkSlug(opts.slug, cloudPreflight));
  }

  checks.push(await checkCloudRuntime(cloudPreflight, cloudRequirement));

  // GitHub App installation check - fires whenever the API is running in
  // App auth mode (SaaS), regardless of deploy target. The App installation
  // token is the only credential we're willing to ship downstream for
  // self-hosted deploys originating from a SaaS API - see resolveBuildGitToken
  // in build.service.ts. Catching it here surfaces a clear "install the App
  // on <owner>" error instead of a 403 deep in the build pipeline.
  if (getGitHubAuthMode() === "app") {
    checks.push(
      await checkGitHubAppInstallation(opts?.userId, opts?.gitOwner, opts?.organizationId),
    );
  }

  // Remote-build credential check. For App-scoped modes (app / cloud-app)
  // and local builds: pass. For cli mode + remote: hard FAIL (matches the
  // backend's clone-auth refusal). For oauth/token + remote: warn only.
  checks.push(
    await checkRemoteBuildTokenLeak(
      opts?.userId,
      effectiveTarget,
      opts?.buildStrategy ?? (snapshot.buildStrategy as "local" | "server" | undefined),
    ),
  );

  // Atomic remote-clone-token check — the single source of truth for
  // "can this deploy actually mint a token to clone the repo on the
  // build worker?". Mirrors clone-auth.ts at deploy time so any failure
  // here means the deploy would have failed downstream.
  checks.push(
    await checkRemoteCloneToken(
      opts?.userId,
      opts?.gitOwner,
      opts?.projectId,
      effectiveTarget,
      opts?.buildStrategy ?? (snapshot.buildStrategy as "local" | "server" | undefined),
      opts?.organizationId,
    ),
  );

  if (!hasEndpointRouting && opts?.customDomain) {
    checks.push(await checkCustomDomain(opts.customDomain, cloudPreflight, snapshot));
  }

  if (opts?.composeServices?.length) {
    checks.push(
      ...(await checkComposeServiceDomains(opts.composeServices, opts.slug, cloudPreflight, snapshot)),
    );
  }

  if (opts?.publicEndpoints?.length) {
    checks.push(...(await checkPublicEndpoints(snapshot, opts.publicEndpoints, cloudPreflight, opts.userId)));
  }

  // Catch the "this deploy will have no public URL" foot-gun: self-hosted,
  // no cloud requirement (so no managed slug routing), no custom domain,
  // no public endpoints, no compose services exposed. buildProjectRouteDomains
  // returns [] for this shape, registerResolvedRoutes logs
  // "No domains configured" and exits, the container runs but the dashboard's
  // "Open" button is empty. Surface this BEFORE the build kicks off so the
  // operator can attach a domain or connect cloud first.
  const hasAnyCustomDomain = !!opts?.customDomain;
  const hasAnyEndpointDomain = (opts?.publicEndpoints ?? []).some(
    (endpoint) => !!endpoint.domain || !!endpoint.customDomain,
  );
  const hasAnyComposeExposed = (opts?.composeServices ?? []).some(
    (service) => service.exposed,
  );
  const willHavePublicUrl =
    effectiveTarget === "cloud" ||
    cloudRequirement !== "none" ||
    hasAnyCustomDomain ||
    hasAnyEndpointDomain ||
    hasAnyComposeExposed;
  if (!willHavePublicUrl) {
    checks.push({
      id: "public-url",
      label: "Public URL",
      status: "warn",
      message:
        "This deploy has no public domain attached. It will build and start but nothing will route to it. Add a custom domain on the Domains tab or connect Openship Cloud to get a free .opsh.io subdomain.",
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}
