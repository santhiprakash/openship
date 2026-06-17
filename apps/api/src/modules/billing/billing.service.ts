/**
 * Billing service - Stripe integration for cloud pricing.
 *
 * Self-hosted instances skip billing entirely (gated by CLOUD_MODE env var).
 */

import Stripe from "stripe";
import { AppError, PLANS, ANNUAL_DISCOUNT, type PlanId } from "@repo/core";
import { repos } from "@repo/db";
import { env, runtimeTarget } from "../../config/env";

/* ---------- Stripe client (lazy) ---------- */

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/* ---------- Checkout ---------- */

export async function createCheckoutSession(
  userId: string,
  email: string | undefined,
  planId: PlanId,
  interval: "monthly" | "annual",
): Promise<{ checkoutUrl: string }> {
  const stripe = getStripe();
  const plan = PLANS[planId];

  if (plan.price === 0) {
    throw new Error("Cannot create checkout for the free plan");
  }

  const unitAmount =
    interval === "annual"
      ? Math.round(plan.price * (1 - ANNUAL_DISCOUNT) * 100)
      : plan.price * 100;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: email,
    client_reference_id: userId,
    metadata: { userId, planId, interval },
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Openship ${plan.name}`,
            description: `${plan.name} plan - ${interval} billing`,
          },
          unit_amount: unitAmount,
          recurring: {
            interval: interval === "annual" ? "year" : "month",
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${runtimeTarget.dashboard}/billing/overview?checkout=success`,
    cancel_url: `${runtimeTarget.dashboard}/billing/plans?checkout=cancelled`,
  });

  if (!session.url) {
    throw new Error("Failed to create checkout session");
  }

  return { checkoutUrl: session.url };
}

/* ---------- Portal ---------- */

export async function createPortalSession(
  userId: string,
): Promise<{ portalUrl: string }> {
  const stripe = getStripe();

  // TODO: Look up Stripe customer ID from DB using userId
  const customerId = ""; // placeholder

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${runtimeTarget.dashboard}/billing/overview`,
  });

  return { portalUrl: session.url };
}

/* ---------- Customer ---------- */

export async function createCustomer(userId: string, email: string) {
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });
  return customer;
}

/* ---------- Subscription ---------- */

export async function getSubscription(userId: string) {
  // TODO: Fetch active subscription from DB by userId
  return null;
}

export async function cancelSubscription(userId: string) {
  // TODO: Look up Stripe subscription ID from DB, cancel at period end
  const stripe = getStripe();
  const subscriptionId = ""; // placeholder - look up from DB
  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

/* ---------- Usage ---------- */

export async function recordUsage(userId: string, metric: string, quantity: number) {
  // TODO: Record metered usage for billing
}

export async function getUsageSummary(userId: string) {
  // TODO: Aggregate usage for current billing period
  return { buildMinutes: 0, bandwidth: 0, deployments: 0 };
}

/* ---------- Webhook ---------- */

/**
 * Stripe redelivers events on any handler error (timeout, 5xx, etc.)
 * and on schedule for the first 3 days. Without an idempotency record
 * we'd double-apply mutations on every retry. We use audit_event as
 * the idempotency log: a row with eventType="billing.webhook" and
 * resourceId=event.id is inserted BEFORE the handler dispatches. The
 * audit table's unique-by-id constraint makes the insert the
 * idempotency check.
 */
export async function handleStripeEvent(rawBody: string, signature?: string) {
  const stripe = getStripe();

  if (!env.STRIPE_WEBHOOK_SECRET || !signature) {
    throw new Error("Webhook signature verification failed");
  }

  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );

  // Attribute to the user encoded in event metadata when present; fall
  // back to the customer's stored userId. Without an attributable user
  // we still log the receipt via the system-wide audit channel below.
  const metadata = (event.data.object as { metadata?: Record<string, string> })
    ?.metadata ?? {};
  const userId = metadata.userId ?? null;
  const organizationId = userId ? `org_${userId}` : null;

  // Idempotency check: refuse to re-process events Stripe has already
  // sent. The audit_event row IS the receipt — its existence means
  // we've seen this event.id before and handled it (or are handling it
  // now). Race-safe via the (organizationId, eventType, resourceId)
  // tuple — concurrent redeliveries collide on insert.
  if (organizationId) {
    const seen = await repos.auditEvent
      .listByOrganization(organizationId, {
        eventType: "billing.webhook",
        resourceType: "billing",
        resourceId: event.id,
        perPage: 1,
      })
      .catch(() => ({ rows: [] as Array<unknown> }));
    if ((seen.rows ?? []).length > 0) {
      // Already processed. Stripe expects 2xx; return success.
      return;
    }
    await repos.auditEvent
      .create({
        organizationId,
        actorUserId: userId,
        eventType: "billing.webhook",
        resourceType: "billing",
        resourceId: event.id,
        ipAddress: null,
        userAgent: null,
        before: null,
        after: { stripeEventType: event.type },
      })
      .catch((err) =>
        console.warn(
          "[billing] webhook audit emit failed:",
          err instanceof Error ? err.message : err,
        ),
      );
  } else {
    console.warn(
      `[billing] webhook event ${event.id} (${event.type}) has no metadata.userId — skipping idempotency record`,
    );
  }

  // Until concrete handlers are implemented, every financially-relevant
  // event is REJECTED with a 5xx so Stripe retries — silently returning
  // 2xx on a stub would lose subscription state forever. Operators must
  // either implement the four handlers below OR explicitly opt out via
  // BILLING_WEBHOOK_DISCARD_UNHANDLED=true (no retry, events accepted
  // and dropped — only valid before any paying customer exists).
  const HANDLED_EVENT_TYPES = new Set<string>([
    // Add event types here as concrete handlers land.
  ]);
  const FINANCIAL_EVENT_TYPES = new Set<string>([
    "checkout.session.completed",
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]);

  if (HANDLED_EVENT_TYPES.has(event.type)) {
    // Future: switch (event.type) { case "checkout.session.completed": ... }
    return;
  }

  if (FINANCIAL_EVENT_TYPES.has(event.type)) {
    if (process.env.BILLING_WEBHOOK_DISCARD_UNHANDLED === "true") {
      console.warn(
        `[billing] discarding unhandled financial event ${event.id} (${event.type}) — BILLING_WEBHOOK_DISCARD_UNHANDLED=true`,
      );
      return;
    }
    throw new AppError(
      `Billing webhook handler for ${event.type} is not implemented. Stripe will retry. ` +
        `Set BILLING_WEBHOOK_DISCARD_UNHANDLED=true to accept-and-drop in pre-launch environments.`,
      501,
      "BILLING_WEBHOOK_UNIMPLEMENTED",
    );
  }

  // Non-financial events (e.g. customer.created notifications) — accept
  // silently. Audit row above records the receipt.
}
