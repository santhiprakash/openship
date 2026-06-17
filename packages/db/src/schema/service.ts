import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { deployment } from "./deployment";

// ─── Services ────────────────────────────────────────────────────────────────

/**
 * Deployable units within a project.
 *
 * Two flavors share this table, discriminated by the `kind` column:
 *
 *   - `kind = "compose"` - a docker-compose service (image / Dockerfile + ports).
 *     The original use case. Build/start commands come from the Dockerfile or
 *     image, so the build/install/start columns below stay null.
 *
 *   - `kind = "monorepo"` - a sub-app inside a monorepo. Each row carries the
 *     full single-app build config (rootDirectory, install/build/start
 *     commands, port, framework). N rows live under one project that shares
 *     one workspace install at the repo root.
 *
 * Routing / env scoping / multi-service deploy fan-out is identical for both
 * kinds, so the existing infrastructure (buildServiceRouteDomain, envVar.serviceId,
 * MultiServiceRuntimeAdapter) works for monorepo apps without forking.
 */
export const service = pgTable("service", {
  id: text("id").primaryKey(), // "svc_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),

  /** Discriminator: "compose" (docker-compose service) | "monorepo" (sub-app in a workspace) */
  kind: text("kind").notNull().default("compose"),

  /** Service name (from compose, e.g. "web", "db", "redis") - also used as hostname on the network */
  name: text("name").notNull(),
  /** Docker image (e.g. "postgres:16", "redis:7-alpine") - null if service is built from source */
  image: text("image"),
  /** Build context path relative to repo root (e.g. ".", "./services/api") - null if using a pre-built image */
  build: text("build"),
  /** Dockerfile path relative to build context - null to use default "Dockerfile" */
  dockerfile: text("dockerfile"),

  /* ── Networking ─────────────────────────────────────────────────────── */
  /** JSON array of port mappings (e.g. ["8080:3000", "5432"]) */
  ports: jsonb("ports").$type<string[]>().default([]),
  /** JSON array of service names this service depends on */
  dependsOn: jsonb("depends_on").$type<string[]>().default([]),

  /* ── Configuration ──────────────────────────────────────────────────── */
  /** JSON object of environment variables (non-secret defaults from compose) */
  environment: jsonb("environment").$type<Record<string, string>>().default({}),
  /** JSON array of volume mounts (e.g. ["pgdata:/var/lib/postgresql/data"]) */
  volumes: jsonb("volumes").$type<string[]>().default([]),
  /** Override command */
  command: text("command"),
  /** Restart policy: no | always | on-failure | unless-stopped */
  restart: text("restart").default("unless-stopped"),

  /* ── Public routing ─────────────────────────────────────────────── */
  /** Whether this service should be exposed publicly through routing */
  exposed: boolean("exposed").notNull().default(false),
  /** Container port to expose publicly */
  exposedPort: text("exposed_port"),
  /** Free subdomain label for managed routing */
  domain: text("domain"),
  /** Custom domain bound directly to this service */
  customDomain: text("custom_domain"),
  /** Whether the service uses a free or custom domain */
  domainType: text("domain_type").default("free"),

  /* ── Monorepo sub-app config (kind === "monorepo" only) ────────────── */
  /** Sub-app root directory inside the repo (e.g. "apps/web"). Null for compose. */
  rootDirectory: text("root_directory"),
  /** Per-app install command (run after the shared workspace install). Null for compose. */
  installCommand: text("install_command"),
  /** Per-app build command. Null for compose. */
  buildCommand: text("build_command"),
  /** Per-app start command - what the long-running workload runs. Null for compose. */
  startCommand: text("start_command"),
  /** Build output directory relative to the sub-app's root. Null for compose. */
  outputDirectory: text("output_directory"),
  /** Detected framework (e.g. "nextjs", "vite"). Null for compose. */
  framework: text("framework"),
  /** Package manager (npm/pnpm/yarn/bun). Null for compose. */
  packageManager: text("package_manager"),
  /** Build image / runtime base (e.g. "node:22"). Null for compose. */
  buildImage: text("build_image"),

  /* ── State ──────────────────────────────────────────────────────────── */
  /** Whether this service should be deployed (allows disabling individual services) */
  enabled: boolean("enabled").notNull().default(true),
  /** Display / dependency order (lower = deployed first) */
  sortOrder: integer("sort_order").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Build pipeline + deployment setup iterate services per project.
  index("idx_service_project_id").on(t.projectId),
]);

// ─── Service deployments ─────────────────────────────────────────────────────

/**
 * Per-service container state within a deployment.
 * A project deployment fans out into one serviceDeployment per enabled service.
 */
export const serviceDeployment = pgTable("service_deployment", {
  id: text("id").primaryKey(), // "sd_..."
  deploymentId: text("deployment_id")
    .notNull()
    .references(() => deployment.id, { onDelete: "cascade" }),
  serviceId: text("service_id")
    .notNull()
    .references(() => service.id, { onDelete: "cascade" }),

  /** Docker container ID */
  containerId: text("container_id"),
  /** Container status: running | stopped | failed | building */
  status: text("status").notNull().default("pending"),
  /** Resolved image reference (pulled or built) */
  imageRef: text("image_ref"),
  /** Mapped host port */
  hostPort: integer("host_port"),
  /** Internal network IP */
  ip: text("ip"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
