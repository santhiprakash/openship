/**
 * Deployment service - deployment CRUD and runtime operations.
 *
 * Build pipeline logic lives in build.service.ts.
 * SSL operations live in ssl.service.ts.
 */

import { repos } from "@repo/db";
import { NotFoundError, ForbiddenError } from "@repo/core";
import type { LogEntry } from "@repo/adapters";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { collectDeploymentManifest, executeCleanup } from "../projects/project-cleanup.service";

async function listServiceContainerIds(deploymentId: string): Promise<string[]> {
  const rows = await repos.service.listByDeployment(deploymentId);
  return [...new Set(rows.map((row) => row.containerId).filter((id): id is string => !!id))];
}

async function listDeploymentContainerIds(dep: { id: string; containerId?: string | null }) {
  const serviceContainerIds = await listServiceContainerIds(dep.id);
  if (serviceContainerIds.length > 0) return serviceContainerIds;
  return dep.containerId ? [dep.containerId] : [];
}

// ─── List deployments ────────────────────────────────────────────────────────

export async function listDeployments(
  organizationId: string,
  opts: {
    projectId?: string;
    environment?: string;
    page?: number;
    perPage?: number;
  },
) {
  if (opts.projectId) {
    const project = await repos.project.findById(opts.projectId);
    assertResourceInOrg(project, "Project", organizationId, opts.projectId);
    const result = await repos.deployment.listByProject(opts.projectId, {
      page: opts.page,
      perPage: opts.perPage,
      environment: opts.environment,
    });
    // Mark which row is currently active so the dashboard can render the
    // "Active" chip + gate the rollback action. The schema columns
    // artifactRetainedAt + pinned flow through ...row automatically.
    const activeId = project.activeDeploymentId;
    return {
      ...result,
      rows: result.rows.map((d) => ({ ...d, isActive: d.id === activeId })),
    };
  }

  // No projectId — list scoped to active org. organizationId is required
  // on every authenticated route (the route-permission middleware
  // ensures it's set before this is reached).
  const result = await repos.deployment.listByOrganization(organizationId, {
    page: opts.page,
    perPage: opts.perPage,
  });

  const projectIds = [...new Set(result.rows.map((d) => d.projectId))];
  const projectMap = new Map<string, { name: string; activeDeploymentId: string | null }>();
  for (const pid of projectIds) {
    const p = await repos.project.findById(pid);
    if (p) projectMap.set(pid, { name: p.name, activeDeploymentId: p.activeDeploymentId });
  }

  const enriched = result.rows.map((d) => {
    const proj = projectMap.get(d.projectId);
    return {
      ...d,
      projectName: proj?.name ?? "Unknown",
      isActive: proj?.activeDeploymentId === d.id,
    };
  });

  return { ...result, rows: enriched };
}

// ─── Get deployment ──────────────────────────────────────────────────────────

export async function getDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await repos.deployment.findById(deploymentId);
  assertResourceInOrg(dep, "Deployment", organizationId, deploymentId);

  // Cross-check the parent project belongs to the same org. This guards
  // against orphaned deployments whose project moved orgs.
  const project = await repos.project.findById(dep.projectId);
  assertResourceInOrg(project, "Deployment", organizationId, deploymentId);

  return dep;
}

// ─── Delete deployment ───────────────────────────────────────────────────────

export async function deleteDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  if (["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot delete a deployment that is in progress. Cancel it first.");
  }

  const project = await repos.project.findById(dep.projectId);

  // Collect and destroy runtime resources via shared cleanup orchestrator
  const manifest = await collectDeploymentManifest(dep, project ?? null);
  if (manifest.resources.length > 0) {
    await executeCleanup(manifest);
  }

  // If this is the active deployment, clear it from the project
  if (project && project.activeDeploymentId === deploymentId) {
    await repos.project.setActiveDeployment(project.id, null);
  }

  await repos.deployment.deleteDeployment(deploymentId);
}

// ─── Rollback deployment ─────────────────────────────────────────────────────
//
// Thin wrapper around the RollbackOrchestrator. The orchestrator owns
// the policy + the runtime primitive calls; this service just adds the
// per-org ownership check via getDeployment.

export async function rollbackDeployment(
  deploymentId: string,
  organizationId: string,
) {
  // Existence + org-scope check (throws if deployment isn't in this org).
  const dep = await getDeployment(deploymentId, organizationId);
  const { rollback } = await import("./rollback");
  await rollback(deploymentId);
  // Return the post-rollback deployment row (now with any updated container id).
  return (await repos.deployment.findById(dep.id)) ?? dep;
}

// ─── Pin / unpin deployment ─────────────────────────────────────────────────

export async function setDeploymentPin(
  deploymentId: string,
  organizationId: string,
  pinned: boolean,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  const { setPin } = await import("./rollback");
  await setPin(deploymentId, pinned);
  return (await repos.deployment.findById(dep.id)) ?? dep;
}

// ─── Reject partial deployment ─────────────────────────────────────────────

export async function rejectDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only reject a completed deployment");
  }

  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Project", dep.projectId);

  const meta = (dep.meta as { previousActiveDeploymentId?: string } | null) ?? null;
  const previousDeploymentId = meta?.previousActiveDeploymentId;

  if (previousDeploymentId && previousDeploymentId !== deploymentId) {
    await rollbackDeployment(previousDeploymentId, organizationId);
  }

  await deleteDeployment(deploymentId, organizationId);

  return {
    success: true,
    restoredDeploymentId: previousDeploymentId ?? null,
  };
}

// ─── Deployment logs ─────────────────────────────────────────────────────────

export async function getDeploymentLogs(
  deploymentId: string,
  organizationId: string,
  tail?: number,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  const buildSessions = await repos.deployment.findBuildSession(deploymentId);
  if (buildSessions?.logs) {
    return buildSessions.logs as LogEntry[];
  }

  if (dep.containerId) {
    const { runtime } = await resolveDeploymentRuntime(dep);
    return runtime.getRuntimeLogs(dep.containerId, tail);
  }

  return [];
}

// ─── Restart deployment ──────────────────────────────────────────────────────

export async function restartDeployment(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);

  if (dep.status !== "ready") {
    throw new ForbiddenError("Can only restart a running deployment");
  }
  const containerIds = await listDeploymentContainerIds(dep);
  if (containerIds.length === 0) {
    throw new ForbiddenError("Deployment has no container");
  }

  const { runtime } = await resolveDeploymentRuntime(dep);
  for (const containerId of containerIds) {
    await runtime.restart(containerId);
  }

  return dep;
}

// ─── Container info ──────────────────────────────────────────────────────────

export async function getContainerInfo(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getContainerInfo(dep.containerId);
}

// ─── Container usage ─────────────────────────────────────────────────────────

export async function getContainerUsage(
  deploymentId: string,
  organizationId: string,
) {
  const dep = await getDeployment(deploymentId, organizationId);
  if (!dep.containerId) {
    throw new ForbiddenError("Deployment has no container");
  }
  const { runtime } = await resolveDeploymentRuntime(dep);
  return runtime.getUsage(dep.containerId);
}

// ─── Build logs ──────────────────────────────────────────────────────────────

export async function getBuildLogs(
  deploymentId: string,
  organizationId: string,
) {
  await getDeployment(deploymentId, organizationId);

  const buildSession = await repos.deployment.findBuildSession(deploymentId);
  if (!buildSession?.logs) {
    return [];
  }
  return buildSession.logs as LogEntry[];
}


