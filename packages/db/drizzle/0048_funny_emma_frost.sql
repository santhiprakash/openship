ALTER TABLE "user_settings" ADD COLUMN "transfer_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "transfer_compression" text DEFAULT 'auto' NOT NULL;