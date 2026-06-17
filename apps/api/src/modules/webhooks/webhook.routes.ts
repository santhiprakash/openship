/**
 * Webhook routes - unified entry point for GitHub and Stripe.
 *
 * POST /api/webhooks/:provider - dispatches to the registered provider
 *
 * Only "github" and "stripe" are accepted. All other paths return 404.
 * These routes do NOT require session auth - they verify signatures instead.
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

/**
 * Simple per-IP rate limiter for webhook endpoints.
 * 120 requests per minute per IP - enough for burst pushes, blocks floods.
 */
const webhookIpCounts = new Map<string, { count: number; resetAt: number }>();

r.use("*", async (c, next) => {
  const ip = c.var.clientIp;
  if (!ip) {
    return c.json(
      { error: "Missing client IP — webhook must come through the proxy" },
      400,
    );
  }
  const now = Date.now();
  const window = 60_000;
  const max = 120;
  const entry = webhookIpCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    webhookIpCounts.set(ip, { count: 1, resetAt: now + window });
  } else if (entry.count >= max) {
    return c.json({ error: "Too many requests" }, 429);
  } else {
    entry.count++;
  }
  await next();
});

r.public(
  "post",
  "/:provider",
  { reason: "Provider webhook (GitHub/Stripe) - HMAC/signature verified in handler" },
  bodyLimit({ maxSize: MAX_WEBHOOK_BODY }),
  handleWebhook,
);

export const webhookRoutes = r.hono;

