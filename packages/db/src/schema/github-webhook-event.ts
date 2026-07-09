import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ─── github_webhook_event ─────────────────────────────────────────────────────
// Idempotency table for inbound GitHub webhooks. The PK IS the GitHub delivery
// id (X-GitHub-Delivery), so an at-least-once redelivery hits a conflict and the
// handler short-circuits — dedup that survives restarts and spans replicas
// (unlike the old in-memory Set). processed_at stamps when the handler ran to
// completion. Mirrors stripe_webhook_event / oblien_webhook_event.
export const githubWebhookEvent = pgTable("github_webhook_event", {
  deliveryId: text("delivery_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
});
