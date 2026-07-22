CREATE TABLE "server_module_status" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"server_id" text NOT NULL,
	"module_name" text NOT NULL,
	"installed_version" text,
	"migration_version" text,
	"available_version" text,
	"behind" boolean DEFAULT false NOT NULL,
	"latest_in_progress" boolean DEFAULT false NOT NULL,
	"current_label" text,
	"latest_label" text,
	"detail" jsonb,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_module_status" ADD CONSTRAINT "server_module_status_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_module_status" ADD CONSTRAINT "server_module_status_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_server_module_status" ON "server_module_status" USING btree ("server_id","module_name");--> statement-breakpoint
CREATE INDEX "idx_server_module_status_org_behind" ON "server_module_status" USING btree ("organization_id","behind");