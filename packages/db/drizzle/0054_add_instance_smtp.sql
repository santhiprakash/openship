ALTER TABLE "instance_settings" ADD COLUMN "smtp_host" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "smtp_port" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "smtp_user" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "smtp_password_encrypted" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "smtp_from" text;