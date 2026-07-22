/**
 * Billing tables — Stripe ↔ Oblien quota bridge.
 *
 * Quota is owned by Oblien (the runtime meters consumption directly and
 * enforces `setQuota` limits). These tables only persist the Stripe-side
 * state needed to compute and push that quota:
 *
 *   stripe webhook → billing_customer / billing_subscription rows updated
 *     → tier change recorded against the org → Oblien `setQuota` call
 *     pushes the new absolute quota for the org's namespace.
 *
 * Tables:
 *   - billing_customer            per-org Stripe customer mapping
 *   - billing_subscription        per-org Stripe subscription history
 *   - credit_pack                 catalog of one-shot top-up SKUs
 *   - stripe_webhook_event        idempotency table for Stripe webhook delivery
 *   - stripe_topup_grant          per-checkout-session topup credit grants
 *                                 (idempotency: Stripe retries don't double-credit)
 *   - billing_anniversary_grant   per-period anniversary cron grants
 *                                 (idempotency: cron crash mid-tick doesn't re-zero)
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  doublePrecision,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── billing_customer ────────────────────────────────────────────────────────
// Per-org Stripe customer mapping. Unique on organization_id — one customer
// per org. Stripe customer id captured + uniqued so a webhook delivered for
// the wrong org can be rejected at the DB layer.

export const billingCustomer = pgTable(
  "billing_customer",
  {
    id: text("id").primaryKey(), // "bc_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_billing_customer_org").on(table.organizationId),
    uniqueIndex("uq_billing_customer_stripe").on(table.stripeCustomerId),
  ],
);

// ─── billing_subscription ────────────────────────────────────────────────────
// Per-org Stripe subscription history. Historical rows are kept (cancellation
// doesn't delete, just updates status), hence the (org_id) index — orgs may
// have multiple rows over time and we routinely query "subs for this org".

export const billingSubscription = pgTable(
  "billing_subscription",
  {
    id: text("id").primaryKey(), // "bs_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    /** 'free' | 'pro' | 'team' | 'enterprise' */
    planTierId: text("plan_tier_id").notNull(),
    /** 'monthly' | 'annual' */
    interval: text("interval").notNull(),
    /** Mirrors Stripe sub.status verbatim. */
    status: text("status").notNull(),
    currentPeriodStart: timestamp("current_period_start").notNull(),
    currentPeriodEnd: timestamp("current_period_end").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_billing_subscription_stripe").on(table.stripeSubscriptionId),
    index("idx_billing_subscription_org").on(table.organizationId),
  ],
);

// ─── credit_pack ─────────────────────────────────────────────────────────────
// Catalog of one-shot top-up SKUs surfaced in the dashboard. Stripe price id
// is uniqued so the webhook can resolve a checkout-completion event back to
// a row deterministically.

export const creditPack = pgTable(
  "credit_pack",
  {
    id: text("id").primaryKey(), // "cp_..."
    name: text("name").notNull(),
    creditsMilli: bigint("credits_milli", { mode: "number" }).notNull(),
    priceCents: integer("price_cents").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    uniqueIndex("uq_credit_pack_stripe_price").on(table.stripePriceId),
  ],
);

// ─── stripe_webhook_event ────────────────────────────────────────────────────
// Idempotency table for inbound Stripe webhooks. The id IS the Stripe event
// id, so re-delivery of the same event hits a PK conflict and the handler
// short-circuits. processed_at is set when the handler runs to completion.

export const stripeWebhookEvent = pgTable("stripe_webhook_event", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
});

// ─── oblien_webhook_event ────────────────────────────────────────────────────
// Idempotency table for inbound Oblien webhooks. Mirrors stripe_webhook_event
// 1:1 — Oblien's event_id is the PK so re-delivery hits a conflict and the
// handler short-circuits. processed_at stamps when the handler ran to
// completion. The Postgres advisory-lock pattern from billing.webhooks.ts
// is reused on top of this table so concurrent deliveries of the same event
// serialize cleanly.

export const oblienWebhookEvent = pgTable("oblien_webhook_event", {
  oblienEventId: text("oblien_event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
});

// ─── stripe_topup_grant ──────────────────────────────────────────────────────
// Per-checkout-session topup credit grants. Existence of a row keyed by
// checkout_session_id PROVES the grant was already applied to Oblien quota.
// Why: `addQuota` is read-modify-write against Oblien (current + delta), so
// re-running it on a Stripe webhook retry would compound (double-credit).
// We `INSERT … ON CONFLICT DO NOTHING` BEFORE the Oblien call — losing the
// race => peer already credited, skip.

export const stripeTopupGrant = pgTable(
  "stripe_topup_grant",
  {
    id: text("id").primaryKey(), // "stg_..."
    checkoutSessionId: text("checkout_session_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    packId: text("pack_id").notNull(),
    creditsMilli: bigint("credits_milli", { mode: "number" }).notNull(),
    grantedAt: timestamp("granted_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_stripe_topup_grant_session").on(table.checkoutSessionId),
    index("idx_stripe_topup_grant_org").on(table.organizationId),
  ],
);

// ─── billing_anniversary_grant ───────────────────────────────────────────────
// Per-org per-period anniversary cron grants. Unique on (org, period_start)
// so a cron crash between Oblien resetQuota + local period UPDATE doesn't
// re-zero quota_used on the next tick — the second tick finds the claim row
// and skips. The cron MUST claim BEFORE calling resetAndRegrant on Oblien.

export const billingAnniversaryGrant = pgTable(
  "billing_anniversary_grant",
  {
    id: text("id").primaryKey(), // "bag_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start").notNull(),
    grantedAt: timestamp("granted_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_billing_anniversary_grant_org_period").on(
      table.organizationId,
      table.periodStart,
    ),
  ],
);

// ─── billing_usage_snapshot ──────────────────────────────────────────────────
// Latest metered-usage snapshot per org, fed by the Oblien `credits.usage`
// webhook. Oblien remains the authoritative meter/ledger — this is a display
// cache so the dashboard's balance/usage surface renders instantly without a
// live Oblien round-trip, and survives when Oblien is briefly unreachable.
//
// Credit columns (balance/creditsUsed) are stored in openship MILLI-credits
// (the Oblien-credit value ×1000) to match PLANS[].monthlyCredits + the
// dashboard's formatCredits(÷1000). The per-resource columns are raw physical
// units straight off `data.usage.*` (minutes / GB) and are NOT credits.
// One row per org (upsert on organization_id).

export const billingUsageSnapshot = pgTable(
  "billing_usage_snapshot",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Remaining credit balance (milli-credits). */
    balance: doublePrecision("balance"),
    /** Credits consumed this period (milli-credits). */
    creditsUsed: doublePrecision("credits_used"),
    /** Raw metered units this period (physical, not credits). */
    cpuTimeMinutes: doublePrecision("cpu_time_minutes"),
    memoryGbMinutes: doublePrecision("memory_gb_minutes"),
    diskIoGb: doublePrecision("disk_io_gb"),
    networkGb: doublePrecision("network_gb"),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);
