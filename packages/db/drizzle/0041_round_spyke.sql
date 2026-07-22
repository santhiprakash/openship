ALTER TABLE "project" ADD COLUMN "is_app" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "app_template_id" text;--> statement-breakpoint
-- Backfill: existing webmail projects are managed apps → move them to the Apps tab.
UPDATE "project" SET "is_app" = true, "app_template_id" = 'mail-webmail' WHERE "framework" = 'webmail';