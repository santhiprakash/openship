import { repos, type Domain, type Project, type Service } from "@repo/db";
import type { RoutedDomainInput, SslProvider, SslResult } from "@repo/adapters";
import { SYSTEM, ConflictError, resolveServiceHostnameLabel, normalizeCustomHostname } from "@repo/core";
import { env } from "../config/env";
import { serviceKind } from "./deployable-service";
import { resolveServicePublicEndpoints } from "./public-endpoints";
import { resolveSslPatch } from "./domain-ssl";
import { generateToken } from "./domain-token";

export interface PlannedRouteDomain {
  hostname: string;
  tls: boolean;
  provisionSsl: boolean;
  isCloud: boolean;
  targetPort?: number;
  targetPath?: string;
  domainType?: "free" | "custom";
  managedSubdomain?: string;
  serviceId?: string;
  isPrimary?: boolean;
  createIfMissing?: boolean;
  verified?: boolean;
}

export function getRoutingBaseDomain(): string {
  return env.HOST_DOMAIN || SYSTEM.DOMAINS.CLOUD_DOMAIN;
}

/**
 * Self-hosted runtimes whose custom-domain routes are fronted by OpenResty
 * and need a certbot-issued cert (the NginxProvider SSL path). Both `bare`
 * and `docker` self-hosted deploys go through the SAME OpenResty + certbot
 * provider (see platform.ts → createInfraProvider, which returns NginxProvider
 * regardless of runtime mode). `cloud` uses managed SSL; `desktop` (bare +
 * noop infra) has no real SSL provider. Historically this was gated to `bare`
 * only, which silently skipped SSL for every Docker deployment — a custom
 * domain on a Docker app would stay on HTTP forever.
 */
function usesCertbotSsl(runtimeName: string): boolean {
  return runtimeName === "bare" || runtimeName === "docker";
}

export function resolveManagedHostname(hostname: string): { isManaged: boolean; subdomain?: string } {
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${baseDomain}`;

  if (!normalized.endsWith(suffix)) {
    return { isManaged: false };
  }

  const subdomain = normalized.slice(0, -suffix.length);
  return {
    isManaged: subdomain.length > 0,
    subdomain: subdomain || undefined,
  };
}

export function buildProjectRouteDomains(opts: {
  project: Project;
  projectDomains: Domain[];
  managedSlug?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain[] {
  const { projectDomains, managedSlug, publicEndpoints, runtimeName, usesManagedRouting } = opts;
  const baseDomain = getRoutingBaseDomain();
  const seen = new Set<string>();
  const planned: PlannedRouteDomain[] = [];
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );

  // Push a single planned route. A route MUST target exactly one
  // destination (port or path) — calls without one are silently ignored.
  // SSL is provisioned only for DNS-verified custom domains on the bare
  // runtime: free managed (*.opsh.io) routes skip certbot (we own that
  // DNS), and a pending custom domain gets an HTTP-only route until
  // /verify issues its cert (see domain.service.ts → verifyDomain). When
  // isPrimary is omitted, the first route added wins.
  const add = (
    hostname: string,
    route: {
      domainType: "free" | "custom";
      destination?: { targetPort?: number; targetPath?: string };
      skipSsl?: boolean;
      isPrimary?: boolean;
      verified?: boolean;
    },
  ) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    if (!route.destination?.targetPath && route.destination?.targetPort === undefined) return;
    seen.add(normalized);

    const managed = resolveManagedHostname(normalized);
    const domainRow = domainByHostname.get(normalized);
    const isVerified = managed.isManaged
      ? true
      : route.verified ?? domainRow?.verified ?? false;
    // Externally-managed ingress (Cloudflare Tunnel / LB): TLS terminates
    // upstream and DNS points at the user's edge, so serve a plain-HTTP route
    // (tls:false) and never run certbot for this host.
    const external = !!domainRow?.externalIngress;
    // Operator-supplied cert (BYO / Cloudflare Full-strict): serve TLS from the
    // uploaded cert and never run certbot, even behind an external edge.
    const manualSsl = !!domainRow?.manualSsl;

    planned.push({
      hostname: normalized,
      tls: !external || manualSsl,
      provisionSsl:
        usesCertbotSsl(runtimeName) && !managed.isManaged && !route.skipSsl && !external && !manualSsl && isVerified,
      isCloud: managed.isManaged,
      ...(route.destination?.targetPort !== undefined
        ? { targetPort: route.destination.targetPort }
        : {}),
      ...(route.destination?.targetPath ? { targetPath: route.destination.targetPath } : {}),
      domainType: route.domainType,
      managedSubdomain: managed.subdomain,
      isPrimary: route.isPrimary ?? planned.length === 0,
      createIfMissing: true,
      verified: isVerified,
    });
  };

  if (publicEndpoints?.length) {
    for (const [index, endpoint] of publicEndpoints.entries()) {
      const destination = endpoint.targetPath
        ? { targetPath: endpoint.targetPath }
        : endpoint.port !== undefined
          ? { targetPort: endpoint.port }
          : undefined;

      if (!destination) {
        continue;
      }

      // Attach EITHER the operator's custom domain OR a free
      // <slug>.opsh.io fallback — never both. The free managed URL is
      // served by Openship Cloud's edge (runPostDeploySync →
      // ensureManagedEdgeProxy), so a self-hosted box can't serve it
      // alone; once the operator points their own domain at the box, that
      // domain is the deploy URL and a free slug they never asked for is
      // just an unservable route plus a failing edge sync. Same rule as
      // preflight.ts. The chosen route is primary for the first endpoint
      // (deploy URL, analytics, etc.).
      if (endpoint.domainType === "custom" && endpoint.customDomain) {
        add(endpoint.customDomain, { domainType: "custom", destination, isPrimary: index === 0 });
        continue;
      }

      const routeSlug = endpoint.domain || managedSlug;
      if (routeSlug && usesManagedRouting) {
        add(`${routeSlug}.${baseDomain}`, {
          domainType: "free",
          destination,
          skipSsl: true,
          isPrimary: index === 0,
        });
      }
    }

    return planned;
  }

  // No public endpoints: route the project's own domain rows directly. A
  // domain only routes if its row carries a destination (port or path) —
  // add() ignores the rest. Pending custom domains still get an HTTP-only
  // route so certbot --webroot can answer the ACME challenge; add() gates
  // SSL on domain.verified.
  for (const domain of projectDomains) {
    if (domain.serviceId) continue;
    if (domain.domainType === "free" && !domain.verified) continue;
    add(domain.hostname, {
      domainType: domain.domainType === "free" ? "free" : "custom",
      skipSsl: domain.domainType === "free",
      destination: domain.targetPath
        ? { targetPath: domain.targetPath }
        : domain.targetPort !== null && domain.targetPort !== undefined
          ? { targetPort: domain.targetPort }
          : undefined,
      isPrimary: domain.isPrimary,
      verified: domain.verified,
    });
  }

  return planned;
}

export function buildServiceRouteDomains(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
  /** The project's domain rows keyed by hostname. Drives per-host SSL gating —
   *  same as the single-app path in add(): an external-ingress row serves plain
   *  HTTP (tls:false, no certbot), a manual-SSL row serves the uploaded cert,
   *  and certbot provisioning only fires for a VERIFIED custom domain. Omit on
   *  the edit/delete reconcile path, which registers routes but provisions no
   *  SSL — the SSL step runs on the deploy path, which always supplies it. */
  domainByHostname?: Map<string, Domain>;
}): PlannedRouteDomain[] {
  const { project, service, runtimeName, usesManagedRouting } = opts;
  if (!service.exposed) return [];

  // One route per public endpoint (a multi-port service — e.g. Convex's API
  // 3210 + HTTP actions 3211 — gets one hostname each). Falls back to the
  // single primary route synthesized from the scalar columns for pre-migration
  // / single-route services. See resolveServicePublicEndpoints.
  const endpoints = resolveServicePublicEndpoints(service);
  const planned: PlannedRouteDomain[] = [];
  const seen = new Set<string>();

  for (const endpoint of endpoints) {
    if (endpoint.port === undefined) continue;

    // Monorepo sub-apps always get a namespaced hostname (`<project>-<app>`).
    // Compose services keep the "frontend"/"web"/"app" → bare-project-label
    // shortcut (see defaultServiceHostnameLabel). Each endpoint's own free slug
    // overrides that default, so secondary ports get distinct hostnames.
    const hostname = endpoint.domainType === "custom"
      ? (endpoint.customDomain ? normalizeCustomHostname(endpoint.customDomain) : null)
      : usesManagedRouting
        ? `${resolveServiceHostnameLabel(project.slug ?? project.name, service.name, endpoint.domain, serviceKind(service))}.${getRoutingBaseDomain()}`
        : null;

    if (!hostname) continue;
    const normalized = hostname.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const managed = resolveManagedHostname(hostname);
    const domainRow = opts.domainByHostname?.get(normalized);
    const external = !!domainRow?.externalIngress;
    const manualSsl = !!domainRow?.manualSsl;
    // Only certbot a custom domain that has passed DNS verification — mirrors
    // the single-app add() gate. A managed (free) host needs no challenge; a
    // still-pending custom host would only burn a Let's Encrypt failed attempt.
    // When the domain map isn't supplied (edit/delete reconcile, which doesn't
    // provision SSL), this stays false and no cert work is attempted.
    const isVerified = managed.isManaged ? true : (domainRow?.verified ?? false);
    planned.push({
      hostname,
      tls: !external || manualSsl,
      provisionSsl:
        usesCertbotSsl(runtimeName) && endpoint.domainType === "custom" && !external && !manualSsl && isVerified,
      isCloud: managed.isManaged,
      targetPort: endpoint.port,
      domainType: endpoint.domainType,
      managedSubdomain: managed.subdomain,
      serviceId: service.id,
      isPrimary: false,
      createIfMissing: true,
    });
  }

  return planned;
}

/**
 * The custom hostnames a service CONFIGURES, independent of enabled/exposed.
 * Drives the derived domain-row lifecycle: a row is orphaned only when its
 * hostname leaves the service's config (cleared / renamed / switched to free),
 * NOT when routing is merely paused by unexposing — so a verified domain
 * survives an expose toggle. Lowercased + de-duped.
 */
export function serviceCustomHostnames(service: Service): string[] {
  const hosts = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    const hostname = normalizeCustomHostname(raw);
    if (hostname) hosts.add(hostname);
  };
  // Read the raw config, NOT resolveServicePublicEndpoints — that gates on
  // `exposed` (returns [] when paused), which would make an unexpose look like
  // a de-configuration and wrongly orphan the row. Multi-route config wins when
  // present; otherwise the scalar columns.
  if (service.publicEndpoints && service.publicEndpoints.length > 0) {
    for (const endpoint of service.publicEndpoints) {
      if (endpoint.domainType === "custom") add(endpoint.customDomain);
    }
  } else if (service.domainType === "custom") {
    add(service.customDomain);
  }
  return [...hosts];
}

/**
 * Back-compat single-route accessor: the service's PRIMARY public route (or
 * null). Callers that only touch the primary domain keep using this; the deploy
 * loop and edit reconcile use buildServiceRouteDomains for the full set.
 */
export function buildServiceRouteDomain(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
  domainByHostname?: Map<string, Domain>;
}): PlannedRouteDomain | null {
  return buildServiceRouteDomains(opts)[0] ?? null;
}

export function createTrackedSslProvider(
  ssl: SslProvider,
  domainByHostname: Map<string, Domain>,
): SslProvider {
  // Persist via the shared no-clobber resolver: a verified cert → "active"; a
  // genuinely missing cert → "provisioning"; a transient read failure leaves the
  // row alone (so a redeploy that can't momentarily read an existing cert can't
  // downgrade a live "active" → "provisioning"). Same rule the on-demand path uses.
  const persist = async (hostname: string, result: SslResult) => {
    const domainRecord = domainByHostname.get(hostname.toLowerCase());
    if (domainRecord) {
      const patch = resolveSslPatch(domainRecord.sslStatus, result);
      if (patch) await repos.domain.updateSsl(domainRecord.id, patch);
    }
    return result;
  };

  return {
    provisionCert: async (hostname: string) => persist(hostname, await ssl.provisionCert(hostname)),
    renewCert: async (hostname: string) => persist(hostname, await ssl.renewCert(hostname)),
    verifyCert: async (hostname: string) => persist(hostname, await ssl.verifyCert(hostname)),
    installCert: async (hostname, cert) => persist(hostname, await ssl.installCert(hostname, cert)),
  };
}

export async function ensureRouteDomainRecord(opts: {
  projectId: string;
  route: PlannedRouteDomain;
  domainByHostname: Map<string, Domain>;
}): Promise<Domain | null> {
  const { projectId, route, domainByHostname } = opts;
  const key = route.hostname.toLowerCase();

  // Cross-project hijack guard. A hostname is globally unique and owned by ONE
  // project. The service EDIT path already refuses a foreign hostname
  // (ensurePendingServiceDomain), but the DEPLOY path minted/overwrote routes via
  // findOrCreate's global lookup — which returned another project's row unchanged,
  // letting project B overwrite project A's vhost (and serve A's domain on A's
  // cert). Refuse loudly here, before any patch or create, so neither the update
  // nor the create path can claim a hostname this project doesn't own.
  const owner = await repos.domain.findByHostname(route.hostname);
  if (owner && owner.projectId !== projectId) {
    throw new ConflictError(
      `Hostname ${route.hostname} is routed by another project and cannot be claimed here.`,
    );
  }

  const existing = domainByHostname.get(key);
  // Primary (DB isPrimary) is owned by explicit setPrimary — the deploy must not
  // re-derive it from endpoint order; only a new domain may claim it, when none exists.
  const hasExistingPrimary = [...domainByHostname.values()].some((d) => d.isPrimary);
  if (existing) {
    const patch: Record<string, unknown> = {};
    const expectedDomainType = route.domainType ?? null;
    const expectedTargetPort = route.targetPort ?? null;
    const expectedTargetPath = route.targetPath ?? null;
    const expectedServiceId = route.serviceId ?? null;

    if ((existing.domainType ?? null) !== expectedDomainType) patch.domainType = expectedDomainType;
    if ((existing.targetPort ?? null) !== expectedTargetPort) patch.targetPort = expectedTargetPort;
    if ((existing.targetPath ?? null) !== expectedTargetPath) patch.targetPath = expectedTargetPath;
    if ((existing.serviceId ?? null) !== expectedServiceId) patch.serviceId = expectedServiceId;
    // isPrimary intentionally NOT patched — preserve the user's stored selection.
    // Custom domains must pass the DNS challenge — the deploy must NOT force
    // them verified/active (that's the bug that left service routes stuck with
    // no Verify option). Only host-managed (free / *.opsh.io) routes, which
    // need no challenge, auto-activate here.
    const isCustom = expectedDomainType === "custom";
    if (!isCustom) {
      if (!existing.verified) {
        patch.verified = true;
        patch.verifiedAt = new Date();
      }
      if (existing.status !== "active") patch.status = "active";
    }

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      const updated = { ...existing, ...patch } as Domain;
      domainByHostname.set(key, updated);
      return updated;
    }

    return existing;
  }

  if (!route.createIfMissing) {
    return null;
  }

  // A custom domain minted at deploy time (no prior add) starts PENDING with a
  // challenge token so the Verify pipe can run; host-managed routes go active.
  const isNewCustom = route.domainType === "custom";
  const created = await repos.domain.findOrCreate({
    projectId,
    serviceId: route.serviceId,
    hostname: route.hostname,
    targetPort: route.targetPort,
    targetPath: route.targetPath,
    domainType: route.domainType,
    isPrimary: hasExistingPrimary
      ? false
      : (route.isPrimary ?? (!route.serviceId && domainByHostname.size === 0)),
    status: isNewCustom ? "pending" : "active",
    verified: !isNewCustom,
    verifiedAt: isNewCustom ? null : new Date(),
    verificationToken: isNewCustom ? generateToken(route.hostname) : undefined,
  });
  domainByHostname.set(key, created);
  return created;
}

export function toRoutedDomainInputs(domains: PlannedRouteDomain[]): RoutedDomainInput[] {
  return domains.map((domain) => ({
    hostname: domain.hostname,
    tls: domain.tls,
    provisionSsl: domain.provisionSsl,
    targetPort: domain.targetPort,
    targetPath: domain.targetPath,
  }));
}
