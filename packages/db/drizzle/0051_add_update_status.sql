CREATE TABLE "update_status" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
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
ALTER TABLE "update_status" ADD CONSTRAINT "update_status_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_status" ADD CONSTRAINT "update_status_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_update_status_project" ON "update_status" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_update_status_org_behind" ON "update_status" USING btree ("organization_id","behind");