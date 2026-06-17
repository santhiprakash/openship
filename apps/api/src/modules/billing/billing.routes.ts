import { Hono } from "hono";
import { authMiddleware } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as billingController from "./billing.controller";

/**
 * Plan info — no Stripe required, works on ALL instances.
 * Registered at `/api/billing` on every deploy mode.
 *
 * The /plans route is intentionally PUBLIC: the marketing site and the
 * pre-signup pricing page need it before the user has a session.
 */
export const billingPlansRoutes = new Hono();
const plansR = secureRouter(billingPlansRoutes, {
  module: "billing-plans",
  basePath: "/api/billing",
});
plansR.public(
  "get",
  "/plans",
  { reason: "Public pricing endpoint — read by marketing site + signup flow before auth" },
  billingController.listPlans,
);

/**
 * Stripe-powered billing — SaaS only (CLOUD_MODE=true).
 * Registered at `/api/billing` only when CLOUD_MODE.
 *
 * ⚠ This sub-app shares the `/api/billing` mount prefix with
 * `billingPlansRoutes` (which serves a PUBLIC GET /plans). Using
 * `.use("*", authMiddleware)` here would extend across siblings in
 * Hono v4 — same landmine the backup-routes had. Scope auth to the
 * specific sub-paths via per-path .use(), letting /plans stay reachable
 * regardless of mount order. The secureRouter permission middleware
 * runs AFTER authMiddleware on every route, layered automatically.
 */
export const billingSaasRoutes = new Hono();
const r = secureRouter(billingSaasRoutes, {
  module: "billing",
  basePath: "/api/billing",
});

r.use("/subscription", authMiddleware);
r.use("/usage", authMiddleware);
r.use("/payment-methods", authMiddleware);
r.use("/invoices", authMiddleware);
// /webhook/stripe is intentionally unauthed — Stripe signs the request;
// signature verification happens inside the handler.

r.get("/subscription", { tag: "billing:read" }, billingController.getSubscription);
r.post("/subscription", { tag: "billing:write" }, billingController.createSubscription);
r.patch("/subscription", { tag: "billing:write" }, billingController.updateSubscription);
// Cancel is admin-tier — matches the domain DELETE precedent (destructive
// operations require admin permission, not just write).
r.delete("/subscription", { tag: "billing:admin" }, billingController.cancelSubscription);

r.get("/usage", { tag: "billing:read" }, billingController.getUsage);

r.get("/payment-methods", { tag: "billing:read" }, billingController.listPaymentMethods);
r.post("/payment-methods", { tag: "billing:write" }, billingController.addPaymentMethod);

r.get("/invoices", { tag: "billing:read" }, billingController.listInvoices);

r.public(
  "post",
  "/webhook/stripe",
  { reason: "Stripe-signed webhook — signature verified in handler, no session auth" },
  billingController.stripeWebhook,
);
