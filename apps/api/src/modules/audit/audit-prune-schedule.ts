/**
 * Boot-time registration of the audit-log retention prune.
 *
 * Runs daily at 03:17 UTC (chosen off-peak; avoids the 0/30 minute marks
 * other jobs land on).
 */

import { getJobRunner } from "../../lib/job-runner";
import { pruneAuditEvents } from "./audit-prune";

const AUDIT_PRUNE_JOB_ID = "audit:retention-prune";
const AUDIT_PRUNE_CRON = "17 3 * * *";

export async function scheduleAuditPrune(): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: AUDIT_PRUNE_JOB_ID,
    cronExpression: AUDIT_PRUNE_CRON,
    onTick: async () => {
      try {
        const stats = await pruneAuditEvents();
        console.log(
          `[audit-prune] processed ${stats.orgsProcessed} orgs, pruned ${stats.totalPruned} batches`,
        );
      } catch (err) {
        console.error("[audit-prune] sweep failed", err);
      }
    },
  });
}
