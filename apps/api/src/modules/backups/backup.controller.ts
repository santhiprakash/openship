/**
 * HTTP handlers for backups: policy CRUD, list runs, manual trigger.
 * Webhook + cron triggers land in Chunk 2; their handlers will live
 * in this file alongside the manual one.
 */

import type { Context } from "hono";
import crypto from "node:crypto";
import { repos } from "@repo/db";
import { getUserId, getActiveOrganizationId, assertResourceInOrg, param } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { streamSSE } from "../../lib/sse";
import { triggerManualBackup } from "./triggers/manual";
import { backupRunBus } from "./backup.sse";
import { restoreRunBus } from "./restore.sse";
import { restoreOrchestrator } from "./restore.orchestrator";
import { safeErrorMessage } from "@repo/core";
import {
  createPolicy,
  deletePolicy,
  getRun,
  listPoliciesByProject,
  listRunsForProject,
  updatePolicy,
  type UpdatePolicyPatch,
} from "./backup.service";

// ─── Policies ────────────────────────────────────────────────────────────────

export async function listProjectPolicies(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const projectId = param(c, "projectId");
  await permission.assert(c, { resourceType: "project", resourceId: projectId, action: "read" });
  try {
    const policies = await listPoliciesByProject(projectId, organizationId);
    return c.json({ data: policies });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function createProjectPolicy(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const projectId = param(c, "projectId");
  await permission.assert(c, { resourceType: "project", resourceId: projectId, action: "write" });
  const body = await c.req.json<{
    serviceId?: string | null;
    destinationId: string;
    cronExpression?: string;
    triggerOnPreDeploy?: boolean;
    retainCount?: number;
    retainDays?: number;
    payloadKind?: string;
    payloadConfig?: Record<string, unknown>;
    preHook?: string;
    postHook?: string;
    enabled?: boolean;
  }>();
  if (!body.destinationId) {
    return c.json({ error: "destinationId is required" }, 400);
  }
  try {
    const policy = await createPolicy(userId, organizationId, {
      projectId,
      serviceId: body.serviceId ?? null,
      destinationId: body.destinationId,
      cronExpression: body.cronExpression,
      triggerOnPreDeploy: body.triggerOnPreDeploy,
      retainCount: body.retainCount,
      retainDays: body.retainDays,
      payloadKind: body.payloadKind,
      payloadConfig: body.payloadConfig,
      preHook: body.preHook,
      postHook: body.postHook,
      enabled: body.enabled,
    });
    return c.json({ data: policy });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function patchPolicy(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const policyId = param(c, "policyId");
  // Derive parent projectId for the permission gate. Restricted users
  // need a grant on the project; the policy doesn't have a grant root
  // of its own.
  const existing = await repos.backupPolicy.findById(policyId);
  if (existing?.projectId) {
    await permission.assert(c, {
      resourceType: "project",
      resourceId: existing.projectId,
      action: "write",
    });
  }
  const raw = (await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}))) as Record<string, unknown>;

  // Pluck only the fields UpdatePolicyPatch knows about. updatePolicy
  // also allow-lists internally, but doing it here gives a clean 400
  // for malformed input and prevents unknown fields from making it
  // into application state at all.
  const patch: UpdatePolicyPatch = {};
  const allowed: Array<keyof UpdatePolicyPatch> = [
    "cronExpression",
    "triggerOnPreDeploy",
    "enableWebhook",
    "rotateWebhookToken",
    "retainCount",
    "retainDays",
    "payloadKind",
    "payloadConfig",
    "preHook",
    "postHook",
    "hookTimeoutSeconds",
    "enabled",
    "destinationId",
  ];
  for (const key of allowed) {
    if (key in raw) {
      (patch as Record<string, unknown>)[key as string] = raw[key as string];
    }
  }

  try {
    const policy = await updatePolicy(policyId, organizationId, patch);
    return c.json({ data: policy });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function removePolicy(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const policyId = param(c, "policyId");
  // Derive parent projectId — delete is an admin-level mutation on the
  // parent project's resource tree.
  const existing = await repos.backupPolicy.findById(policyId);
  if (existing?.projectId) {
    await permission.assert(c, {
      resourceType: "project",
      resourceId: existing.projectId,
      action: "admin",
    });
  }
  try {
    await deletePolicy(policyId, organizationId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export async function listRuns(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const projectId = param(c, "projectId");
  await permission.assert(c, { resourceType: "project", resourceId: projectId, action: "read" });
  const serviceId = c.req.query("serviceId");
  const limit = Number(c.req.query("limit") ?? "50");
  try {
    const runs = await listRunsForProject(projectId, organizationId, {
      limit: Number.isFinite(limit) ? limit : 50,
      serviceId,
    });
    return c.json({ data: runs });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function getOneRun(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const runId = param(c, "runId");
  await permission.assert(c, { resourceType: "backup_run", resourceId: runId, action: "read" });
  try {
    const run = await getRun(runId, organizationId);
    return c.json({ data: run });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

/**
 * GET /api/backup-runs/:runId/stream
 *
 * SSE channel for run progress. Sends a `snapshot` event with the
 * current DB row immediately, then live `transition` / `progress` /
 * `complete` events as they fire from the orchestrator. Identical
 * shape to the deployment SSE channel — survives reload because the
 * DB row is authoritative.
 */
export async function streamRun(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const runId = param(c, "runId");
  await permission.assert(c, { resourceType: "backup_run", resourceId: runId, action: "read" });

  // Ownership check before opening the stream.
  let initial;
  try {
    initial = await getRun(runId, organizationId);
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }

  return streamSSE(c, async (stream) => {
    // Initial snapshot — clients can render the full row immediately
    // without waiting for the next event.
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({ type: "snapshot", run: initial }),
    });

    // If the run already terminated, close immediately.
    const TERMINAL = ["succeeded", "failed", "cancelled", "server_error"];
    if (TERMINAL.includes(initial.status)) {
      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({ type: "complete", status: initial.status }),
      });
      return;
    }

    // Otherwise wire into the bus.
    const events: import("./backup.sse").BackupRunEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    const unsubscribe = backupRunBus.subscribe(runId, (ev) => {
      events.push(ev);
      resolveWaiter?.();
    });

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      unsubscribe();
      resolveWaiter?.();
    });

    try {
      while (!aborted) {
        if (events.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWaiter = resolve;
          });
          resolveWaiter = null;
        }
        const drained = events.splice(0, events.length);
        let terminal = false;
        for (const ev of drained) {
          await stream.writeSSE({
            event: ev.type,
            data: JSON.stringify(ev),
          });
          if (ev.type === "complete") terminal = true;
        }
        if (terminal) break;
      }
    } finally {
      unsubscribe();
    }
  });
}

// ─── Manual trigger ──────────────────────────────────────────────────────────

export async function triggerManual(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const policyId = param(c, "policyId");
  // Derive parent projectId — running a backup is a write on the project.
  const policy = await repos.backupPolicy.findById(policyId);
  if (policy?.projectId) {
    await permission.assert(c, {
      resourceType: "project",
      resourceId: policy.projectId,
      action: "write",
    });
  }
  const clientIp = c.var.clientIp ?? undefined;
  try {
    const { runId } = await triggerManualBackup({ policyId, userId, organizationId, clientIp });
    return c.json({ data: { runId } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

// ─── Restore ─────────────────────────────────────────────────────────────────

/**
 * POST /api/backup-runs/:runId/restore/prepare
 * Returns { restoreId, confirmationToken }. The token must be echoed
 * back on the apply call — protects against accidental re-submits.
 */
export async function prepareRestore(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const runId = param(c, "runId");
  // Restore prep is a destructive admin op against the run's destination.
  await permission.assert(c, { resourceType: "backup_run", resourceId: runId, action: "admin" });
  const clientIp = c.var.clientIp ?? undefined;

  // Ownership check (org-scoped).
  const run = await repos.backupRun.findById(runId);
  try {
    assertResourceInOrg(run, "Backup run", organizationId, runId);
  } catch {
    return c.json({ error: "Backup run not found" }, 404);
  }

  const confirmationToken = crypto.randomBytes(8).toString("hex");
  try {
    const { restoreId } = await restoreOrchestrator.beginPrepare({
      runId,
      trigger: { source: "manual", userId, clientIp },
      confirmationToken,
    });
    return c.json({ data: { restoreId, confirmationToken } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/**
 * POST /api/backup-restores/:restoreId/apply
 * Body: { confirmationToken }
 */
export async function applyRestore(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(c, { resourceType: "backup_restore", resourceId: restoreId, action: "admin" });
  const body = await c.req
    .json<{ confirmationToken?: string }>()
    .catch(() => ({} as { confirmationToken?: string }));
  if (!body.confirmationToken) {
    return c.json({ error: "confirmationToken is required" }, 400);
  }
  try {
    await restoreOrchestrator.apply(restoreId, body.confirmationToken, userId, organizationId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/** POST /api/backup-restores/:restoreId/cancel */
export async function cancelRestore(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(c, { resourceType: "backup_restore", resourceId: restoreId, action: "admin" });
  try {
    await restoreOrchestrator.cancel(restoreId, userId, organizationId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

/** GET /api/backup-restores/:restoreId */
export async function getOneRestore(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(c, { resourceType: "backup_restore", resourceId: restoreId, action: "read" });
  const row = await repos.backupRestore.findById(restoreId);
  try {
    assertResourceInOrg(row, "Restore", organizationId, restoreId);
  } catch {
    return c.json({ error: "Restore not found" }, 404);
  }
  return c.json({ data: row });
}

/**
 * GET /api/backup-restores/:restoreId/stream
 * SSE channel for restore progress. Same shape as backup-runs/:id/stream.
 */
export async function streamRestore(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const restoreId = param(c, "restoreId");
  await permission.assert(c, { resourceType: "backup_restore", resourceId: restoreId, action: "read" });
  const initial = await repos.backupRestore.findById(restoreId);
  try {
    assertResourceInOrg(initial, "Restore", organizationId, restoreId);
  } catch {
    return c.json({ error: "Restore not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({ type: "snapshot", restore: initial }),
    });

    const TERMINAL = ["succeeded", "failed", "cancelled", "server_error"];
    if (TERMINAL.includes(initial.status)) {
      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({ type: "complete", status: initial.status }),
      });
      return;
    }

    const events: import("./restore.sse").RestoreRunEvent[] = [];
    let waiter: (() => void) | null = null;
    const unsubscribe = restoreRunBus.subscribe(restoreId, (ev) => {
      events.push(ev);
      waiter?.();
    });

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      unsubscribe();
      waiter?.();
    });

    try {
      while (!aborted) {
        if (events.length === 0) {
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
          waiter = null;
        }
        const drained = events.splice(0, events.length);
        let terminal = false;
        for (const ev of drained) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          if (ev.type === "complete") terminal = true;
        }
        if (terminal) break;
      }
    } finally {
      unsubscribe();
    }
  });
}

// ─── Protect-from-retention ──────────────────────────────────────────────────

/**
 * POST /api/backup-runs/:runId/protect
 * Body: { until?: ISO string, protected?: boolean }
 * - protected:true with no `until` = locked forever (well, until 2099).
 * - protected:false clears the lock so retention prune can drop it.
 */
export async function protectRun(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const runId = param(c, "runId");
  await permission.assert(c, { resourceType: "backup_run", resourceId: runId, action: "write" });
  const body = await c.req
    .json<{ until?: string; protected?: boolean }>()
    .catch(() => ({} as { until?: string; protected?: boolean }));

  const run = await repos.backupRun.findById(runId);
  try {
    assertResourceInOrg(run, "Backup run", organizationId, runId);
  } catch {
    return c.json({ error: "Backup run not found" }, 404);
  }

  let lockedUntil: Date | null = null;
  if (body.protected === false) {
    lockedUntil = null;
  } else if (body.until) {
    const parsed = new Date(body.until);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: "Invalid 'until' timestamp" }, 400);
    }
    lockedUntil = parsed;
  } else if (body.protected === true || body.protected === undefined) {
    lockedUntil = new Date("2099-12-31T23:59:59.000Z");
  }

  await repos.backupRun.setRetentionLock(runId, lockedUntil);
  return c.json({ data: { ok: true, retentionLockedUntil: lockedUntil?.toISOString() ?? null } });
}
