CREATE TABLE "personal_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "personal_access_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "personal_access_token_user_idx" ON "personal_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "personal_access_token_prefix_idx" ON "personal_access_token" USING btree ("token_prefix");