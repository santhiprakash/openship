ALTER TABLE "deployment" ADD COLUMN "release_version" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "release_source" jsonb;