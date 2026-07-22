import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import type { RouteRuleSpec } from "@repo/core";
import { organization } from "./organization";
import { project } from "./project";
import { domain } from "./domain";

// ─── Route rules ───────────────────────────────────────────────────────────────

/**
 * Per-route edge rules (rate-limit, ban, allow/deny) for the self-hosted
 * OpenResty guard. The DB is the source of truth; the API serializes each
 * project's rules and pushes them into OpenResty's `rules` shared dict via the
 * mgmt API (reload-free), where `rules_guard.lua` enforces them in the access
 * phase. Complements the per-server global rate-limit (the box-wide ceiling),
 * which stays a native `limit_req` snippet.
 *
 * Scope: a rule applies to `domainId` (a specific hostname) or, when null, to
 * ALL of the project's hostnames; `pathPrefix` narrows it to a path (null/"/" =
 * whole host). 1:N per project/host/path, hence its own table (the flexible
 * rule body is the `spec` JSONB, matching the `service.advanced` idiom).
 */
export const routeRule = pgTable("route_rule", {
  id: text("id").primaryKey(), // "rr_..."
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** Specific hostname this rule targets; null = every hostname of the project. */
  domainId: text("domain_id").references(() => domain.id, { onDelete: "cascade" }),
  /** Path-prefix scope (null / "/" = the whole host). */
  pathPrefix: text("path_prefix"),
  /** The rule body — see RouteRuleSpec (rate-limit, ban, allow/deny). */
  spec: jsonb("spec").$type<RouteRuleSpec>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_route_rule_project").on(t.projectId),
  index("idx_route_rule_domain").on(t.domainId),
]);
