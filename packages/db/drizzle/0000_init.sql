CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_destination" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"server_id" text,
	"endpoint" text,
	"region" text,
	"bucket" text,
	"path_prefix" text,
	"ssh_host" text,
	"ssh_port" integer,
	"ssh_user" text,
	"access_key_id_enc" text,
	"secret_access_key_enc" text,
	"sftp_password_enc" text,
	"sftp_private_key_enc" text,
	"sftp_key_passphrase_enc" text,
	"last_verified_at" timestamp,
	"last_verify_error" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"service_id" text,
	"destination_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text,
	"trigger_on_pre_deploy" boolean DEFAULT false NOT NULL,
	"webhook_token" text,
	"webhook_last_fired_at" timestamp,
	"retain_count" integer,
	"retain_days" integer,
	"payload_kind" text DEFAULT 'auto' NOT NULL,
	"payload_config" jsonb DEFAULT '{}'::jsonb,
	"pre_hook" text,
	"post_hook" text,
	"hook_timeout_seconds" integer DEFAULT 300 NOT NULL,
	"compression_algo" text DEFAULT 'zstd' NOT NULL,
	"encryption_at_rest" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_restore" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"project_id" text,
	"service_id" text,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'in_place' NOT NULL,
	"fork_service_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"last_event_at" timestamp DEFAULT now() NOT NULL,
	"bytes_restored" bigint,
	"error_message" text,
	"client_ip" text,
	"confirmation_token" text
);
--> statement-breakpoint
CREATE TABLE "backup_run" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text,
	"destination_id" text,
	"project_id" text,
	"service_id" text,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"triggered_by" text NOT NULL,
	"triggered_by_user_id" text,
	"client_ip" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"last_event_at" timestamp DEFAULT now() NOT NULL,
	"object_key_prefix" text,
	"manifest_key" text,
	"bytes_transferred" bigint,
	"artifacts" jsonb DEFAULT '[]'::jsonb,
	"error_message" text,
	"hook_log" text,
	"retention_locked_until" timestamp,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "build_session" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"logs" jsonb,
	"duration_ms" integer,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_handoff_code" (
	"code" text PRIMARY KEY NOT NULL,
	"user_data" jsonb NOT NULL,
	"session_token" text NOT NULL,
	"code_challenge" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text,
	"commit_message" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"framework" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"image_ref" text,
	"build_duration_ms" integer,
	"container_id" text,
	"url" text,
	"meta" jsonb,
	"env_vars" jsonb,
	"error_message" text,
	"artifact_retained_at" timestamp,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"service_id" text,
	"hostname" text NOT NULL,
	"target_port" integer,
	"target_path" text,
	"domain_type" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verification_token" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"ssl_status" text DEFAULT 'none' NOT NULL,
	"ssl_issuer" text,
	"ssl_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domain_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "env_var" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"service_id" text,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"installation_id" integer NOT NULL,
	"owner" text NOT NULL,
	"owner_type" text DEFAULT 'User' NOT NULL,
	"provider_user_id" text,
	"provider_owner_id" text,
	"is_org" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"tunnel_provider" text,
	"tunnel_token" text,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"default_build_mode" text DEFAULT 'auto' NOT NULL,
	"default_rollback_window" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation_pending_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"permissions_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_servers" (
	"server_id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"installed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_default" (
	"organization_id" text NOT NULL,
	"category" text NOT NULL,
	"default_enabled" boolean DEFAULT true NOT NULL,
	"default_channel_kind" text DEFAULT 'email' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"audit_event_id" text,
	"category" text NOT NULL,
	"channel_id" text,
	"channel_kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"seen_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "notification_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"category" text NOT NULL,
	"channel_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"metadata" text,
	"is_team" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"environment_name" text DEFAULT 'Production' NOT NULL,
	"environment_slug" text DEFAULT 'production' NOT NULL,
	"environment_type" text DEFAULT 'production' NOT NULL,
	"local_path" text,
	"git_provider" text DEFAULT 'github',
	"git_owner" text,
	"git_repo" text,
	"git_branch" text DEFAULT 'main',
	"git_url" text,
	"installation_id" integer,
	"clone_token_encrypted" text,
	"clone_token_set_at" timestamp,
	"framework" text DEFAULT 'unknown',
	"package_manager" text DEFAULT 'npm',
	"install_command" text,
	"build_command" text,
	"output_directory" text,
	"production_paths" text,
	"root_directory" text,
	"start_command" text,
	"build_image" text,
	"production_mode" text DEFAULT 'host',
	"port" integer DEFAULT 3000,
	"has_server" boolean DEFAULT true NOT NULL,
	"has_build" boolean DEFAULT true NOT NULL,
	"workspace_install_command" text,
	"resources" jsonb,
	"build_resources" jsonb,
	"sleep_mode" text DEFAULT 'auto_sleep',
	"rollback_window" integer,
	"cloud_archive_strategy" text DEFAULT 'inplace' NOT NULL,
	"active_deployment_id" text,
	"webhook_id" integer,
	"webhook_domain" text,
	"auto_deploy" boolean DEFAULT false NOT NULL,
	"favicon" text,
	"favicon_checked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_app" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"git_provider" text DEFAULT 'github',
	"git_owner" text,
	"git_repo" text,
	"git_url" text,
	"installation_id" integer,
	"favicon" text,
	"favicon_checked_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"permissions_json" text DEFAULT '[]' NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"domain" text NOT NULL,
	"minute" integer NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"unique_requests" integer DEFAULT 0 NOT NULL,
	"bandwidth_in" integer DEFAULT 0 NOT NULL,
	"bandwidth_out" integer DEFAULT 0 NOT NULL,
	"response_time" real DEFAULT 0 NOT NULL,
	"countries" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_analytics_geo" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"domain" text NOT NULL,
	"day" text NOT NULL,
	"countries" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"name" text,
	"ssh_host" text NOT NULL,
	"ssh_port" integer DEFAULT 22,
	"ssh_user" text DEFAULT 'root',
	"ssh_auth_method" text,
	"ssh_password" text,
	"ssh_key_path" text,
	"ssh_key_passphrase" text,
	"ssh_jump_host" text,
	"ssh_args" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text DEFAULT 'compose' NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"build" text,
	"dockerfile" text,
	"ports" jsonb DEFAULT '[]'::jsonb,
	"depends_on" jsonb DEFAULT '[]'::jsonb,
	"environment" jsonb DEFAULT '{}'::jsonb,
	"volumes" jsonb DEFAULT '[]'::jsonb,
	"command" text,
	"restart" text DEFAULT 'unless-stopped',
	"exposed" boolean DEFAULT false NOT NULL,
	"exposed_port" text,
	"domain" text,
	"custom_domain" text,
	"domain_type" text DEFAULT 'free',
	"root_directory" text,
	"install_command" text,
	"build_command" text,
	"start_command" text,
	"output_directory" text,
	"framework" text,
	"package_manager" text,
	"build_image" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"service_id" text NOT NULL,
	"container_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"image_ref" text,
	"host_port" integer,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"service_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"exit_code" integer,
	"exit_reason" text,
	"client_ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"exit_code" integer,
	"exit_reason" text,
	"client_ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"auto_provisioned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"build_mode" text DEFAULT 'auto' NOT NULL,
	"cloud_session_token" text,
	"default_deploy_target" text,
	"default_server_id" text,
	"clone_token_encrypted" text,
	"clone_token_set_at" timestamp,
	"clone_token_as_default" boolean DEFAULT false NOT NULL,
	"clone_strategy_preference" text DEFAULT 'prompt' NOT NULL,
	"github_cli_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_destination" ADD CONSTRAINT "backup_destination_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_destination_id_backup_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destination"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_run_id_backup_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backup_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_destination_id_backup_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destination"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_fork_service_id_service_id_fk" FOREIGN KEY ("fork_service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_policy_id_backup_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backup_policy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_destination_id_backup_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destination"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_triggered_by_user_id_user_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_session" ADD CONSTRAINT "build_session_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_session" ADD CONSTRAINT "build_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_installation" ADD CONSTRAINT "git_installation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_pending_grant" ADD CONSTRAINT "invitation_pending_grant_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_default" ADD CONSTRAINT "notification_default_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_audit_event_id_audit_event_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_channel_id_notification_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscription" ADD CONSTRAINT "notification_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscription" ADD CONSTRAINT "notification_subscription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_subscription" ADD CONSTRAINT "notification_subscription_channel_id_notification_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_app_id_project_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."project_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_app" ADD CONSTRAINT "project_app_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_granted_by_user_id_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_analytics" ADD CONSTRAINT "server_analytics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_analytics_geo" ADD CONSTRAINT "server_analytics_geo_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_deployment" ADD CONSTRAINT "service_deployment_deployment_id_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_deployment" ADD CONSTRAINT "service_deployment_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_terminal_sessions" ADD CONSTRAINT "service_terminal_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_terminal_sessions" ADD CONSTRAINT "service_terminal_sessions_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_org_created_idx" ON "audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_org_type_idx" ON "audit_event" USING btree ("organization_id","event_type");--> statement-breakpoint
CREATE INDEX "audit_event_org_actor_idx" ON "audit_event" USING btree ("organization_id","actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_event_resource_idx" ON "audit_event" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_destination_org_name_active" ON "backup_destination" USING btree ("organization_id","name") WHERE "backup_destination"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_backup_destination_org" ON "backup_destination" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_policy_project_service" ON "backup_policy" USING btree ("project_id","service_id") WHERE "backup_policy"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_policy_webhook_token" ON "backup_policy" USING btree ("webhook_token") WHERE "backup_policy"."webhook_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_backup_policy_project" ON "backup_policy" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_backup_policy_destination" ON "backup_policy" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "idx_backup_restore_org_started" ON "backup_restore" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_backup_restore_run" ON "backup_restore" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_backup_run_org_started" ON "backup_run" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_backup_run_destination_started" ON "backup_run" USING btree ("destination_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_backup_run_project_started" ON "backup_run" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_backup_run_in_flight" ON "backup_run" USING btree ("status") WHERE "backup_run"."status" IN ('queued','preparing','snapshotting','uploading','verifying');--> statement-breakpoint
CREATE INDEX "cloud_handoff_code_expires_idx" ON "cloud_handoff_code" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "invitation_org_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitation_pending_grant_invitation_idx" ON "invitation_pending_grant" USING btree ("invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_unique" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "member_org_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_user_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notification_channel_user" ON "notification_channel" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_default_org_category" ON "notification_default" USING btree ("organization_id","category");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_user_created" ON "notification_delivery" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_queued" ON "notification_delivery" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_org_created" ON "notification_delivery" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_subscription_unique" ON "notification_subscription" USING btree ("user_id","organization_id","category","channel_id");--> statement-breakpoint
CREATE INDEX "idx_notification_subscription_dispatch" ON "notification_subscription" USING btree ("organization_id","category","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_app_environment_slug_active" ON "project" USING btree ("app_id","environment_slug") WHERE "project"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_grant_unique" ON "resource_grant" USING btree ("organization_id","user_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_grant_member_idx" ON "resource_grant" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "resource_grant_resource_idx" ON "resource_grant" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_analytics_server_domain_minute" ON "server_analytics" USING btree ("server_id","domain","minute");--> statement-breakpoint
CREATE INDEX "idx_analytics_domain_minute" ON "server_analytics" USING btree ("domain","minute");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_analytics_geo_server_domain_day" ON "server_analytics_geo" USING btree ("server_id","domain","day");--> statement-breakpoint
CREATE INDEX "service_terminal_sessions_user_idx" ON "service_terminal_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "service_terminal_sessions_service_idx" ON "service_terminal_sessions" USING btree ("service_id","started_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_user_idx" ON "terminal_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_server_idx" ON "terminal_sessions" USING btree ("server_id","started_at");