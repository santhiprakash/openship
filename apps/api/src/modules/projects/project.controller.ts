/**
 * Project controller - Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Delegates to project.service
 *   3. Returns consistent JSON
 */

import type { Context } from "hono";
import { streamSSE } from "../../lib/sse";
import { getUserId, getActiveOrganizationId, assertResourceInOrg, param } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import * as projectService from "./project.service";
import { AppError, safeErrorMessage } from "@repo/core";
import type {
  TCreateProjectBody,
  TCreateProjectEnvironmentBody,
  TUpdateProjectBody,
  TSetEnvVarsBody,
  TUpdateResourcesBody,
} from "./project.schema";
import { stat } from "node:fs/promises";
import { repos, type Domain, type Project } from "@repo/db";
import { encrypt } from "../../lib/encryption";
import { deployLuaScripts } from "@repo/adapters";
import { getOpenRestyPaths } from "@/lib/openresty-paths";
import * as domainService from "../domains/domain.service";
import * as prepareService from "../deployments/prepare.service";
import { sshManager } from "../../lib/ssh-manager";
import { env, internalApiUrl, runtimeTarget } from "../../config";
import { resolveProjectTrafficSource, fetchMgmt, mgmtStream } from "../../lib/project-analytics";
import { refreshProjectFaviconIfStale } from "../../lib/favicon-detector";
import { getAdminOblienClient } from "../../lib/oblien-user-client";
import { cloudAnalyticsProxy } from "../../lib/cloud-client";
import {
  registerWebhook,
  updateWebhook,
  deleteWebhook,
  getWebhookStrategy,
  resolveWebhookStrategy,
  getAvailableStrategies,
  getRecentCommits,
  getRepository,
  listBranches as listGitHubBranches,
} from "../github/github.service";
import { getInstallationIdByOrg, getInstallUrl } from "../github/github.auth";
import { platform } from "../../lib/controller-helpers";
import { listProjectRouteRows, resolveProjectRouteState } from "../domains/project-route.service";

// Track which servers have had Lua scripts deployed this session
const luaDeployedServers = new Set<string>();

function logEnsureProjectError(
  userId: string,
  body: TCreateProjectBody & { projectId?: string },
  err: unknown,
) {
  console.error("[PROJECT] Failed to ensure project", {
    userId,
    projectId: body.projectId,
    name: body.name,
    slug: body.slug,
    gitBranch: body.gitBranch,
    port: body.port,
    publicEndpoints: body.publicEndpoints?.map((endpoint) => ({
      port: endpoint.port,
      targetPath: endpoint.targetPath,
      domain: endpoint.domain,
      customDomain: endpoint.customDomain,
      domainType: endpoint.domainType,
    })),
  });
  console.error(err);

  if (err instanceof Error && err.cause) {
    console.error("[PROJECT] Ensure project cause:", err.cause);
  }
}

// ─── Ensure project ──────────────────────────────────────────────────────────

export async function ensure(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const body = await c.req.json<TCreateProjectBody & { projectId?: string }>();

  if (!body.name) {
    return c.json({ success: false, error: "name is required" }, 400);
  }

  try {
    const result = await projectService.ensureProject(body, organizationId);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: result.created ? "project.created" : "project.updated",
      resourceType: "project",
      resourceId: result.project_id,
      after: {
        name: body.name,
        slug: body.slug ?? null,
        gitBranch: body.gitBranch ?? null,
        port: body.port ?? null,
      },
    });
    return c.json(result);
  } catch (err) {
    logEnsureProjectError(userId, body, err);

    if (err instanceof AppError) {
      return c.json(
        { success: false, error: err.message, code: err.code },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 500,
      );
    }

    return c.json({ success: false, error: "Failed to ensure project" }, 500);
  }
}

// ─── Projects CRUD ───────────────────────────────────────────────────────────

export async function getHome(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);

  // Surface a structured payload that includes the user's full org list +
  // a per-org project count. The dashboard uses this to render a
  // "projects in your other orgs" hint when the active org has zero
  // visible projects (prevents the common confusion of "I deployed
  // something but it doesn't show up" when the session active org is
  // a freshly-created empty team org).
  let result: { rows: Awaited<ReturnType<typeof projectService.listProjects>>["rows"]; total: number };
  try {
    result = await projectService.listProjects(organizationId, {
      page: 1,
      perPage: 100,
      });
  } catch (err) {
    // Migrations not yet applied — PGlite first-boot case. Return an
    // explicit empty payload with no other-org hints (we can't query
    // memberships either). Do NOT silently swallow other errors —
    // they'd mask real org-context failures and show the user an
    // empty list with no idea why.
    const msg = safeErrorMessage(err);
    const isMissingTable = /relation .* does not exist|no such table/i.test(msg);
    if (!isMissingTable) {
      console.error("[projects.getHome] listProjects failed:", err);
      return c.json(
        {
          success: false,
          error: "Failed to load projects",
          code: "LIST_FAILED",
          message: msg,
        },
        500,
      );
    }
    return c.json({
      success: true,
      projects: [],
      numbers: { total_projects: 0, total_deployments: 0, total_success_deployments: 0 },
      otherOrgs: [],
    });
  }

  // Enrich every project in ONE round trip — five parallel batched
  // queries instead of (4 × N) per-project queries. With 50 projects
  // the old loop fired 200+ SQL statements; this version fires ≤6
  // regardless of project count.
  const projectIds = result.rows.map((p) => p.id);
  const [enrichedProjects, latestByProject, primariesByProject, servicesByProject] =
    await Promise.all([
      projectService.enrichProjectsBatch(result.rows),
      repos.deployment.findLatestByProjects(projectIds),
      repos.domain.getPrimariesByProjects(projectIds),
      repos.service.listByProjects(projectIds),
    ]);

  const projects = enrichedProjects.map((enriched, idx) => {
    const original = result.rows[idx];
    const latest = latestByProject.get(original.id);
    const primary = primariesByProject.get(original.id);
    const services = servicesByProject.get(original.id) ?? [];

    refreshProjectFaviconIfStale(original, {
      hostname: primary?.verified ? primary.hostname : null,
    });

    return {
      ...enriched,
      latestDeploymentId: latest?.id ?? null,
      latestDeploymentStatus: latest?.status ?? null,
      primaryDomain: primary?.hostname ?? null,
      serviceCount: services.length,
      hasMultipleServices: services.length > 1,
    };
  });

  // Compute "projects in other orgs" — used by the dashboard when this
  // org has 0 projects to nudge "your projects are over there". Cheap
  // query: one count per other org. Only runs when current org list is
  // empty so the normal case has no extra cost.
  let otherOrgs: Array<{ organizationId: string; name: string; projectCount: number }> = [];
  if (result.total === 0) {
    try {
      const memberships = await repos.member.listByUser(userId);
      const otherOrgIds = memberships
        .map((m) => m.organizationId)
        .filter((id) => id !== organizationId);
      // Batch lookup names + project counts. Names come from one
      // findManyById; counts still go through projectService per org
      // (each is a SELECT COUNT — fine at N < 20 memberships).
      const orgs = await repos.organization
        .findManyById(otherOrgIds)
        .catch(() => []);
      const orgsById = new Map(orgs.map((o) => [o.id, o]));
      otherOrgs = await Promise.all(
        otherOrgIds.map(async (otherOrgId) => {
          const countResult = await projectService
            .listProjects(otherOrgId, { page: 1, perPage: 1 })
            .catch(() => ({ total: 0 }));
          const org = orgsById.get(otherOrgId);
          return {
            organizationId: otherOrgId,
            name: org?.name ?? otherOrgId,
            projectCount: countResult.total,
          };
        }),
      );
      otherOrgs = otherOrgs.filter((o) => o.projectCount > 0);
    } catch (err) {
      console.warn("[projects.getHome] cross-org hint lookup failed:", err);
      otherOrgs = [];
    }
  }

  return c.json({
    success: true,
    projects,
    numbers: {
      total_projects: result.total,
      total_deployments: 0,
      total_success_deployments: 0,
    },
    otherOrgs,
  });
}

export async function list(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const result = await projectService.listProjects(organizationId, { page, perPage });
  result.rows.forEach((project) => {
    refreshProjectFaviconIfStale(project);
  });
  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const body = await c.req.json<TCreateProjectBody>();
  const project = await projectService.createProject(body, { organizationId });
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.created",
    resourceType: "project",
    resourceId: project.id,
    after: {
      name: project.name,
      slug: project.slug,
      framework: project.framework ?? null,
      gitProvider: project.gitProvider ?? null,
      gitOwner: project.gitOwner ?? null,
      gitRepo: project.gitRepo ?? null,
      gitBranch: project.gitBranch ?? null,
    },
  });
  return c.json({ data: project }, 201);
}

export async function getById(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const project = await projectService.getProject(id, organizationId);
  refreshProjectFaviconIfStale(project);
  return c.json({ data: project });
}

// ─── Project environments ───────────────────────────────────────────────────

export async function listEnvironments(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const data = await projectService.listProjectEnvironments(id, organizationId);
  return c.json({ success: true, data });
}

export async function createEnvironment(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TCreateProjectEnvironmentBody>();

  if (!body.environmentName?.trim()) {
    return c.json({ success: false, error: "environmentName is required" }, 400);
  }

  try {
    const data = await projectService.createProjectEnvironment(id, userId, body, organizationId);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: {
        action: "environment.created",
        environmentId: data.id,
        environmentName: data.name,
        environmentSlug: data.slug,
        environmentType: data.type,
        gitBranch: data.gitBranch,
      },
    });
    return c.json({ success: true, data }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create environment";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function update(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TUpdateProjectBody>();
  const project = await projectService.updateProject(id, body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: project.id,
    after: {
      name: project.name,
      slug: project.slug,
      gitOwner: project.gitOwner ?? null,
      gitRepo: project.gitRepo ?? null,
      gitBranch: project.gitBranch ?? null,
    },
  });
  return c.json({ data: project });
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "admin" });
  const deleteApp = c.req.query("deleteApp") !== "false";
  // Allow opting in to volume wipe via either query string or JSON body -
  // the dashboard sends a body, but query is handy for tooling.
  let bodyWipeVolumes: boolean | undefined;
  try {
    const body = await c.req.json<{ wipeVolumes?: boolean }>();
    bodyWipeVolumes = body?.wipeVolumes;
  } catch {
    /* no body - fine */
  }
  const wipeVolumes = bodyWipeVolumes ?? c.req.query("wipeVolumes") === "true";
  const result = await projectService.deleteProject(id, organizationId, {
    deleteApp,
    wipeVolumes,
  });
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.deleted",
    resourceType: "project",
    resourceId: id,
    after: {
      deleteApp,
      wipeVolumes,
      deletedApp: result.deletedApp,
      deletedProjects: result.deletedProjects,
    },
  });
  return c.json({ message: "deleted", ...result });
}

export async function deletionPreview(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const { repos } = await import("@repo/db");
  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ success: false, error: "project-not-found" }, 404);
  }
  const preview = await projectService.previewProjectDeletion(project);
  return c.json({ success: true, preview });
}

// ─── Environment variables ───────────────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const environment = c.req.query("environment");
  const vars = await projectService.listEnvVars(id, organizationId, environment);
  return c.json({ data: vars });
}

export async function setEnvVars(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TSetEnvVarsBody>();
  const result = await projectService.setEnvVars(id, organizationId, body);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "envVars.set",
      environment: body.environment,
      // Names only - never echo the secret values.
      varNames: (body.vars ?? []).map((v) => v.key),
    },
  });
  return c.json(result);
}

// ─── Resources ───────────────────────────────────────────────────────────────

export async function getResources(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const resources = await projectService.getResources(id, organizationId);
  return c.json({ data: resources });
}

export async function updateResources(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<TUpdateResourcesBody>();
  const resources = await projectService.updateResources(id, body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "resources.updated",
      production: body.production ?? null,
      build: body.build ?? null,
      sleepMode: body.sleepMode ?? null,
      port: body.port ?? null,
    },
  });
  return c.json({ data: resources });
}

// ─── Clone token (per-project override) ──────────────────────────────────────

/**
 * GET /projects/:id/clone-token - read-only state. Never returns the token,
 * only whether one is set and when it was set last.
 */
export async function getCloneToken(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const project = await projectService.getProject(id, organizationId);
  return c.json({
    hasToken: !!project.cloneTokenEncrypted,
    setAt: project.cloneTokenSetAt?.toISOString() ?? null,
  });
}

/**
 * PATCH /projects/:id/clone-token - set/replace/clear the per-project clone token.
 *
 * Body:
 *   { token?: string | null }
 *
 *   token === null → clear.
 *   token: string  → encrypt and store. Empty string treated as clear.
 *
 * The token is encrypted on save and never echoed back. Resolves the chain
 * tier: project token > user-global > App > mode default.
 */
export async function updateCloneToken(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "admin" });
  const body = await c.req.json().catch(() => ({}));
  const rawToken = body?.token;

  const project = await projectService.getProject(id, organizationId);

  if (rawToken === null || rawToken === "") {
    await repos.project.update(project.id, {
      cloneTokenEncrypted: null,
      cloneTokenSetAt: null,
    });
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: project.id,
      after: { action: "cloneToken.cleared" },
    });
    return c.json({ hasToken: false, setAt: null });
  }

  if (typeof rawToken !== "string" || rawToken.length === 0) {
    return c.json({ error: "token must be a non-empty string or null" }, 400);
  }

  await repos.project.update(project.id, {
    cloneTokenEncrypted: encrypt(rawToken),
    cloneTokenSetAt: new Date(),
  });

  const setAt = new Date().toISOString();
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: project.id,
    after: { action: "cloneToken.set", setAt },
  });
  return c.json({ hasToken: true, setAt });
}

// ─── Local projects ──────────────────────────────────────────────────────────

/** Scan a local directory and detect framework/stack */
export async function scanLocal(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const { path: dirPath } = await c.req.json<{ path: string }>();
  if (!dirPath) return c.json({ error: "path is required" }, 400);

  // Validate the path exists and is a directory
  try {
    const st = await stat(dirPath);
    if (!st.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  const result = await prepareService.resolveProjectInfo({ source: "local", path: dirPath });

  return c.json({
    success: true,
    name: result.repository.name,
    path: dirPath,
    stack: result.stack,
    projectType: result.projectType,
    category: result.category,
    packageManager: result.packageManager,
    installCommand: result.installCommand,
    buildCommand: result.buildCommand,
    startCommand: result.startCommand,
    buildImage: result.buildImage,
    outputDirectory: result.outputDirectory,
    rootDirectory: result.rootDirectory,
    productionPaths: result.productionPaths,
    port: result.port,
    services: result.services,
  });
}

/** Import a local folder as a project */
export async function importLocal(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const body = await c.req.json<TCreateProjectBody & { localPath: string }>();

  if (!body.localPath) return c.json({ error: "localPath is required" }, 400);

  // Verify directory exists
  try {
    const st = await stat(body.localPath);
    if (!st.isDirectory()) return c.json({ error: "Path is not a directory" }, 400);
  } catch {
    return c.json({ error: "Directory not found" }, 404);
  }

  const project = await projectService.createProject(
    {
      ...body,
      gitProvider: "local",
    },
    { organizationId },
  );

  return c.json({ data: project }, 201);
}

/** List only local projects for the current user */
export async function listLocal(c: Context) {
  if (env.CLOUD_MODE) return c.notFound();

  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  try {
    const result = await projectService.listProjects(organizationId, {
      page: 1,
      perPage: 100,
      });
    const localProjects = result.rows.filter((p) => p.gitProvider === "local");
    return c.json({ success: true, projects: localProjects });
  } catch {
    return c.json({ success: true, projects: [] });
  }
}

// ─── Runtime logs ────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/logs - one-shot fetch of recent runtime logs.
 */
export async function runtimeLogs(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  try {
    const entries = await projectService.getRuntimeLogs(id, organizationId, tail);
    return c.json({ data: entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get logs";
    return c.json({ error: message }, 400);
  }
}

/**
 * GET /projects/:id/logs/stream - SSE stream of runtime logs.
 */
export async function runtimeLogStream(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const tail = c.req.query("tail") ? Number(c.req.query("tail")) : undefined;

  return streamSSE(c, async (sseStream) => {
    let cleanup: (() => void) | null = null;
    let serverId: string | null = null;

    try {
      const result = await projectService.streamRuntimeLogs(
        id,
        organizationId,
        (entry) => {
          void sseStream.writeSSE({
            event: "log",
            data: JSON.stringify({
              type: "log",
              data: entry.rawData,
              message: entry.message,
              timestamp: entry.timestamp,
              level: entry.level,
            }),
          });
        },
        { tail },
      );

      cleanup = result.cleanup;
      serverId = result.serverId;
      if (serverId) sshManager.retain(serverId);

      // Keep the stream open until client disconnects
      await new Promise<void>((resolve) => {
        sseStream.onAbort(() => {
          cleanup?.();
          resolve();
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stream logs";
      await sseStream.writeSSE({ event: "error", data: JSON.stringify({ error: message }) });
      cleanup?.();
    } finally {
      if (serverId) sshManager.release(serverId);
    }
  });
}

// ─── Server HTTP request logs ────────────────────────────────────────────────

function extractCloudStreamToken(result: unknown): { stream_url: string; token: string } | null {
  const root = result as Record<string, unknown> | null;
  const data = (root?.data && typeof root.data === "object" ? root.data : root) as Record<
    string,
    unknown
  > | null;
  const streamUrl = data?.stream_url ?? data?.streamUrl ?? data?.url;
  const token = data?.token;
  return typeof streamUrl === "string" && typeof token === "string"
    ? { stream_url: streamUrl, token }
    : null;
}

function extractCloudRequestLogs(result: unknown): unknown[] {
  const root = result as Record<string, unknown> | null;
  const data = root?.data as unknown;
  const candidates = [
    data,
    root?.requests,
    root?.logs,
    root?.items,
    root?.rows,
    data && typeof data === "object" ? (data as Record<string, unknown>).requests : undefined,
    data && typeof data === "object" ? (data as Record<string, unknown>).logs : undefined,
    data && typeof data === "object" ? (data as Record<string, unknown>).items : undefined,
    data && typeof data === "object" ? (data as Record<string, unknown>).rows : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

/**
 * GET /projects/:id/server-logs/stream-token
 *
 * Returns { kind: "cloud", url, token } or { kind: "self-hosted" }.
 * For cloud projects the dashboard connects directly to the edge SSE stream.
 */
export async function serverLogStreamToken(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const source = await resolveProjectTrafficSource(id);
  if (!source) {
    return c.json({ error: "No domain configured for this project" }, 400);
  }

  if (source.kind === "cloud") {
    const client = getAdminOblienClient();
    let tokenResult: unknown = null;

    if (client) {
      try {
        tokenResult = await client.analytics.streamToken(source.domain);
      } catch {
        return c.json({ kind: "self-hosted" as const });
      }
    } else {
      tokenResult = await cloudAnalyticsProxy(organizationId, "streamToken", source.domain);
    }

    const tokenData = extractCloudStreamToken(tokenResult);
    if (!tokenData) {
      return c.json({ kind: "self-hosted" as const });
    }
    return c.json({ kind: "cloud" as const, url: tokenData.stream_url, token: tokenData.token });
  }

  return c.json({ kind: "self-hosted" as const });
}

/**
 * GET /projects/:id/server-logs/stream - SSE stream of HTTP request logs
 * from the OpenResty pipe_stream on the managed server.
 *
 * Cloud projects use stream-token + direct edge connection instead.
 * Auto-deploys Lua scripts once per API session per server.
 */
export async function serverLogStream(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const source = await resolveProjectTrafficSource(id);
  if (!source || source.kind !== "self-hosted") {
    return c.json({ error: "Use stream-token endpoint for cloud projects" }, 400);
  }

  const { domain, serverId } = source;

  return streamSSE(c, async (sseStream) => {
    sshManager.retain(serverId);
    try {
      if (!luaDeployedServers.has(serverId)) {
        try {
          const executor = await sshManager.acquire(serverId);
          const paths = await getOpenRestyPaths(serverId, executor);
          await deployLuaScripts(executor, paths);
          luaDeployedServers.add(serverId);
        } catch {
          // Non-fatal - scripts may already be up to date
        }
      }

      const reqPath = `/logs/stream?domain=${encodeURIComponent(domain)}`;
      const conn = await mgmtStream(serverId, reqPath);
      if (!conn) {
        await sseStream
          .writeSSE({
            event: "error",
            data: JSON.stringify({
              error: "Failed to connect to log service - ensure OpenResty is running",
            }),
          })
          .catch(() => {});
        return;
      }

      sseStream.onAbort(() => conn.destroy());

      await new Promise<void>((resolve) => {
        conn.stream.on("data", (chunk: Buffer) => {
          sseStream.write(chunk.toString()).catch(() => conn.destroy());
        });
        conn.stream.on("close", () => resolve());
        conn.stream.on("end", () => resolve());
        conn.stream.on("error", () => resolve());
      });
    } finally {
      sshManager.release(serverId);
    }
  });
}

// ─── Recent server logs ──────────────────────────────────────────────────────

export async function recentServerLogs(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const source = await resolveProjectTrafficSource(id);
  if (!source) {
    return c.json({ logs: [] });
  }

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);

  if (source.kind === "cloud") {
    const client = getAdminOblienClient();
    let result: unknown = null;

    if (client) {
      try {
        result = await client.analytics.requests(source.domain, { limit });
      } catch {
        return c.json({ logs: [] });
      }
    } else {
      result = await cloudAnalyticsProxy(organizationId, "requests", source.domain, { limit });
    }

    return c.json({ logs: extractCloudRequestLogs(result) });
  }

  const { domain, serverId } = source;

  const entries = await fetchMgmt<unknown[]>(
    serverId,
    `/logs/recent?domain=${encodeURIComponent(domain)}&limit=${limit}`,
  );
  return c.json({ logs: entries ?? [] });
}

// ─── Git info ────────────────────────────────────────────────────────────────

export async function getGitInfo(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const info = await projectService.getGitInfo(id, organizationId);

  // No repo linked yet
  if (!info.gitOwner || !info.gitRepo) {
    return c.json({ success: false, error: "No repository connected" });
  }

  const strategy = await resolveWebhookStrategy(userId, info);

  // Cloud projects (deployTarget=cloud) need the GitHub App installed - regardless
  // of whether this server is the SaaS or a local instance connected to cloud.
  const isCloudProject = info.deployTarget === "cloud";
  let installationInstalled = false;
  if (isCloudProject && info.gitOwner) {
    const instId = await getInstallationIdByOrg(organizationId, info.gitOwner);
    installationInstalled = !!instId;
  }

  let sharedWebhookId = info.webhookId ?? null;
  if (!sharedWebhookId && info.gitOwner && info.gitRepo) {
    sharedWebhookId = await findSharedWebhookId(organizationId, info.gitOwner, info.gitRepo);
  }

  // Derive webhook_active from strategy + state
  const webhookActive =
    strategy === "app"
      ? installationInstalled
      : strategy === "domain"
        ? !!(info.autoDeploy && sharedWebhookId)
        : strategy === "repo"
          ? !!(info.autoDeploy && sharedWebhookId)
          : false;

  // Get available strategies for the UI
  const strategies = await getAvailableStrategies(userId, info);

  // Get project domains for webhook domain picker
  const domains = await repos.domain.listByProject(id);
  const verifiedDomains = domains
    .filter((d) => d.verified)
    .map((d) => ({ hostname: d.hostname, ssl: d.sslStatus === "active" }));

  let branch = info.gitBranch ?? "";
  if (!branch && info.gitOwner && info.gitRepo) {
    const repository = await getRepository(userId, info.gitOwner, info.gitRepo);
    branch = repository.default_branch;
  }
  const commits = branch
    ? await getRecentCommits(userId, info.gitOwner, info.gitRepo, branch, 10)
    : [];

  return c.json({
    success: true,
    owner: info.gitOwner,
    repo: info.gitRepo,
    branch,
    provider: info.gitProvider ?? "github",
    commits: commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      author: c.author,
      author_avatar: c.authorAvatar,
      date: c.date,
      url: c.url,
    })),
    auto_deploy: info.autoDeploy ?? false,
    webhook_strategy: strategy,
    webhook_active: webhookActive,
    webhook_domain: info.webhookDomain ?? null,
    available_strategies: strategies.available,
    verified_domains: verifiedDomains,
    installation_installed: installationInstalled,
    install_url: isCloudProject && !installationInstalled ? getInstallUrl() : undefined,
  });
}

export async function listBranches(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const info = await projectService.getGitInfo(id, organizationId);

  if (!info.gitOwner || !info.gitRepo) {
    return c.json({ success: false, error: "No repository connected" }, 400);
  }

  const branches = await listGitHubBranches(userId, info.gitOwner, info.gitRepo);
  return c.json({
    success: true,
    data: branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected,
    })),
  });
}

/**
 * POST /projects/:id/git/link  { owner, repo, branch? }
 *
 * Links a GitHub repo to an existing project and registers a deploy webhook.
 */
export async function linkRepo(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const { owner, repo, branch, installationId } = await c.req.json<{
    owner: string;
    repo: string;
    branch?: string;
    installationId?: number;
  }>();

  if (!owner?.trim() || !repo?.trim()) {
    return c.json({ success: false, error: "owner and repo are required" }, 400);
  }

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  // Update git fields on the project
  const gitUrl = `https://github.com/${owner}/${repo}.git`;
  const defaultBranch = branch?.trim() || (await getRepository(userId, owner, repo)).default_branch;

  const gitFields: Record<string, unknown> = {
    gitProvider: "github",
    gitOwner: owner,
    gitRepo: repo,
    gitBranch: defaultBranch,
    gitUrl,
  };

  const strategy = await resolveWebhookStrategy(userId, project);

  if (strategy === "app") {
    // Cloud mode - verify the GitHub App is installed for this owner
    const resolvedInstId = await getInstallationIdByOrg(organizationId, owner);
    if (!resolvedInstId) {
      return c.json(
        {
          success: false,
          error: "GitHub App is not installed for this account",
          install_url: getInstallUrl(),
          owner,
        },
        400,
      );
    }
    gitFields.installationId = resolvedInstId;
    gitFields.autoDeploy = true;
  } else if (strategy === "domain") {
    // User has a verified domain for webhooks → direct delivery
    const webhookUrl = `https://${project.webhookDomain}/_openship/hooks/github`;
    try {
      const wh = await registerWebhook(userId, owner, repo, webhookUrl);
      if (wh.hookId) gitFields.webhookId = wh.hookId;
      gitFields.autoDeploy = true;
    } catch {
      // Link succeeds without auto-deploy - user can enable later
    }
  } else if (strategy === "repo") {
    // Self-hosted with a public URL - create a repo-level push webhook.
    let webhookId: number | null = null;
    try {
      const result = await registerWebhook(userId, owner, repo);
      webhookId = result.hookId;
      gitFields.webhookId = webhookId;
      gitFields.autoDeploy = !!webhookId;
    } catch {
      // Webhook registration failed - link still succeeds, just no auto-deploy
    }
  }
  // strategy === "none": no webhook path is available for this instance yet

  await repos.project.update(id, gitFields);
  if (project.appId) {
    await repos.projectApp.update(project.appId, {
      gitProvider: "github",
      gitOwner: owner,
      gitRepo: repo,
      gitUrl,
      installationId: (gitFields.installationId as number | undefined) ?? installationId,
    });

    const sharedGitFields = {
      gitProvider: "github",
      gitOwner: owner,
      gitRepo: repo,
      gitUrl,
      installationId: (gitFields.installationId as number | undefined) ?? installationId,
      ...(typeof gitFields.webhookId === "number" ? { webhookId: gitFields.webhookId } : {}),
    };
    const siblings = await repos.project.listByApp(project.appId);
    await Promise.all(
      siblings
        .filter((sibling) => sibling.id !== id)
        .map((sibling) => repos.project.update(sibling.id, sharedGitFields)),
    );
  }

  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "git.linked",
      gitOwner: owner,
      gitRepo: repo,
      gitBranch: defaultBranch,
      webhookStrategy: strategy,
      autoDeploy: !!gitFields.autoDeploy,
    },
  });

  return c.json({
    success: true,
    owner,
    repo,
    branch: defaultBranch,
    webhook_strategy: strategy,
    auto_deploy: !!gitFields.autoDeploy,
  });
}

async function listOrgRepoProjects(organizationId: string, owner: string, repo: string) {
  const ownerKey = owner.toLowerCase();
  const repoKey = repo.toLowerCase();
  const projects = await repos.project.findByGitRepo(owner, repo);
  return projects.filter(
    (p) =>
      p.organizationId === organizationId &&
      p.gitOwner?.toLowerCase() === ownerKey &&
      p.gitRepo?.toLowerCase() === repoKey,
  );
}

async function findSharedWebhookId(organizationId: string, owner: string, repo: string) {
  const projects = await listOrgRepoProjects(organizationId, owner, repo);
  return projects.find((p) => typeof p.webhookId === "number")?.webhookId ?? null;
}

async function syncSharedWebhookId(organizationId: string, owner: string, repo: string, webhookId: number) {
  const projects = await listOrgRepoProjects(organizationId, owner, repo);
  await Promise.all(
    projects
      .filter((p) => p.webhookId !== webhookId)
      .map((p) => repos.project.update(p.id, { webhookId })),
  );
}

async function ensureSharedWebhook(
  userId: string,
  project: Project,
  owner: string,
  repo: string,
  webhookUrl?: string,
) {
  const existingHookId =
    project.webhookId ?? (await findSharedWebhookId(project.organizationId, owner, repo));
  const targetWebhookUrl = webhookUrl ?? `${runtimeTarget.api}/api/webhooks/github`;
  const result = await registerWebhook(userId, owner, repo, targetWebhookUrl);
  if (!result.hookId) return null;

  if (existingHookId && existingHookId !== result.hookId) {
    await updateWebhook(userId, owner, repo, existingHookId, { active: false }).catch(
      () => undefined,
    );
  }

  await syncSharedWebhookId(project.organizationId, owner, repo, result.hookId);
  return result.hookId;
}

async function disableSharedWebhookIfUnused(
  userId: string,
  organizationId: string,
  owner: string,
  repo: string,
  webhookId: number | null,
) {
  const repoProjects = await repos.project.findByGitRepo(owner, repo);
  if (repoProjects.some((p) => p.autoDeploy)) return;

  const projects = repoProjects.filter((p) => p.organizationId === organizationId);
  const hookId = webhookId ?? projects.find((p) => typeof p.webhookId === "number")?.webhookId;
  if (hookId) {
    await updateWebhook(userId, owner, repo, hookId, { active: false });
  }
}

export async function setAutoDeploy(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  const owner = project.gitOwner;
  const repo = project.gitRepo;

  if (!owner || !repo) {
    return c.json({ success: false, error: "No repository linked" }, 400);
  }

  const strategy = await resolveWebhookStrategy(userId, project);

  // In "none" mode, auto-deploy can't work - suggest options
  if (strategy === "none" && enabled) {
    return c.json(
      {
        success: false,
        error:
          "Set a webhook domain or expose this Openship API on a public URL to enable auto-deploy.",
        webhook_strategy: "none",
      },
      400,
    );
  }

  try {
    if (strategy === "app") {
      // GitHub App handles push events natively - just toggle the DB flag
      await repos.project.update(id, { autoDeploy: enabled });
    } else if (strategy === "domain") {
      // User has a verified domain - direct webhook delivery
      if (enabled) {
        const webhookUrl = `https://${project.webhookDomain}/_openship/hooks/github`;
        const webhookId = await ensureSharedWebhook(userId, project, owner, repo, webhookUrl);
        if (!webhookId) {
          return c.json(
            {
              success: false,
              error: "Could not create webhook - you may not have admin access to this repository",
            },
            403,
          );
        }
        await repos.project.update(id, { autoDeploy: true });
      } else {
        await repos.project.update(id, { autoDeploy: false });
        await disableSharedWebhookIfUnused(userId, project.organizationId, owner, repo, project.webhookId);
      }
    } else if (enabled) {
      // "repo" strategy - manage repo-level webhooks
      const webhookId = await ensureSharedWebhook(userId, project, owner, repo);
      if (!webhookId) {
        return c.json(
          {
            success: false,
            error: "Could not create webhook - you may not have admin access to this repository",
          },
          403,
        );
      }
      await repos.project.update(id, { autoDeploy: true });
    } else {
      // Disable this environment. Keep the repo webhook while sibling environments still use it.
      await repos.project.update(id, { autoDeploy: false });
      await disableSharedWebhookIfUnused(userId, project.organizationId, owner, repo, project.webhookId);
    }
  } catch (err) {
    const msg = safeErrorMessage(err);
    console.error(`[setAutoDeploy] strategy=${strategy} enabled=${enabled}:`, msg);

    if (msg.includes("No GitHub access token")) {
      return c.json(
        { success: false, error: "GitHub is not connected. Link your GitHub account first." },
        401,
      );
    }
    if (msg.includes("404")) {
      await repos.project.update(id, { webhookId: null, autoDeploy: false });
      return c.json(
        {
          success: false,
          error: "Webhook was deleted on GitHub. Try disabling and re-enabling auto-deploy.",
        },
        410,
      );
    }
    if (msg.includes("403")) {
      return c.json(
        {
          success: false,
          error: "You don't have permission to manage webhooks on this repository.",
        },
        403,
      );
    }
    if (msg.includes("422")) {
      return c.json(
        {
          success: false,
          error:
            "A webhook already exists for this repository. Try disabling and re-enabling auto-deploy.",
        },
        409,
      );
    }
    return c.json({ success: false, error: msg || "Failed to configure auto-deploy" }, 500);
  }

  const updated = await repos.project.findById(id);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "autoDeploy.set",
      autoDeploy: updated?.autoDeploy ?? false,
      webhookStrategy: strategy,
    },
  });
  return c.json({
    success: true,
    auto_deploy: updated?.autoDeploy ?? false,
    webhook_strategy: strategy,
  });
}

/**
 * POST /projects/:id/webhook-domain  { domain: string | null }
 *
 * Set or clear the domain used for receiving GitHub webhooks.
 *
 * When a domain is set:
 *   1. Validates it belongs to this project and is verified
 *   2. Adds /_openship/hooks/ location to the domain's nginx config
 *   3. The webhook URL becomes https://{domain}/_openship/hooks/github
 *
 * When domain is null → clears the webhook domain (falls back to edge relay or none).
 */
export async function setWebhookDomain(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const { domain: hostname } = await c.req.json<{ domain: string | null }>();

  const project = await repos.project.findById(id);
  try {
    assertResourceInOrg(project, "Project", organizationId, id);
  } catch {
    return c.json({ error: "Project not found" }, 404);
  }

  // ── Clear webhook domain ────────────────────────────────────────────
  if (!hostname) {
    // If clearing, remove the webhook location from the old domain's nginx config
    if (project.webhookDomain) {
      await reRegisterDomainRoute(project, project.webhookDomain, false);
    }
    await repos.project.update(id, { webhookDomain: null });
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: "webhookDomain.cleared" },
    });
    return c.json({ success: true, webhook_domain: null });
  }

  // ── Set webhook domain ──────────────────────────────────────────────
  // Verify the domain belongs to this project. Single-row lookup —
  // listByProject would scan every domain just to match one hostname.
  const dom = await repos.domain.findByHostnameForProject(id, hostname);
  if (!dom) {
    return c.json({ error: "Domain does not belong to this project" }, 400);
  }
  if (!dom.verified) {
    return c.json({ error: "Domain must be verified before it can receive webhooks" }, 400);
  }

  // Remove webhook location from the old domain if changing
  if (project.webhookDomain && project.webhookDomain !== hostname) {
    await reRegisterDomainRoute(project, project.webhookDomain, false);
  }

  // Add webhook location to the new domain's nginx config
  await reRegisterDomainRoute(project, hostname, true);

  await repos.project.update(id, { webhookDomain: hostname });

  const scheme = dom.sslStatus === "active" ? "https" : "http";
  const webhookUrl = `${scheme}://${hostname}/_openship/hooks/github`;

  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "webhookDomain.set", webhookDomain: hostname },
  });
  return c.json({
    success: true,
    webhook_domain: hostname,
    webhook_url: webhookUrl,
  });
}

/**
 * Re-register a domain's nginx route with or without the webhook proxy location.
 * Reads the current deployment's service info to get the route target.
 */
async function reRegisterDomainRoute(
  project: { id: string; activeDeploymentId: string | null; port: number | null },
  hostname: string,
  enableWebhook: boolean,
): Promise<void> {
  if (!project.activeDeploymentId) return;

  try {
    const { routing } = platform();

    // Find the service deployment to get the container target
    const svcDeps = await repos.service.listByDeployment(project.activeDeploymentId);
    const primarySvc = svcDeps.find((s) => s.ip);

    if (!primarySvc?.ip) return;

    const port = primarySvc.hostPort?.toString() || project.port?.toString() || "3000";

    await routing.registerRoute({
      domain: hostname,
      tls: true,
      targetUrl: `http://${primarySvc.ip}:${port}`,
      webhookProxy: enableWebhook ? `${internalApiUrl}/api/webhooks/` : undefined,
    });
  } catch (err) {
    console.error(`[Webhook Domain] Failed to update nginx for ${hostname}:`, err);
  }
}

export async function setBranch(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const { branch } = await c.req.json<{ branch: string }>();
  if (!branch) return c.json({ error: "branch is required" }, 400);
  const result = await projectService.setBranch(id, branch, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "branch.set", gitBranch: branch },
  });
  return c.json(result);
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function setOptions(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<Record<string, unknown>>();
  const result = await projectService.updateOptions(id, body, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: {
      action: "options.set",
      keys: Object.keys(body ?? {}),
    },
  });
  return c.json({ data: result });
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const { sleep_mode } = await c.req.json<{ sleep_mode: string }>();
  if (!sleep_mode) return c.json({ error: "sleep_mode is required" }, 400);
  const result = await projectService.setSleepMode(id, sleep_mode, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "sleepMode.set", sleepMode: sleep_mode },
  });
  return c.json(result);
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

export async function enable(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  try {
    const result = await projectService.enableProject(id, organizationId);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: "enabled" },
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to enable project";
    return c.json({ success: false, error: message }, 400);
  }
}

export async function disable(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  try {
    const result = await projectService.disableProject(id, organizationId);
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "project.updated",
      resourceType: "project",
      resourceId: id,
      after: { action: "disabled" },
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to disable project";
    return c.json({ success: false, error: message }, 400);
  }
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listDeployments(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const environment = c.req.query("environment") ?? undefined;
  const result = await projectService.listProjectDeployments(id, organizationId, {
    page,
    perPage,
    environment,
  });
  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function deploymentSession(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const result = await projectService.getLatestDeploymentSession(id, organizationId);
  return c.json(result);
}

// ─── Project info (enriched) ─────────────────────────────────────────────────

export async function getInfo(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "read" });
  const project = await projectService.getProject(id, organizationId);
  const environments = await projectService.listProjectEnvironments(id, organizationId);
  const hasServer = project.hasServer ?? project.productionMode === "host";
  const serviceRows = await repos.service.listByProject(id);
  const serviceCount = serviceRows.length;

  // Build the "options" object the dashboard expects for build settings
  const options = {
    buildCommand: project.buildCommand ?? "",
    outputDirectory: project.outputDirectory ?? "",
    productionPaths: project.productionPaths ?? "",
    installCommand: project.installCommand ?? "",
    startCommand: hasServer ? (project.startCommand ?? "") : "",
    productionPort: hasServer ? String(project.port ?? 3000) : "",
    hasServer,
    hasBuild: project.hasBuild ?? true,
    rootDirectory: project.rootDirectory ?? "./",
    isLoading: false,
    error: null,
  };

  // No separate monorepoApps array: the Services API already returns all
  // services (compose + monorepo, discriminated by `kind`). The dashboard
  // filters that list when it wants only sub-apps. Adding a parallel array
  // here would re-introduce the duplication the fan-out unification removed.

  // Fetch domains for this project
  const rawDomains = await listProjectRouteRows(id);
  const routeState = await resolveProjectRouteState(project, { projectDomains: rawDomains });
  const publicEndpoints = routeState.publicEndpoints;
  let domains: Array<Domain & { domain: string; primary: boolean }> = rawDomains.map((d) => ({
    ...d,
    domain: d.hostname,
    primary: d.isPrimary,
  }));

  const verifiedPrimaryDomain =
    rawDomains.find((domain) => domain.isPrimary && domain.verified)?.hostname ??
    rawDomains.find((domain) => domain.verified)?.hostname ??
    null;
  refreshProjectFaviconIfStale(project, {
    hostname: verifiedPrimaryDomain,
  });

  return c.json({
    success: true,
    data: {
      project: {
        ...project,
        publicEndpoints,
        options,
        domains,
        serviceCount,
        hasMultipleServices: serviceCount > 1,
      },
      environments,
    },
  });
}

// ─── Connect custom domain ─────────────────────────────────────────────────────

export async function connectDomain(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "project", resourceId: id, action: "write" });
  const body = await c.req.json<{ domain: string; includeWww?: boolean }>();

  if (!body.domain?.trim()) {
    return c.json({ success: false, error: "Domain is required" }, 400);
  }

  try {
    const result = await domainService.addDomain(userId, {
      projectId: id,
      hostname: body.domain.trim(),
      isPrimary: true,
    });

    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "domain.added",
      resourceType: "domain",
      resourceId: result.domain.id,
      after: {
        projectId: id,
        hostname: result.domain.hostname,
        isPrimary: result.domain.isPrimary,
      },
    });

    return c.json({
      success: true,
      domain: result.domain,
      records: result.records,
    });
  } catch (err) {
    if (err instanceof Error) {
      return c.json({ success: false, error: err.message, message: err.message }, 400);
    }
    throw err;
  }
}
