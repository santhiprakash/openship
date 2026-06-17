/**
 * Manual trigger — "Backup now" button. The simplest of the four
 * trigger types: a user hits an HTTP endpoint, we build a
 * BackupTrigger value, and the orchestrator does the rest.
 *
 * Authorization: route layer guarantees the caller belongs to the
 * active organization. We re-verify org-scope on both the policy's
 * project and the destination before enqueueing.
 */

import { repos } from "@repo/db";
import { assertResourceInOrg } from "../../../lib/controller-helpers";
import { backupOrchestrator } from "../backup.orchestrator";

export async function triggerManualBackup(opts: {
  policyId: string;
  userId: string;
  organizationId: string;
  clientIp?: string;
}): Promise<{ runId: string }> {
  const policy = await repos.backupPolicy.findById(opts.policyId);
  if (!policy) {
    throw new Error("Backup policy not found");
  }
  const project = await repos.project.findById(policy.projectId);
  try {
    assertResourceInOrg(project, "Backup policy", opts.organizationId, opts.policyId);
  } catch {
    throw new Error("Backup policy not found"); // hide existence
  }
  const destination = await repos.backupDestination.findById(policy.destinationId);
  try {
    assertResourceInOrg(
      destination,
      "Backup destination",
      opts.organizationId,
      policy.destinationId,
    );
  } catch {
    throw new Error("Backup destination not accessible");
  }

  return backupOrchestrator.enqueue({
    policyId: opts.policyId,
    trigger: {
      source: "manual",
      userId: opts.userId,
      clientIp: opts.clientIp,
    },
  });
}
