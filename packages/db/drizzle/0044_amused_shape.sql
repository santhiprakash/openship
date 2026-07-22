ALTER TABLE "job" ALTER COLUMN "cron_expression" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "schedule_type" text DEFAULT 'recurring' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "run_at" timestamp;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "depends_on" text[];--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "trigger_events" text[];--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "notify_config" jsonb;--> statement-breakpoint
ALTER TABLE "job_run" ADD COLUMN "server_id" text;--> statement-breakpoint
ALTER TABLE "job_run" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;