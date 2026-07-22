CREATE TABLE "github_deploy_key" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"github_key_id" integer,
	"private_key_encrypted" text NOT NULL,
	"public_key" text NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_github_auth" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"mode" text NOT NULL,
	"token_encrypted" text,
	"token_source" text,
	"token_login" text,
	"server_key_private_encrypted" text,
	"server_key_public" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_deploy_key" ADD CONSTRAINT "github_deploy_key_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_deploy_key" ADD CONSTRAINT "github_deploy_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_github_auth" ADD CONSTRAINT "server_github_auth_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_github_auth" ADD CONSTRAINT "server_github_auth_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_github_deploy_key_server_repo" ON "github_deploy_key" USING btree ("server_id","owner","repo");--> statement-breakpoint
CREATE INDEX "idx_github_deploy_key_org_server" ON "github_deploy_key" USING btree ("organization_id","server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_server_github_auth_server" ON "server_github_auth" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_server_github_auth_org" ON "server_github_auth" USING btree ("organization_id");