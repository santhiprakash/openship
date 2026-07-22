CREATE TABLE "billing_usage_snapshot" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"balance" double precision,
	"credits_used" double precision,
	"cpu_time_minutes" double precision,
	"memory_gb_minutes" double precision,
	"disk_io_gb" double precision,
	"network_gb" double precision,
	"period_start" timestamp,
	"period_end" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_usage_snapshot" ADD CONSTRAINT "billing_usage_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;