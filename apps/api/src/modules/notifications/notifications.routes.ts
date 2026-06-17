/**
 * Notifications routes — mounted at /api/notifications.
 *
 * Tags use the `notifications` root resource (an org singleton — see
 * route-permission.ts). The route middleware enforces that the caller
 * is a member of the active org; ownership of per-user objects
 * (channels, subscriptions, deliveries) is enforced inside handlers.
 */
import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./notifications.controller";

const r = secureRouter(new Hono(), {
  module: "notifications",
  basePath: "/api/notifications",
});


// ── Categories (static registry — readable by any member)
r.get("/categories", { tag: "notifications:read" }, ctrl.listCategories);

// ── Channels (per-user)
r.get("/channels", { tag: "notifications:read" }, ctrl.listChannels);
r.post("/channels", { tag: "notifications:write" }, ctrl.createChannel);
r.patch("/channels/:id", { tag: "notifications:write" }, ctrl.updateChannel);
r.delete("/channels/:id", { tag: "notifications:write" }, ctrl.deleteChannel);

// ── Subscriptions (per-user × org)
r.get("/subscriptions", { tag: "notifications:read" }, ctrl.listSubscriptions);
r.put("/subscriptions", { tag: "notifications:write" }, ctrl.upsertSubscription);
r.delete("/subscriptions/:id", { tag: "notifications:write" }, ctrl.deleteSubscription);

// ── Org defaults (admin-controlled — admin tag)
r.get("/defaults", { tag: "notifications:read" }, ctrl.listDefaults);
r.put("/defaults", { tag: "notifications:admin" }, ctrl.upsertDefault);

// ── Deliveries (in-app inbox)
r.get("/deliveries", { tag: "notifications:read" }, ctrl.listDeliveries);
r.get("/deliveries/unseen-count", { tag: "notifications:read" }, ctrl.unseenCount);
r.post("/deliveries/:id/seen", { tag: "notifications:write" }, ctrl.markSeen);

export const notificationsRoutes = r.hono;
