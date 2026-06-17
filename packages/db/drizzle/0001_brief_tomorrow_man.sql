-- Schema hardening: drop legacy organization_meta (folded into organization.is_team),
-- add missing FKs + indexes flagged by the enterprise audit, and the partial
-- unique index that race-guards concurrent deployment creation.
--
-- All statements are idempotent so re-running on DBs already partway through
-- the consolidation succeeds. Greenfield installs apply the same SQL with the
-- IF (NOT) EXISTS guards as no-op when conditions are met.

DROP TABLE IF EXISTS "organization_meta" CASCADE;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "is_team" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- FK: domain.service_id → service.id (CASCADE delete to prevent stale routing)
DO $$ BEGIN
  ALTER TABLE "domain" ADD CONSTRAINT "domain_service_id_service_id_fk"
    FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- FK: env_var.service_id → service.id (CASCADE delete to prevent orphan env vars)
DO $$ BEGIN
  ALTER TABLE "env_var" ADD CONSTRAINT "env_var_service_id_service_id_fk"
    FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Race guard: only one in-flight deployment per project. The race-prone
-- (SELECT-then-INSERT) in build.service.ts now relies on this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deployment_one_active_per_project"
  ON "deployment" USING btree ("project_id")
  WHERE status IN ('queued', 'building', 'deploying');--> statement-breakpoint

-- Routing hot path — every hostname lookup hits the (project_id) and
-- (project_id, hostname) indexes.
CREATE INDEX IF NOT EXISTS "idx_domain_project" ON "domain" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_domain_project_hostname" ON "domain" USING btree ("project_id","hostname");--> statement-breakpoint

-- Env var resolution runs on every build.
CREATE INDEX IF NOT EXISTS "idx_env_var_project_env_service" ON "env_var" USING btree ("project_id","environment","service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_env_var_project" ON "env_var" USING btree ("project_id");--> statement-breakpoint

-- GitHub App installation lookup: unique (provider, owner, user_id) backs
-- atomic onConflictDoUpdate; (organization_id, provider, owner) backs the
-- org-scoped resolution path used by every authed request that mints an
-- installation token.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_git_installation_provider_owner_user" ON "git_installation" USING btree ("provider","owner","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_git_installation_org" ON "git_installation" USING btree ("organization_id","provider","owner");--> statement-breakpoint

-- Build pipeline + deployment setup iterate services per project.
CREATE INDEX IF NOT EXISTS "idx_service_project_id" ON "service" USING btree ("project_id");
