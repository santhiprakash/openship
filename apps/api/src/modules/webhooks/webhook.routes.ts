/**
 * Webhook routes - unified entry point for signed provider webhooks.
 *
 * POST /api/webhooks/:provider - dispatches to the registered provider
 *
 * Only "github" is accepted. (Stripe has its own SDK-verified route at
 * /api/billing/webhook/stripe.) All other paths return 404. These routes do
 * NOT require session auth - they verify signatures instead.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureRouter } from "../../lib/secure-router";
import { handleWebhook } from "./webhook.controller";

const r = secureRouter(new Hono(), {
  module: "webhooks",
  basePath: "/api/webhooks",
});

/** 5 MB - well above typical GitHub payloads (~200 KB). */
const MAX_WEBHOOK_BODY = 5 * 1024 * 1024;

// Rate-limit policy `webhook-ingress` is set in the route spec below —
// the secureRouter wires it via `lib/rate-limit` (Redis-backed in
// CLOUD_MODE, memory fallback otherwise). No per-file Map needed.
r.public(
  "post",
  "/:provider",
  {
    reason: "Provider webhook (GitHub/Stripe) - HMAC/signature verified in handler",
    rateLimit: "webhook-ingress",
  },
  bodyLimit({ maxSize: MAX_WEBHOOK_BODY }),
  handleWebhook,
);

export const webhookRoutes = r.hono;

