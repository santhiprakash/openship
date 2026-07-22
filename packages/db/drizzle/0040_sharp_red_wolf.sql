CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text DEFAULT 'system' NOT NULL,
	"label" text NOT NULL,
	"cron_expression" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"action_type" text DEFAULT 'builtin' NOT NULL,
	"action_config" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "job_kind_idx" ON "job" USING btree ("kind");