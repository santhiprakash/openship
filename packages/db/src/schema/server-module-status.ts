import { pgTable, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { servers } from "./servers";
import { organization } from "./organization";

/**
 * Cached drift + migration state for a native module installed on a server —
 * one row per (server, module). The sibling of `update_status`, but keyed by
 * server/module instead of project: `update_status` tracks project deployments;
 * this tracks host infra (OpenResty, later certbot/node/docker).
 *
 * The `modules:scan` job probes each server's on-box version and compares it to
 * the verified catalog, upserting the outcome so the server's Components tab can
 * render "vX → vY, Update" without re-probing. The on-box manifest
 * (/etc/openship/modules/<module>.json) is the source of truth on the host; this
 * is the org-visible cache.
 *
 * `organizationId` is nullable because `servers.organizationId` is nullable
 * (org-less servers exist); the org+behind index tolerates NULL.
 */
export const serverModuleStatus = pgTable(
  "server_module_status",
  {
    id: text("id").primaryKey(), // "sms_..."
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    /** Module identity, e.g. "openresty". */
    moduleName: text("module_name").notNull(),
    /** Detected native binary version on the box (informational). */
    installedVersion: text("installed_version"),
    /** On-box manifest migrationVersion (last fully-applied catalog version). */
    migrationVersion: text("migration_version"),
    /** Catalog `latest` — the version the box could reach. */
    availableVersion: text("available_version"),
    /** True when the box is behind the catalog (auto-pending or consent-pending). */
    behind: boolean("behind").notNull().default(false),
    /** A migration apply is already running — suppress duplicate nudges. */
    latestInProgress: boolean("latest_in_progress").notNull().default(false),
    currentLabel: text("current_label"),
    latestLabel: text("latest_label"),
    /** { appliedSteps, pendingConsent: [{id,version,warning}], catalogRef, serial, lastError }. */
    detail: jsonb("detail"),
    checkedAt: timestamp("checked_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_server_module_status").on(t.serverId, t.moduleName),
    index("idx_server_module_status_org_behind").on(t.organizationId, t.behind),
  ],
);
