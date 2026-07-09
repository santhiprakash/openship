CREATE TABLE "cloud_webhook_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cloud_project_id" text NOT NULL,
	"git_owner" text NOT NULL,
	"git_repo" text NOT NULL,
	"git_branch" text DEFAULT '' NOT NULL,
	"webhook_id" integer,
	"webhook_secret" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_webhook_binding" ADD CONSTRAINT "cloud_webhook_binding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_webhook_binding_repo_branch" ON "cloud_webhook_binding" USING btree ("git_owner","git_repo","git_branch");--> statement-breakpoint
CREATE INDEX "idx_cloud_webhook_binding_cloud_project" ON "cloud_webhook_binding" USING btree ("cloud_project_id");