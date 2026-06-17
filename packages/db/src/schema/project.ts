import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./organization";
import { service } from "./service";

// ─── Project apps ────────────────────────────────────────────────────────────

/**
 * Parent grouping for deployable project environments.
 *
 * Product language can keep calling this a "Project". The existing `project`
 * table remains the deployable environment instance that owns deployments,
 * domains, env vars, logs, analytics, and runtime settings.
 */
export const projectApp = pgTable("project_app", {
  id: text("id").primaryKey(), // "app_..."
  /** Org that owns this app — THE access primitive. Creator info lives
   *  in audit_event (event_type='project.create'). */
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),

  /** Display name shared by all environments */
  name: text("name").notNull(),
  /** URL-safe slug shared by the app */
  slug: text("slug").notNull(),

  /** Shared source identity */
  gitProvider: text("git_provider").default("github"),
  gitOwner: text("git_owner"),
  gitRepo: text("git_repo"),
  gitUrl: text("git_url"),
  installationId: integer("installation_id"),

  /** Shared favicon cache */
  favicon: text("favicon"),
  faviconCheckedAt: timestamp("favicon_checked_at"),

  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Projects ────────────────────────────────────────────────────────────────

/**
 * Deployable project environment. Each row is one isolated runtime target
 * under a project app, e.g. Production on main or Development on develop.
 * It owns deployments, domains, env vars, logs, analytics, and runtime settings.
 */
export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(), // "proj_..."
    /** Org that owns this project — THE access primitive. Creator info
     *  lives in audit_event (event_type='project.create'). */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => projectApp.id, { onDelete: "cascade" }),

    /** Display name (e.g. "My Next App") */
    name: text("name").notNull(),
    /** URL-safe slug derived from name */
    slug: text("slug").notNull(),

    /* ── Environment identity ─────────────────────────────────────────── */
    /** Display label for this deployable environment */
    environmentName: text("environment_name").notNull().default("Production"),
    /** Stable URL-safe environment key */
    environmentSlug: text("environment_slug").notNull().default("production"),
    /** Environment class */
    environmentType: text("environment_type").notNull().default("production"),

    /* ── Source ───────────────────────────────────────────────────────────── */
    /** Absolute path on disk for locally-imported projects */
    localPath: text("local_path"),

    /* ── Git source ─────────────────────────────────────────────────────── */
    /** Git provider ("github" | "gitlab" | "bitbucket" | "local") */
    gitProvider: text("git_provider").default("github"),
    /** Owner/org on the git provider */
    gitOwner: text("git_owner"),
    /** Repo name on the git provider */
    gitRepo: text("git_repo"),
    /** Default branch to deploy from */
    gitBranch: text("git_branch").default("main"),
    /** Full clone URL */
    gitUrl: text("git_url"),
    /** Installation ID for GitHub App access */
    installationId: integer("installation_id"),
    /**
     * Per-project clone-token override (encrypted via lib/encryption).
     * When set, this is the first credential `resolveCloneToken` returns -
     * highest priority in the chain. Users add this in the project's
     * Resources tab when they want to scope a Fine-Grained PAT or PAT-like
     * credential to just this project.
     */
    cloneTokenEncrypted: text("clone_token_encrypted"),
    /** Timestamp of last update (for UI "last set X ago"). Null if cleared. */
    cloneTokenSetAt: timestamp("clone_token_set_at"),

    /* ── Build configuration ────────────────────────────────────────────── */
    /** Detected framework (nextjs, vite, node, static, etc.) */
    framework: text("framework").default("unknown"),
    /** Package manager (npm, yarn, pnpm, bun) */
    packageManager: text("package_manager").default("npm"),
    /** Custom install command override */
    installCommand: text("install_command"),
    /** Custom build command override */
    buildCommand: text("build_command"),
    /** Build output directory */
    outputDirectory: text("output_directory"),
    /** Files/directories needed at runtime (JSON string array, e.g. [".next","node_modules","package.json"]) */
    productionPaths: text("production_paths"),
    /** Root directory within the repo (for monorepos) */
    rootDirectory: text("root_directory"),
    /** Start command for production runtime */
    startCommand: text("start_command"),
    /** Docker image for build environment (e.g. node:22, oven/bun:latest) */
    buildImage: text("build_image"),
    /** Production mode: host, static, standalone */
    productionMode: text("production_mode").default("host"),
    /** Port the app listens on */
    port: integer("port").default(3000),
    /** Whether the project needs a running server (false = static site, deployed via Pages) */
    hasServer: boolean("has_server").notNull().default(true),
    /** Whether the project needs a build step (false = deploy source files directly) */
    hasBuild: boolean("has_build").notNull().default(true),

    /**
     * Shared install command run once at the repo root before any per-app build.
     * Only used when projectType === "monorepo" (e.g. "pnpm install -w").
     *
     * TODO: currently WRITE-ONLY - project-crud persists it but the build
     * pipeline doesn't wire it into the workspace install step yet. Either
     * thread it through createMonorepoSourceBuildConfig as a pre-install hook
     * or drop the column in a follow-up migration. Today the runtime falls
     * back to project.installCommand for monorepo sub-apps.
     */
    workspaceInstallCommand: text("workspace_install_command"),

    /* ── Resources (VM-native format) ───────────────────────────────────── */
    /** JSON: { cpuCores, memoryMb } */
    resources: jsonb("resources"),
    /** JSON: build-specific resource overrides */
    buildResources: jsonb("build_resources"),
    /** Sleep mode: auto_sleep | always_on */
    sleepMode: text("sleep_mode").default("auto_sleep"),
    /** Number of previous successful releases to retain for rollback (null = use instance default) */
    rollbackWindow: integer("rollback_window"),
    /**
     * How Cloud deployments preserve their rollback artifact:
     *   - "inplace"  → Oblien `snapshots.createArchive` + `workspace.stop`.
     *                  Disk + archive remain attached to the workspace;
     *                  compute paused. Rollback starts it back up.
     *   - "offload"  → Reserved for future self-hosted external-S3
     *                  shipping. Not implemented on Openship Cloud.
     *
     * Bare/Docker runtimes ignore this column.
     */
    cloudArchiveStrategy: text("cloud_archive_strategy").notNull().default("inplace"),

    /* ── State ──────────────────────────────────────────────────────────── */
    /** Currently active deployment ID */
    activeDeploymentId: text("active_deployment_id"),
    /** GitHub webhook ID registered on the repo */
    webhookId: integer("webhook_id"),
    /** Domain hostname used for receiving GitHub webhooks (null = edge relay or none) */
    webhookDomain: text("webhook_domain"),
    /** Whether pushes to the branch trigger auto-deploy */
    autoDeploy: boolean("auto_deploy").notNull().default(false),
    /** Auto-detected favicon URL from the deployed site */
    favicon: text("favicon"),
    /** Last time favicon detection was attempted for this project */
    faviconCheckedAt: timestamp("favicon_checked_at"),
    /** Soft delete */
    deletedAt: timestamp("deleted_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_project_app_environment_slug_active")
      .on(table.appId, table.environmentSlug)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// ─── Environment variables ───────────────────────────────────────────────────

/**
 * Per-project environment variables.
 * Values are encrypted at rest (application-level encryption).
 * Each var can be scoped to specific environments.
 */
export const envVar = pgTable("env_var", {
  id: text("id").primaryKey(), // "env_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** Service ID for service-scoped env vars (null = project-level / all services) */
  serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),

  /** Variable key (e.g. "DATABASE_URL") */
  key: text("key").notNull(),
  /** Encrypted value */
  value: text("value").notNull(),
  /** Environments where this var is active */
  environment: text("environment").notNull().default("production"), // production | preview | development

  /** Preview-only: don't include in production builds */
  isSecret: boolean("is_secret").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Env resolution runs on every build — covers project + service +
  // environment filtering used by buildPipelineEnv.
  index("idx_env_var_project_env_service").on(t.projectId, t.environment, t.serviceId),
  // Backup / restore reads all vars for a project.
  index("idx_env_var_project").on(t.projectId),
]);
