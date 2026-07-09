CREATE TABLE "github_webhook_event" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
