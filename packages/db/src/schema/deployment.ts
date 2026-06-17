import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { project } from "./project";
import { organization } from "./organization";

// ─── Deployments ─────────────────────────────────────────────────────────────

/**
 * Deployment records. Each deployment represents a single build → deploy cycle.
 * Many deployments belong to one project. Only one is "active" at a time.
 */
export const deployment = pgTable("deployment", {
  id: text("id").primaryKey(), // "dep_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** Org that owns this deployment — THE access primitive. Actor info
   *  (who triggered the deploy) flows through audit_event. */
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),

  /* ── Git snapshot ───────────────────────────────────────────────────── */
  branch: text("branch").notNull(),
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),
  /** What triggered this deployment: manual | webhook | redeploy */
  trigger: text("trigger").notNull().default("manual"),

  /* ── Build details ──────────────────────────────────────────────────── */
  /** Environment: production | preview */
  environment: text("environment").notNull().default("production"),
  /** Detected or configured framework */
  framework: text("framework"),
  /** Build status */
  status: text("status").notNull().default("queued"),
  /** Image/snapshot reference produced by build */
  imageRef: text("image_ref"),
  /** Build duration in milliseconds */
  buildDurationMs: integer("build_duration_ms"),

  /* ── Container details ──────────────────────────────────────────────── */
  /** Adapter container ID (for stop/start/destroy) */
  containerId: text("container_id"),
  /** External URL where deployment is reachable */
  url: text("url"),

  /* ── Metadata ───────────────────────────────────────────────────────── */
  /** JSON: snapshot of build config used for this deployment */
  meta: jsonb("meta"),
  /** JSON: encrypted environment variables snapshot for this deployment */
  envVars: jsonb("env_vars"),
  /** Error message if failed */
  errorMessage: text("error_message"),

  /* ── Rollback / retention ───────────────────────────────────────────── */
  /**
   * Set by the rollback orchestrator when the artifact is archived
   * (preserved in non-active state for potential rollback). Nulled when
   * the artifact is purged. Read by the dashboard as "is this deployment
   * still rollbackable?". Only the orchestrator writes this column.
   */
  artifactRetainedAt: timestamp("artifact_retained_at"),
  /**
   * User-tagged "keep this version rollbackable indefinitely". Pinned
   * deployments are exempt from the orchestrator's retention prune
   * (project.rollbackWindow). Hard-capped per project via
   * instance_settings.maxPinnedDeployments to bound disk usage.
   */
  pinned: boolean("pinned").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // At most ONE in-flight deployment per project. The race-prone
  // pattern (SELECT-then-INSERT inside checkNoActiveBuild +
  // createQueuedDeployment) is replaced by relying on this constraint:
  // concurrent webhook deliveries both try the INSERT, only one wins,
  // the other's unique-violation is caught by the caller and reported
  // as "another build already in progress."
  uniqueIndex("uq_deployment_one_active_per_project")
    .on(t.projectId)
    .where(sql`status IN ('queued', 'building', 'deploying')`),
]);

// ─── Build sessions ──────────────────────────────────────────────────────────

/**
 * Build session tracking - used for SSE log streaming.
 * A build session maps 1:1 with a deployment during the build phase.
 * Logs are stored here for replay after the session ends.
 */
export const buildSession = pgTable("build_session", {
  id: text("id").primaryKey(), // "bld_..."
  deploymentId: text("deployment_id")
    .notNull()
    .references(() => deployment.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),

  /** Build session status */
  status: text("status").notNull().default("queued"),
  /** JSON array of log entries for replay */
  logs: jsonb("logs"),
  /** Build duration in milliseconds */
  durationMs: integer("duration_ms"),

  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
