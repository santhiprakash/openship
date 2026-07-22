/**
 * Event triggers — fire a custom job when a platform event happens (a deploy
 * finishes, a backup fails, …). The hook lives on `notification.emit` (see
 * notification-dispatcher): every emitted eventType is offered here, and any
 * enabled job whose `triggerEvents` contains it is fired in the background.
 *
 * The curated `JOB_TRIGGER_EVENTS` list is the controlled vocabulary the UI
 * shows and the schema validates against — it mirrors the notifiable events, so
 * whatever a user can be notified on, they can also trigger a job on.
 *
 * A tiny in-memory `armed` set (rebuilt from the job table on boot + on every
 * create/update/delete) makes the per-emit check O(1): if no job listens for an
 * eventType we return immediately without touching the DB, so hooking the hot
 * emit path stays free.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { startCommandRun } from "./job-command";

export interface JobTriggerEvent {
  id: string;
  label: string;
  description: string;
}

/** Controlled vocabulary of triggerable events (the notifiable eventTypes). */
export const JOB_TRIGGER_EVENTS: readonly JobTriggerEvent[] = [
  { id: "deployment.succeeded", label: "Deploy succeeded", description: "A production deploy finished successfully." },
  { id: "deployment.failed", label: "Deploy failed", description: "A build or deploy errored out." },
  { id: "backup_run.succeeded", label: "Backup succeeded", description: "A scheduled or manual backup completed." },
  { id: "backup_run.failed", label: "Backup failed", description: "A backup run errored out." },
  { id: "backup_restore.completed", label: "Restore completed", description: "A restore finished." },
  { id: "ssl.renewal_failed", label: "SSL renewal failed", description: "A certificate could not be renewed." },
  { id: "domain.verification_failed", label: "Domain verification failed", description: "A domain's DNS check failed." },
] as const;

export const JOB_TRIGGER_EVENT_IDS = new Set(JOB_TRIGGER_EVENTS.map((e) => e.id));

/** eventTypes that at least one enabled job currently listens for. O(1) gate so
 *  the emit hot path skips the DB scan when nobody's listening. */
let armed = new Set<string>();

/** Rebuild the armed set from the job table. Call on boot + after any job
 *  create/update/delete. Best-effort — failures leave the prior set in place. */
export async function refreshTriggerArm(): Promise<void> {
  try {
    const jobs = await repos.job.listAll();
    const next = new Set<string>();
    for (const j of jobs) {
      if (!j.enabled) continue;
      for (const e of j.triggerEvents ?? []) next.add(e);
    }
    armed = next;
  } catch (err) {
    console.warn(`[job-events] arm refresh failed: ${safeErrorMessage(err)}`);
  }
}

/** Fire every enabled job that listens for `eventType`. Fire-and-forget; called
 *  from notification.emit for each emitted event. Cheap no-op when unarmed. */
export function fireJobTriggers(eventType: string): void {
  if (!armed.has(eventType)) return;
  void (async () => {
    try {
      const jobs = await repos.job.listAll();
      for (const job of jobs) {
        if (job.enabled && job.actionType === "command" && (job.triggerEvents ?? []).includes(eventType)) {
          await startCommandRun(job, "event");
        }
      }
    } catch (err) {
      console.warn(`[job-events] trigger dispatch failed for ${eventType}: ${safeErrorMessage(err)}`);
    }
  })();
}
