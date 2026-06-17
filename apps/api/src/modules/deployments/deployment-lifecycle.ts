/**
 * Deployment lifecycle hooks - shared onSuccess / onFailure for the
 * entire build→deploy process.
 *
 * The orchestrator (build.service.ts) creates a lifecycle context once
 * at the start of a deployment, then calls onSuccess or onFailure at
 * the end. These hooks handle everything:
 *
 *   onFailure  →  destroy resources → mark DB failed → finish session → SSE → notify
 *   onSuccess  →  persist container → mark DB ready → finish session → SSE → notify
 *
 * This keeps the orchestrator focused on sequencing (build → deploy)
 * while all side-effects on completion live here.
 */

import { repos, type Project, type Deployment } from "@repo/db";
import { DockerRuntime, type LogEntry } from "@repo/adapters";
import type { RuntimeAdapter } from "@repo/adapters";
import { SYSTEM } from "@repo/core";
import { notification } from "../../lib/notification-dispatcher";
import { audit } from "../../lib/audit";
import * as sessionManager from "./session-manager";
import { detectAndStoreFavicon } from "../../lib/favicon-detector";
import {
  markWebmailInstalled,
  mailServerIdFromWebmailSlug,
} from "../mail/webmail/webmail-project.service";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LifecycleContext {
  /**
   * Optional - runtime is only touched when cleanup of a provisioned
   * image or service container is needed. Bespoke pipelines (e.g.
   * webmail) that don't go through `runtime.build` can omit it.
   */
  runtime?: RuntimeAdapter;
  project: Project;
  dep: Deployment;
  buildSessionId: string;
  /** Returns collapsed logs for DB persistence. */
  persistLogs: () => LogEntry[];
  /** Provisioned resources - set by the orchestrator as phases progress. */
  provisioned: { imageRef?: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateError(msg: string): string {
  const max = SYSTEM.DEPLOYMENTS.MAX_ERROR_MESSAGE_LENGTH;
  return msg.length > max ? msg.slice(0, max) + "…" : msg;
}

export async function cleanupBuildArtifact(
  runtime: RuntimeAdapter,
  artifactRef: string,
): Promise<void> {
  if (runtime instanceof DockerRuntime) {
    await runtime.removeImage(artifactRef);
    return;
  }

  await runtime.destroy(artifactRef);
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export async function onFailure(
  ctx: LifecycleContext,
  error?: string,
  durationMs?: number,
  errorMeta?: { errorCode?: string; errorDetails?: Record<string, unknown>; errorMessage?: string },
): Promise<void> {
  const { runtime, project, dep, buildSessionId, persistLogs, provisioned } = ctx;

  // 1. Force destroy provisioned resources - always delete the workspace/container
  //    on failure so the user doesn't have to manually clean up.
  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on failure:`,
        destroyErr,
      );
      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch((retryErr) => {
        console.error(
          `[DEPLOY] Retry destroy also failed for ${provisioned.imageRef}:`,
          retryErr,
        );
      });
    }
  }

  if (runtime) {
    const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
    for (const serviceDep of serviceDeps) {
      if (!serviceDep.containerId) continue;
      try {
        await runtime.destroy(serviceDep.containerId);
      } catch (destroyErr) {
        console.error(
          `[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on failure:`,
          destroyErr,
        );
      }
    }
  }

  // 2. Persist failure state
  const errorMessage = error ? truncateError(error) : undefined;
  const collapsed = persistLogs();
  await repos.deployment.updateStatus(dep.id, "failed", { errorMessage });
  await repos.deployment.finishBuildSession(buildSessionId, "failed", durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "failed", {
    ...errorMeta,
    errorMessage,
  });

  // 3. Notify — dispatch to every subscribed channel (per-user prefs +
  //    org defaults). Fire-and-forget: the dispatcher fans out across
  //    email/webhook/in-app/slack based on each member's subscriptions.
  const lastLogs = collapsed.slice(-50).map((l) => l.message).join("\n");
  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.failed",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      errorMessage: errorMessage ?? "Unknown error",
      logsTail: lastLogs,
      durationMs,
    },
  });

  // 4. Audit — async fire-and-forget; never blocks the failure path.
  // actorUserId is null here because the lifecycle runs in background;
  // the user who triggered the deploy is recorded on the original
  // `deployment.created` audit_event row.
  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null },
    {
      eventType: "deployment.failed",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: "failed",
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        errorMessage,
        durationMs,
      },
    },
  );
}

/** Find any owner of the org for notifications. */
async function findOrgOwnerForNotification(
  organizationId: string,
): Promise<{ email: string } | null> {
  const members = await repos.member.listByOrganization(organizationId).catch(() => []);
  const owner = members.find((m) => m.role === "owner") ?? members[0];
  if (!owner) return null;
  const user = await repos.user.findById(owner.userId).catch(() => null);
  return user?.email ? { email: user.email } : null;
}

export async function onCancelled(
  ctx: LifecycleContext,
  durationMs?: number,
): Promise<void> {
  const { runtime, dep, buildSessionId, persistLogs, provisioned } = ctx;

  // Force destroy provisioned resources
  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on cancel:`,
        destroyErr,
      );
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch(() => {});
    }
  }

  // Destroy service containers and broadcast failed status (mirrors onFailure)
  const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
  const services = serviceDeps.length > 0
    ? await repos.service.listByProject(dep.projectId).catch(() => [])
    : [];
  const serviceNameMap = new Map(services.map((s) => [s.id, s.name]));

  for (const serviceDep of serviceDeps) {
    if (runtime && serviceDep.containerId) {
      await runtime.destroy(serviceDep.containerId).catch((err) => {
        console.error(`[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on cancel:`, err);
      });
    }
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: serviceNameMap.get(serviceDep.serviceId) ?? serviceDep.serviceId,
      serviceId: serviceDep.serviceId,
      status: "failed",
      error: "Deployment cancelled",
    });
  }

  await repos.deployment.updateStatus(dep.id, "cancelled");
  await repos.deployment.finishBuildSession(buildSessionId, "cancelled", durationMs ?? 0, persistLogs());
  sessionManager.updateStatus(dep.id, "cancelled");
}

export async function onSuccess(
  ctx: LifecycleContext,
  result: {
    containerId: string;
    url?: string;
    durationMs: number;
    warningMessage?: string;
    metaPatch?: Record<string, unknown>;
  },
): Promise<void> {
  const { project, dep, buildSessionId, persistLogs } = ctx;

  await repos.deployment.setContainerId(dep.id, result.containerId, result.url);
  await repos.deployment.updateStatus(dep.id, "ready", {
    errorMessage: null,
    meta: result.metaPatch
      ? { ...((dep.meta as Record<string, unknown> | null) ?? {}), ...result.metaPatch }
      : dep.meta,
  });

  await repos.project.setActiveDeployment(project.id, dep.id);
  await repos.deployment.finishBuildSession(buildSessionId, "ready", result.durationMs, persistLogs());
  sessionManager.updateStatus(dep.id, "ready", {
    warningMessage: result.warningMessage,
  });

  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.succeeded",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      url: result.url,
      durationMs: result.durationMs,
    },
  });

  // Audit — async fire-and-forget. actorUserId null; the trigger
  // attribution lives on the original `deployment.created` row.
  // Records BOTH before and after for state transitions so an auditor
  // can see exactly what changed without joining the deployment table.
  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null },
    {
      eventType: "deployment.succeeded",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: "ready",
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        url: result.url,
        durationMs: result.durationMs,
      },
    },
  );

  // Async favicon detection - don't block the deploy response
  if (result.url) {
    void detectAndStoreFavicon(project.id, result.url);
  }

  // Webmail: flip mail-state `installed=true` so the /emails Open-webmail
  // CTA can finally surface. Slug is the only carrier of mailServerId
  // through the generic lifecycle - preserved by `ensureWebmailProject`.
  // For cloud deploys we also pass `result.url` so the success hook can
  // register an OpenResty proxy on the mail VPS pointing mail.<install>
  // → opsh.io (when that's the chosen hostname).
  if (project.framework === "webmail") {
    const mailServerId = mailServerIdFromWebmailSlug(project.slug);
    if (mailServerId) void markWebmailInstalled(mailServerId, result.url);
  }
}
