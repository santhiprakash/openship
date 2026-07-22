import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * Platform status notices — operator-pushed banners shown across the app
 * (mainly the managed SaaS: partial outage, degraded service, maintenance,
 * upgrade advisories). Served by GET /api/notices and rendered by the SAME
 * shared advisory banner as GitHub release advisories (components/updates).
 *
 * Distinct from those release advisories: self-hosted/desktop PULL advisories
 * from the public GitHub manifest (pinned to a release tag); these are dynamic,
 * operator-controlled, and effective immediately (no redeploy). Written via an
 * internal-token-gated endpoint (the platform operator), read by every client.
 */
export const systemNotice = pgTable(
  "system_notice",
  {
    id: text("id").primaryKey(), // "ntc_..."
    /** critical | recommended | info — drives the banner color/icon + the
     *  "critical always shows" rule (mirrors AdvisorySeverity in @repo/core). */
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    /** Optional call-to-action (e.g. a status-page link). */
    actionLabel: text("action_label"),
    actionUrl: text("action_url"),
    /**
     * Optional scope. `platform` (default/null) = a global announcement; `app`/
     * `project`/`mail` + `targetId` scope the notice to one entity so the
     * operator can push e.g. "n8n has a critical CVE — update" to just that app.
     * Mirrors AdvisoryTarget in @repo/core.
     */
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Operator toggle — only active notices are served. */
    active: boolean("active").notNull().default(true),
    /** Optional display window; a null bound is open-ended. A notice is served
     *  only when `now` is within [startsAt, endsAt]. */
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_system_notice_active").on(t.active)],
);
