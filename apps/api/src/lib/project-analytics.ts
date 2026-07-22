/**
 * Shared helpers for resolving a project's tracked domain, server,
 * and querying the OpenResty management API.
 *
 * The actual HTTP-over-SSH-tunnel logic lives in `./ssh-tunnel.ts`.
 * This file provides the OpenResty-specific convenience wrappers and
 * project → domain + server resolution.
 *
 * Used by:
 *   - analytics.service.ts  (summary, periods)
 *   - project.controller.ts (server log stream, recent logs)
 *   - analytics-scraper.ts  (periodic scrape via SSH)
 */

import { repos, type Project } from "@repo/db";
import { OPENRESTY_MGMT_PORT } from "@repo/adapters";
import { tunnelRequest, tunnelStream } from "./ssh-tunnel";
import { isOblienBackedDeployment } from "./platform-mode";

export type { TunnelStreamHandle } from "./ssh-tunnel";

// ─── Domain normalisation ────────────────────────────────────────────────────

/**
 * Normalize a hostname to match OpenResty's tracking key format.
 * Lua `site_logger.lua` stores counters under lowercase, no-www keys.
 */
export function normalizeTrackedDomain(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

// ─── Project → domain + server resolution ────────────────────────────────────

export interface ProjectTracking {
  domain: string;
  serverId: string;
}

export type ProjectTrafficSource =
  | {
      kind: "self-hosted";
      domain: string;
      serverId: string;
      deployTarget: string | null;
    }
  | {
      kind: "cloud";
      domain: string;
      deployTarget: "cloud";
    };

async function resolveTrafficRuntime(project: Project) {
  let deployTarget: string | null = null;
  let serverId: string | null = null;

  if (project.activeDeploymentId) {
    const dep = await repos.deployment.findById(project.activeDeploymentId);
    const meta = dep?.meta as { deployTarget?: string; serverId?: string } | null;
    deployTarget = meta?.deployTarget ?? null;
    if (meta?.serverId) serverId = meta.serverId;
  }

  return { deployTarget, serverId };
}

async function resolveProjectTrackedDomains(project: Project): Promise<string[]> {
  const rows = await repos.domain.listByProject(project.id);
  const hostnames = rows
    .map((domain) => domain.hostname)
    .filter((hostname): hostname is string => Boolean(hostname?.trim()))
    .map(normalizeTrackedDomain);

  return Array.from(new Set(hostnames));
}

/**
 * Resolve the tracked domain and server for a project.
 *
 * Domain resolution order:
 *   1. Primary domain from DB (`domain` table)
 *   2. Slug-based managed subdomain (`project.slug.baseDomain`)
 *
 * Server resolution order:
 *   1. Active deployment's `meta.serverId`
 *   2. First configured server (single-server setups)
 */
export async function resolveProjectTracking(projectId: string): Promise<ProjectTracking | null> {
  const source = await resolveProjectTrafficSource(projectId);
  if (!source || source.kind !== "self-hosted") {
    return null;
  }

  return { domain: source.domain, serverId: source.serverId };
}

/**
 * Map a fixed list of tracked domains to their traffic sources — the shared core
 * of the single/plural resolvers below. SaaS/OpenShip Cloud deploys observe
 * traffic at the Oblien edge; self-hosted deploys observe it via the target
 * server's OpenResty management API. Empty domain list (or no resolvable server)
 * → no sources.
 */
async function buildTrafficSourcesForDomains(
  project: Project,
  domains: string[],
): Promise<ProjectTrafficSource[]> {
  if (domains.length === 0) return [];

  let { deployTarget, serverId } = await resolveTrafficRuntime(project);

  if (isOblienBackedDeployment(deployTarget)) {
    return domains.map((domain) => ({
      kind: "cloud" as const,
      domain,
      deployTarget: "cloud" as const,
    }));
  }

  // Server: deployment meta first, then first configured server.
  if (!serverId) {
    const servers = await repos.server.list();
    serverId = servers[0]?.id ?? null;
  }
  if (!serverId) return [];

  return domains.map((domain) => ({
    kind: "self-hosted" as const,
    domain,
    serverId,
    deployTarget,
  }));
}

/**
 * Resolve where request traffic is observed for ONE of the project's domains: a
 * validated `domain` override (route switch), else the primary tracked route.
 */
export async function resolveProjectTrafficSource(
  projectId: string,
  opts?: {
    /** Restrict traffic to ONE of the project's domains (route switch). Validated
     *  against the project's tracked domains — an unknown value is ignored and we
     *  fall back to the primary, so a client can never fetch logs for an arbitrary
     *  (cross-tenant) host. */
    domain?: string;
  },
): Promise<ProjectTrafficSource | null> {
  const project = await repos.project.findById(projectId);
  if (!project) return null;

  // Domain: a validated override (route switch), else the primary tracked route.
  let domain: string | null = null;
  const requested = opts?.domain?.trim();
  if (requested) {
    const normalized = normalizeTrackedDomain(requested);
    const tracked = (await resolveProjectTrackedDomains(project)).map(normalizeTrackedDomain);
    if (tracked.includes(normalized)) domain = normalized;
  }
  if (!domain) {
    const primaryDomain = await repos.domain.getPrimaryByProject(projectId);
    domain = primaryDomain?.hostname ? normalizeTrackedDomain(primaryDomain.hostname) : null;
  }
  if (!domain) return null;

  const [source] = await buildTrafficSourcesForDomains(project, [domain]);
  return source ?? null;
}

/**
 * Resolve all domains that should contribute to project-level overview analytics.
 * Normal apps usually have one domain; compose/service apps can have one domain
 * per exposed service, so the overview aggregates them.
 */
export async function resolveProjectTrafficSources(
  projectId: string,
  opts?: {
    /** Scope to ONE tracked domain (route switch). Validated + primary fallback,
     *  identical to resolveProjectTrafficSource, returned as a one-element array.
     *  Omit to aggregate every tracked domain. */
    domain?: string;
  },
): Promise<ProjectTrafficSource[]> {
  if (opts?.domain) {
    const source = await resolveProjectTrafficSource(projectId, { domain: opts.domain });
    return source ? [source] : [];
  }

  const project = await repos.project.findById(projectId);
  if (!project) return [];

  const domains = await resolveProjectTrackedDomains(project);
  return buildTrafficSourcesForDomains(project, domains);
}

// ─── OpenResty management API wrappers ───────────────────────────────────────

/**
 * GET JSON from the OpenResty management API through SSH tunnel.
 */
export async function fetchMgmt<T>(serverId: string, path: string): Promise<T | null> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, path);
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

/**
 * POST to the OpenResty management API through SSH tunnel.
 */
export async function postMgmt<T>(serverId: string, path: string): Promise<T | null> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, path, {
    method: "POST",
  });
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

/**
 * POST a JSON body to the OpenResty management API through the SSH tunnel.
 * Used to push per-route rules into the edge's `rules` shared dict (reload-free).
 */
export async function postMgmtJson<T>(
  serverId: string,
  path: string,
  json: unknown,
): Promise<T | null> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  });
  if (!res || res.statusCode < 200 || res.statusCode >= 300) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

/**
 * Lightweight health probe for the OpenResty management port.
 */
export async function probeMgmt(serverId: string): Promise<boolean> {
  const res = await tunnelRequest(serverId, OPENRESTY_MGMT_PORT, "/health");
  return res?.body.trim() === "ok";
}

/**
 * Open a streaming SSE connection to the OpenResty management API.
 * Returns a tunnel stream handle - caller pipes `handle.stream.on("data", ...)`
 * to the SSE client.
 */
export async function mgmtStream(serverId: string, path: string) {
  return tunnelStream(serverId, OPENRESTY_MGMT_PORT, path);
}
