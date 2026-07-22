CREATE TABLE "docker_migration_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_server_id" text,
	"target_server_id" text,
	"project_id" text,
	"project_name" text NOT NULL,
	"service_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'cross_server' NOT NULL,
	"deployment_id" text,
	"kill_originals" boolean DEFAULT false NOT NULL,
	"confirmation_token" text,
	"volume_plan" jsonb DEFAULT '[]'::jsonb,
	"scanned_container_ids" jsonb DEFAULT '{}'::jsonb,
	"bytes_moved" bigint,
	"error_message" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"last_event_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docker_migration_run" ADD CONSTRAINT "docker_migration_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_migration_run" ADD CONSTRAINT "docker_migration_run_source_server_id_servers_id_fk" FOREIGN KEY ("source_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_migration_run" ADD CONSTRAINT "docker_migration_run_target_server_id_servers_id_fk" FOREIGN KEY ("target_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_migration_run" ADD CONSTRAINT "docker_migration_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_docker_migration_run_org_started" ON "docker_migration_run" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_docker_migration_run_in_flight" ON "docker_migration_run" USING btree ("status") WHERE "docker_migration_run"."status" IN ('queued','adopting','moving_data','deploying','verifying','awaiting_cutover','cutover');