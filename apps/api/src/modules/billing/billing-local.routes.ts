/**
 * Local billing proxy — runs only when !CLOUD_MODE.
 *
 * Proxies subscription/payment/invoice operations to the SaaS API
 * using the user's stored cloud session token (via cloudBillingFetch).
 *
 * Plan listing (GET /plans) is handled by billingPlansRoutes which
 * runs on ALL instances — no proxy needed for that.
 */

import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as billingLocal from "./billing-local.controller";

export const billingLocalRoutes = new Hono();
const r = secureRouter(billingLocalRoutes, {
  module: "billing-local",
  basePath: "/api/billing",
});

// ⚠ Same prefix collision as billingSaasRoutes — billingPlansRoutes
// shares /api/billing with a public GET /plans. Scope auth to the
// specific sub-paths so /plans is never accidentally gated.
r.use("/subscription", authMiddleware);
r.use("/usage", authMiddleware);
r.use("/payment-methods", authMiddleware);
r.use("/invoices", authMiddleware);

/* ---------- Subscriptions ---------- */
r.get("/subscription", { tag: "billing:read" }, billingLocal.getSubscription);
r.post("/subscription", { tag: "billing:write" }, billingLocal.createSubscription);
r.patch("/subscription", { tag: "billing:write" }, billingLocal.updateSubscription);
// Destructive — admin tier per the same precedent as the SaaS sibling.
r.delete("/subscription", { tag: "billing:admin" }, billingLocal.cancelSubscription);

/* ---------- Usage ---------- */
r.get("/usage", { tag: "billing:read" }, billingLocal.getUsage);

/* ---------- Payment Methods ---------- */
r.get("/payment-methods", { tag: "billing:read" }, billingLocal.listPaymentMethods);
r.post("/payment-methods", { tag: "billing:write" }, billingLocal.addPaymentMethod);

/* ---------- Invoices ---------- */
r.get("/invoices", { tag: "billing:read" }, billingLocal.listInvoices);
