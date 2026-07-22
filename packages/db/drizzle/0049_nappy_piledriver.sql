ALTER TABLE "domain" ADD COLUMN "verify_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "last_verify_error" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "last_checked_at" timestamp;