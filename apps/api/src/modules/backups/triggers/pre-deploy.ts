/**
 * Pre-deploy trigger — fires after a successful build but BEFORE the
 * destructive cutover (`runtime.destroy(previous.containerId)` inside
 * compose/deploy.service.ts). The snapshot therefore captures the
 * OLD container's state — which is exactly the rollback safety net
 * the toggle promises.
 *
 * Wired into apps/api/src/modules/deployments/build.service.ts at
 * the `runDeploy()` step, immediately before `runDeployPipeline()`.
 * Iterates every enabled policy for the project with
 * `trigger_on_pre_deploy = true` and enqueues one backup run per
 * policy.
 *
 * Call-site contract: the caller MUST `await firePreDeployBackups(...)`
 * before invoking the destructive deploy step. We only block on the
 * enqueue (durable INSERT of backup_run rows), not on the runs
 * themselves — a slow or failing backup must not block the deploy.
 *
 * Semantics:
 *   - Best-effort. Failures are LOGGED but do NOT block the deploy.
 *   - Per-policy queueing: a project with 5 services each having
 *     pre-deploy backups fires 5 jobs. They run in parallel up to the
 *     worker's concurrency cap, alongside the new deploy.
 *   - The orchestrator records `trigger: 'pre_deploy'` so the dashboard
 *     can group these in the run list.
 *   - Rollback and redeploy paths intentionally do NOT call this
 *     trigger — the rollback orchestrator preserves the previous
 *     artifact natively, so no extra snapshot is needed.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "../../../lib/safe-error";
import { backupOrchestrator } from "../backup.orchestrator";

export async function firePreDeployBackups(opts: {
  projectId: string;
  organizationId: string;
}): Promise<{ enqueued: number; failed: number }> {
  let enqueued = 0;
  let failed = 0;

  try {
    const policies = await repos.backupPolicy.listEnabledPreDeployByProject(opts.projectId);
    // The pre-deploy backup runs are attributed to the policy creator,
    // not a specific user (the deploy may have been triggered by anyone
    // with project:write). The orchestrator pulls policy.createdBy when
    // trigger.userId is unset.
    for (const policy of policies) {
      try {
        await backupOrchestrator.enqueue({
          policyId: policy.id,
          trigger: {
            source: "pre_deploy",
            userId: policy.createdBy ?? "system",
          },
        });
        enqueued += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[pre-deploy-backup] policy ${policy.id} enqueue failed: ${safeErrorMessage(err)}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[pre-deploy-backup] failed to load policies for project ${opts.projectId}: ${safeErrorMessage(err)}`,
    );
  }

  return { enqueued, failed };
}
