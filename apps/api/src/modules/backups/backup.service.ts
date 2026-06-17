/**
 * Backup service — thin CRUD over policies + runs.
 *
 * The orchestrator owns the FSM. This file owns the per-org
 * ownership / authorization checks and the dashboard query shapes
 * (list runs by project, etc.). userId is preserved as a forensic
 * "actor" stamp on writes (createdBy etc.) but org membership is the
 * authorization gate.
 */

import { repos } from "@repo/db";
import crypto from "node:crypto";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { syncPolicySchedule, removePolicySchedule, validateCronExpression } from "./triggers/cron";
import { generateWebhookToken } from "./triggers/webhook";

// ─── Policy CRUD ─────────────────────────────────────────────────────────────

export async function listPoliciesByProject(projectId: string, organizationId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  return repos.backupPolicy.listByProject(projectId);
}

export async function createPolicy(
  userId: string,
  organizationId: string,
  data: {
    projectId: string;
    serviceId: string | null;
    destinationId: string;
    cronExpression?: string;
    triggerOnPreDeploy?: boolean;
    enableWebhook?: boolean;
    retainCount?: number;
    retainDays?: number;
    payloadKind?: string;
    payloadConfig?: Record<string, unknown>;
    preHook?: string;
    postHook?: string;
    enabled?: boolean;
  },
) {
  const project = await repos.project.findById(data.projectId);
  assertResourceInOrg(project, "Project", organizationId, data.projectId);
  const destination = await repos.backupDestination.findById(data.destinationId);
  assertResourceInOrg(destination, "Destination", organizationId, data.destinationId);

  // Cron validation upfront — otherwise saving an invalid cron silently
  // disables the schedule when the cron-trigger reconciler skips it.
  if (data.cronExpression) {
    const check = validateCronExpression(data.cronExpression);
    if (!check.valid) {
      throw new Error(`Invalid cron expression: ${check.reason ?? "unknown"}`);
    }
  }

  const id = `bkp_${crypto.randomUUID()}`;
  const row = await repos.backupPolicy.create({
    id,
    projectId: data.projectId,
    serviceId: data.serviceId,
    destinationId: data.destinationId,
    enabled: data.enabled ?? true,
    cronExpression: data.cronExpression ?? null,
    triggerOnPreDeploy: data.triggerOnPreDeploy ?? false,
    webhookToken: data.enableWebhook ? generateWebhookToken() : null,
    retainCount: data.retainCount ?? null,
    retainDays: data.retainDays ?? null,
    payloadKind: data.payloadKind ?? "auto",
    payloadConfig: data.payloadConfig ?? {},
    preHook: data.preHook ?? null,
    postHook: data.postHook ?? null,
    createdBy: userId,
  });

  // Register the cron schedule (no-op when cronExpression is null).
  await syncPolicySchedule(row.id);
  return row;
}

/**
 * Allow-listed update fields. Anything NOT on this list cannot be
 * altered through PATCH — specifically projectId, serviceId,
 * createdBy, webhookToken, deletedAt. The audit found a mass-
 * assignment bug where the controller spread the raw body into the
 * DB write, letting an attacker repoint their own policy at a
 * victim's project/service and exfiltrate via the webhook trigger.
 *
 * This shape is the ONLY input accepted by updatePolicy. The
 * controller passes through unknown fields are silently dropped.
 */
export interface UpdatePolicyPatch {
  cronExpression?: string | null;
  triggerOnPreDeploy?: boolean;
  enableWebhook?: boolean;
  rotateWebhookToken?: boolean;
  retainCount?: number | null;
  retainDays?: number | null;
  payloadKind?: string;
  payloadConfig?: Record<string, unknown>;
  preHook?: string | null;
  postHook?: string | null;
  hookTimeoutSeconds?: number;
  enabled?: boolean;
  destinationId?: string;
}

export async function updatePolicy(
  policyId: string,
  organizationId: string,
  patch: UpdatePolicyPatch,
) {
  const policy = await repos.backupPolicy.findById(policyId);
  if (!policy) throw new Error("Policy not found");
  const project = await repos.project.findById(policy.projectId);
  assertResourceInOrg(project, "Policy", organizationId, policyId);

  if (patch.destinationId) {
    const destination = await repos.backupDestination.findById(patch.destinationId);
    assertResourceInOrg(destination, "Destination", organizationId, patch.destinationId);
  }

  if (patch.cronExpression) {
    const check = validateCronExpression(patch.cronExpression);
    if (!check.valid) {
      throw new Error(`Invalid cron expression: ${check.reason ?? "unknown"}`);
    }
  }

  // Build an EXPLICIT allow-listed dbPatch. Never copy the raw input
  // object — that's the mass-assignment vuln. Each field is named
  // individually; projectId / serviceId / createdBy / webhookToken /
  // deletedAt cannot reach the DB write from this path.
  const dbPatch: Parameters<typeof repos.backupPolicy.update>[1] = {};
  if (patch.cronExpression !== undefined) dbPatch.cronExpression = patch.cronExpression;
  if (patch.triggerOnPreDeploy !== undefined) dbPatch.triggerOnPreDeploy = patch.triggerOnPreDeploy;
  if (patch.retainCount !== undefined) dbPatch.retainCount = patch.retainCount;
  if (patch.retainDays !== undefined) dbPatch.retainDays = patch.retainDays;
  if (patch.payloadKind !== undefined) dbPatch.payloadKind = patch.payloadKind;
  if (patch.payloadConfig !== undefined) dbPatch.payloadConfig = patch.payloadConfig;
  if (patch.preHook !== undefined) dbPatch.preHook = patch.preHook;
  if (patch.postHook !== undefined) dbPatch.postHook = patch.postHook;
  if (patch.hookTimeoutSeconds !== undefined) dbPatch.hookTimeoutSeconds = patch.hookTimeoutSeconds;
  if (patch.enabled !== undefined) dbPatch.enabled = patch.enabled;
  if (patch.destinationId !== undefined) dbPatch.destinationId = patch.destinationId;

  // Webhook is a synthesized field — enableWebhook/rotate flags
  // translate to a controlled webhookToken write. The flags themselves
  // never reach the DB.
  if (patch.enableWebhook === false) {
    dbPatch.webhookToken = null;
  } else if (patch.enableWebhook === true && !policy.webhookToken) {
    dbPatch.webhookToken = generateWebhookToken();
  } else if (patch.rotateWebhookToken && policy.webhookToken) {
    dbPatch.webhookToken = generateWebhookToken();
  }

  const updated = await repos.backupPolicy.update(policyId, dbPatch);
  await syncPolicySchedule(policyId);
  return updated;
}

export async function deletePolicy(policyId: string, organizationId: string) {
  const policy = await repos.backupPolicy.findById(policyId);
  if (!policy) return;
  const project = await repos.project.findById(policy.projectId);
  assertResourceInOrg(project, "Policy", organizationId, policyId);
  await repos.backupPolicy.softDelete(policyId);
  // Drop the BullMQ repeat schedule.
  await removePolicySchedule(policyId);
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export async function listRunsForProject(
  projectId: string,
  organizationId: string,
  opts?: { limit?: number; serviceId?: string },
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  return repos.backupRun.listByOrganization(organizationId, {
    limit: opts?.limit,
    projectId,
    serviceId: opts?.serviceId,
  });
}

export async function getRun(runId: string, organizationId: string) {
  const run = await repos.backupRun.findById(runId);
  assertResourceInOrg(run, "Run", organizationId, runId);
  return run;
}
