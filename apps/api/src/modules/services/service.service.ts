/**
 * Service business logic - CRUD and compose sync.
 */

import { normalizeRoutingFields, repos } from "@repo/db";
import type { LogEntry } from "@repo/adapters";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertResourceInOrg, platform } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { buildServiceRouteDomain, getRoutingBaseDomain } from "../../lib/routing-domains";
import type {
  TCreateServiceBody,
  TUpdateServiceBody,
  TSetServiceEnvVarsBody,
} from "./service.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Verify a service exists and belongs to a project in the given org */
async function assertServiceAccess(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  const svc = await repos.service.findById(serviceId);
  if (!svc || svc.projectId !== projectId) {
    throw new Error("service-not-found");
  }
  return { project, svc };
}

const trimOrNull = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed || null;
};

/**
 * Patch-level wrapper around the canonical `normalizeRoutingFields` from
 * @repo/db. Same body - narrows `domainType` to the literal union the
 * service layer expects. Keeps a single source of truth: the DB repo
 * owns the trim/null/clear semantics, this layer just types them.
 */
function normalizeRoutingPatch(input: Parameters<typeof normalizeRoutingFields>[0]): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: "free" | "custom";
} {
  const r = normalizeRoutingFields(input);
  return {
    ...r,
    domainType: r.domainType === "custom" ? "custom" : "free",
  };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listServices(projectId: string, organizationId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  return repos.service.listByProject(projectId);
}

export async function getService(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const { svc } = await assertServiceAccess(projectId, serviceId, organizationId);
  return svc;
}

// ─── Create / Update ─────────────────────────────────────────────────────────

export async function createService(
  projectId: string,
  organizationId: string,
  data: TCreateServiceBody,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);

  const name = data.name.trim();
  if (!name) {
    throw new Error("service-name-required");
  }

  const existing = await repos.service.findByName(projectId, name);
  if (existing) {
    throw new Error("service-name-already-exists");
  }

  // Discriminator default: compose. Matches the DB column default.
  const kind: "compose" | "monorepo" = data.kind === "monorepo" ? "monorepo" : "compose";

  // Monorepo sub-apps MUST carry a rootDirectory - the validator keeps it
  // optional because the DB column is nullable (compose rows have null
  // monorepo fields), but a kind="monorepo" row with no rootDirectory
  // would silently fall back to repo root at build time. Catch it here
  // instead of letting the build engine pick an empty path.
  if (kind === "monorepo" && !data.rootDirectory?.trim()) {
    throw new Error("monorepo-service-requires-rootDirectory");
  }

  const services = await repos.service.listByProject(projectId);
  // Monorepo sub-apps auto-expose with a free subdomain by default - same
  // behaviour the project-import flow uses (project-crud.service.ts's
  // persistMonorepoApps defaults `exposed: true`, `domainType: "free"`).
  // Without this, sub-apps added later via the Services tab would default
  // to internal-only and the operator would have to flip both toggles
  // manually before the first deploy. Compose services keep the existing
  // `exposed: false` default because most compose rows (databases,
  // caches, queues) genuinely shouldn't be public.
  const monorepoDefaults = kind === "monorepo";
  const routing = normalizeRoutingPatch({
    exposed: data.exposed ?? monorepoDefaults,
    exposedPort: data.exposedPort,
    domain: data.domain,
    customDomain: data.customDomain,
    domainType: data.domainType ?? (monorepoDefaults ? "free" : undefined),
  });

  return repos.service.create({
    projectId,
    name,
    kind,
    image: trimOrNull(data.image),
    build: trimOrNull(data.build),
    dockerfile: trimOrNull(data.dockerfile),
    ports: data.ports ?? [],
    dependsOn: data.dependsOn ?? [],
    environment: data.environment ?? {},
    volumes: data.volumes ?? [],
    command: trimOrNull(data.command),
    restart: data.restart ?? "unless-stopped",
    ...routing,
    enabled: data.enabled ?? true,
    sortOrder: data.sortOrder ?? services.length,
    // Monorepo sub-app fields - null for compose rows (the schema invariant).
    rootDirectory: kind === "monorepo" ? trimOrNull(data.rootDirectory) : null,
    installCommand: kind === "monorepo" ? trimOrNull(data.installCommand) : null,
    buildCommand: kind === "monorepo" ? trimOrNull(data.buildCommand) : null,
    startCommand: kind === "monorepo" ? trimOrNull(data.startCommand) : null,
    outputDirectory: kind === "monorepo" ? trimOrNull(data.outputDirectory) : null,
    framework: kind === "monorepo" ? trimOrNull(data.framework) : null,
    packageManager: kind === "monorepo" ? trimOrNull(data.packageManager) : null,
    buildImage: kind === "monorepo" ? trimOrNull(data.buildImage) : null,
  });
}

export async function updateService(
  projectId: string,
  serviceId: string,
  organizationId: string,
  data: TUpdateServiceBody,
) {
  const { project, svc } = await assertServiceAccess(projectId, serviceId, organizationId);

  // Normalize routing: when exposed is turned off, clear routing fields.
  // When domainType changes, clear the irrelevant domain field.
  const patch: Record<string, any> = { ...data };

  if ("name" in patch && typeof patch.name === "string") {
    const name = patch.name.trim();
    if (!name) {
      throw new Error("service-name-required");
    }

    if (name !== svc.name) {
      const existing = await repos.service.findByName(projectId, name);
      if (existing && existing.id !== serviceId) {
        throw new Error("service-name-already-exists");
      }
    }

    patch.name = name;
  }

  for (const key of ["image", "build", "dockerfile", "command"] as const) {
    if (key in patch) {
      patch[key] = trimOrNull(patch[key]);
    }
  }
  // Monorepo sub-app build settings: same trim-or-null treatment so empty
  // strings become null in DB (matches the rest of the service columns).
  for (const key of [
    "rootDirectory",
    "installCommand",
    "buildCommand",
    "startCommand",
    "outputDirectory",
    "framework",
    "packageManager",
    "buildImage",
  ] as const) {
    if (key in patch) {
      patch[key] = trimOrNull(patch[key]);
    }
  }

  const touchesRouting = ["exposed", "exposedPort", "domain", "customDomain", "domainType"].some(
    (key) => key in patch,
  );
  const nameChanged = typeof patch.name === "string" && patch.name !== svc.name;

  if (touchesRouting) {
    const normalized = normalizeRoutingPatch({
      exposed: patch.exposed ?? svc.exposed,
      exposedPort: patch.exposedPort ?? svc.exposedPort,
      domain: patch.domain ?? svc.domain,
      customDomain: patch.customDomain ?? svc.customDomain,
      domainType: patch.domainType ?? svc.domainType,
    });

    patch.exposed = normalized.exposed;
    patch.exposedPort = normalized.exposedPort ?? undefined;
    patch.domain = normalized.domain ?? undefined;
    patch.customDomain = normalized.customDomain ?? undefined;
    patch.domainType = normalized.domainType;
  }

  await repos.service.update(serviceId, patch);
  const updated = await repos.service.findById(serviceId);

  // ── Route management ─────────────────────────────────────────
  // Keep live routes aligned when enable/expose/domain/port/name changes.
  const enabledChanged = typeof data.enabled === "boolean" && data.enabled !== svc.enabled;
  const exposedChanged = touchesRouting && patch.exposed !== svc.exposed;

  if (updated && (enabledChanged || exposedChanged || touchesRouting || nameChanged)) {
    try {
      const { routing, runtime } = platform();
      const runtimeName = runtime.name;
      const wasRoutable = svc.enabled && svc.exposed;
      // `enabled` / `exposed` are non-nullable DB columns - no need to
      // fall back to `svc.*` on the updated row.
      const isRoutable = updated.enabled && updated.exposed;
      const oldRoute = buildServiceRouteDomain({
        project,
        service: svc,
        runtimeName,
        usesManagedRouting: true,
      });
      const nextRoute = buildServiceRouteDomain({
        project,
        service: updated,
        runtimeName,
        usesManagedRouting: true,
      });
      const oldHostname = oldRoute?.hostname.toLowerCase();
      const nextHostname = nextRoute?.hostname.toLowerCase();

      if (wasRoutable && (!isRoutable || oldHostname !== nextHostname)) {
        if (oldRoute) {
          await routing.removeRoute(oldRoute.hostname);
        }
      }

      if (isRoutable && nextRoute && project.activeDeploymentId) {
        const rows = await repos.service.listByDeployment(project.activeDeploymentId);
        const row = rows.find((r) => r.serviceId === serviceId);
        if (row?.ip) {
          const port = updated.exposedPort || row.hostPort?.toString() || "80";
          await routing.registerRoute({
            domain: nextRoute.hostname,
            tls: true,
            targetUrl: `http://${row.ip}:${port}`,
          });
        }
      }
    } catch (err) {
      console.error(`[SERVICE] Failed to update route for ${svc.name}:`, err);
    }
  }

  return updated;
}

export async function deleteService(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const { project, svc } = await assertServiceAccess(projectId, serviceId, organizationId);

  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const serviceDeployments = await repos.service.listByDeployment(project.activeDeploymentId);
    const serviceDeployment = serviceDeployments.find((row) => row.serviceId === serviceId);

    if (dep && serviceDeployment?.containerId) {
      const { runtime } = await resolveDeploymentRuntime(dep);
      await runtime.destroy(serviceDeployment.containerId).catch((err) => {
        console.error(
          `[SERVICE] Failed to destroy service container ${serviceDeployment.containerId}:`,
          err,
        );
      });
    }
  }

  if (svc.exposed) {
    try {
      const { routing, runtime } = platform();
      const route = buildServiceRouteDomain({
        project,
        service: svc,
        runtimeName: runtime.name,
        usesManagedRouting: true,
      });
      if (route) {
        await routing.removeRoute(route.hostname);
      }
    } catch (err) {
      console.error(`[SERVICE] Failed to remove route for ${svc.name}:`, err);
    }
  }

  await repos.service.remove(serviceId);
}

// ─── Service Environment Variables ───────────────────────────────────────────

export async function listServiceEnvVars(
  projectId: string,
  serviceId: string,
  organizationId: string,
  environment?: string,
) {
  await assertServiceAccess(projectId, serviceId, organizationId);

  const vars = await repos.project.listEnvVars(projectId, environment, serviceId);
  // Decrypt and mask secrets
  return vars.map((v) => ({
    ...v,
    value: v.isSecret ? "••••••••" : decrypt(v.value),
  }));
}

export async function setServiceEnvVars(
  projectId: string,
  serviceId: string,
  organizationId: string,
  data: TSetServiceEnvVarsBody,
) {
  await assertServiceAccess(projectId, serviceId, organizationId);

  // Encrypt values before storage
  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted, serviceId);
  return { count: encrypted.length };
}

// ─── Compose Sync ────────────────────────────────────────────────────────────

export async function syncComposeServices(
  projectId: string,
  organizationId: string,
  parsed: {
    name: string;
    image?: string;
    build?: string;
    dockerfile?: string;
    ports?: string[];
    dependsOn?: string[];
    environment?: Record<string, string>;
    volumes?: string[];
    command?: string;
    restart?: string;
    exposed?: boolean;
    exposedPort?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }[],
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  return repos.service.syncFromCompose(projectId, parsed);
}

// ─── Service Deployments (per-deployment state) ──────────────────────────────

export async function listServiceDeployments(deploymentId: string) {
  return repos.service.listByDeployment(deploymentId);
}

export async function getActiveServiceContainers(projectId: string, organizationId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  if (!project.activeDeploymentId) return [];
  return repos.service.listByDeployment(project.activeDeploymentId);
}

// ─── Per-service container actions ───────────────────────────────────────────

async function resolveServiceContainer(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  if (!project.activeDeploymentId) throw new Error("No active deployment");

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) throw new Error("Active deployment not found");

  const rows = await repos.service.listByDeployment(dep.id);
  const row = rows.find((r) => r.serviceId === serviceId);
  if (!row?.containerId) throw new Error("Service has no running container");

  const { runtime, serverId } = await resolveDeploymentRuntime(dep);
  return { runtime, containerId: row.containerId, serverId };
}

export async function startServiceContainer(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const { runtime, containerId } = await resolveServiceContainer(
    projectId,
    serviceId,
    organizationId,
  );
  await runtime.start(containerId);
  return { containerId };
}

export async function stopServiceContainer(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const { runtime, containerId } = await resolveServiceContainer(
    projectId,
    serviceId,
    organizationId,
  );
  await runtime.stop(containerId);
  return { containerId };
}

export async function restartServiceContainer(
  projectId: string,
  serviceId: string,
  organizationId: string,
) {
  const { runtime, containerId } = await resolveServiceContainer(
    projectId,
    serviceId,
    organizationId,
  );
  await runtime.restart(containerId);
  return { containerId };
}

export async function getServiceRuntimeLogs(
  projectId: string,
  serviceId: string,
  organizationId: string,
  tail?: number,
) {
  const { runtime, containerId } = await resolveServiceContainer(
    projectId,
    serviceId,
    organizationId,
  );
  return runtime.getRuntimeLogs(containerId, tail);
}

export async function streamServiceRuntimeLogs(
  projectId: string,
  serviceId: string,
  organizationId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const { runtime, containerId, serverId } = await resolveServiceContainer(
    projectId,
    serviceId,
    organizationId,
  );
  const cleanup = await runtime.streamRuntimeLogs(containerId, onLog, opts);
  return { cleanup, serverId };
}

