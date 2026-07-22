/**
 * System jobs — the standard, observable way to run recurring instance-wide
 * tasks (SSL renewal, orphan GC, prunes, …).
 *
 * `scheduleSystemJob` registers a recurring job on the shared JobRunner AND
 * records every tick in `job_run`, so the task shows up in the Jobs read-model
 * (last run, outcome, duration) instead of running invisibly. Use it in place
 * of `runner.scheduleRecurring` for any built-in periodic task.
 *
 * `recordJobRun` is the same recording wrapper exposed directly, for a future
 * "Run now" (trigger:"manual") path.
 *
 * These are NOT the backup queue — backups keep their own run/policy tables.
 * This is scheduling + history for the code-defined system sweeps.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { getJobRunner } from "./job-runner";

/** A tick's outcome — a small JSON-able summary, or nothing. */
export type JobSummary = Record<string, unknown> | void;

/**
 * Run a job body once, wrapping it in a `job_run` history row: opens a
 * "running" row, then closes it "success" (+ summary + duration) or "failed"
 * (+ error). Re-throws so callers can react; the scheduler wrapper swallows to
 * keep the recurring tick alive.
 */
export async function recordJobRun(
  jobId: string,
  opts: { trigger?: "schedule" | "manual"; kind?: string },
  fn: () => Promise<JobSummary>,
): Promise<JobSummary> {
  const startedMs = Date.now();
  const run = await repos.jobRun.start({
    jobId,
    kind: opts.kind,
    trigger: opts.trigger ?? "schedule",
  });
  try {
    const summary = await fn();
    await repos.jobRun.finish(run.id, {
      status: "success",
      durationMs: Date.now() - startedMs,
      summary: summary && typeof summary === "object" ? summary : undefined,
    });
    return summary;
  } catch (err) {
    await repos.jobRun.finish(run.id, {
      status: "failed",
      durationMs: Date.now() - startedMs,
      error: safeErrorMessage(err),
    });
    throw err;
  }
}

/**
 * Register (or refresh) a recurring system job on the shared runner. Idempotent
 * per jobId. Every tick is recorded via recordJobRun; a failing tick is logged
 * and recorded but never crashes the runner.
 */
export async function scheduleSystemJob(opts: {
  jobId: string;
  cronExpression: string;
  run: () => Promise<JobSummary>;
}): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: opts.jobId,
    cronExpression: opts.cronExpression,
    onTick: async () => {
      try {
        await recordJobRun(opts.jobId, { trigger: "schedule" }, opts.run);
      } catch (err) {
        console.error(`[system-job] ${opts.jobId} failed:`, safeErrorMessage(err));
      }
    },
  });
}
