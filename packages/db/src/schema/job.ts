import { pgTable, text, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * job — generic scheduled-task DEFINITIONS (the schedule), reconciled onto the
 * shared JobRunner at boot. Distinct from `job_run` (execution history).
 *
 * One row per schedulable task:
 *   - system  built-in tasks (SSL renewal, orphan GC, prunes). Seeded from the
 *             code registry (SYSTEM_JOB_DEFS) with a default cron; the operator
 *             may retune cron / disable, but the action is code (resolved by
 *             `key`, not stored). Not operator-deletable.
 *   - custom  operator-defined (future): action stored in actionConfig (e.g. a
 *             shell command run via the executor). Deletable.
 *
 * `key` doubles as the runner jobId and the join key to job_run rows. Instance-
 * wide (self-hosted control plane), so no organizationId yet — custom per-org
 * jobs can add one.
 */
export const job = pgTable(
  "job",
  {
    id: text("id").primaryKey(),
    /** Stable key = runner jobId = job_run.jobId (e.g. "ssl:renew"). */
    key: text("key").notNull().unique(),
    kind: text("kind").notNull().default("system"),
    label: text("label").notNull(),
    /** Null for manual/once jobs (no recurring schedule). */
    cronExpression: text("cron_expression"),
    /** recurring (cron) | once (fire at runAt, then disable) | manual (only
     *  Run-now / dependencies / event triggers — never on a timer). */
    scheduleType: text("schedule_type").notNull().default("recurring"),
    /** One-time fire time (scheduleType = once); cleared once fired. */
    runAt: timestamp("run_at"),
    enabled: boolean("enabled").notNull().default(true),
    /** builtin (code action by key) | command (custom shell, future). */
    actionType: text("action_type").notNull().default("builtin"),
    /** Custom-job action params: { serverId?, serverIds?, command, timeoutMs?,
     *  retry?, env?, secrets? (encrypted) }. Null for builtin. */
    actionConfig: jsonb("action_config"),
    /** Job keys this job runs after (each on success). Null = no dependencies. */
    dependsOn: text("depends_on").array(),
    /** Audit eventTypes that fire this job (event triggers). Null = none. */
    triggerEvents: text("trigger_events").array(),
    /** Per-job notification override: { channels: string[], states: string[] }.
     *  Null = fall back to the global Settings→Notifications subscriptions. */
    notifyConfig: jsonb("notify_config"),
    /** Operator who created a custom job; null for seeded system jobs. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("job_kind_idx").on(t.kind)],
);
