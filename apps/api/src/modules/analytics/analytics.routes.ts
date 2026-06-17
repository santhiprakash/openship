/**
 * Analytics routes - mounted at /api/analytics in app.ts.
 *
 * All routes require authentication. Every route declares a permission
 * tag enforced by secureRouter middleware (check + audit emission).
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./analytics.controller";

const r = secureRouter(new Hono(), {
  module: "analytics",
  basePath: "/api/analytics",
});

/* All analytics routes require authentication */

/* ─── Request analytics ────────────────────────────────────────────────── */
r.get("/", { tag: "analytics:read" }, ctrl.summary);
r.get("/periods", { tag: "analytics:read" }, ctrl.periods);

/* ─── Deployment stats ─────────────────────────────────────────────────── */
r.get("/deployments", { tag: "analytics:read" }, ctrl.deploymentStats);

/* ─── Resource usage ───────────────────────────────────────────────────── */
r.get("/usage", { tag: "analytics:read" }, ctrl.usage);
r.get("/usage/stream", { tag: "analytics:read" }, ctrl.usageStream);
r.get("/container", { tag: "analytics:read" }, ctrl.containerInfo);

/* ─── Dashboard ────────────────────────────────────────────────────────── */
r.get("/dashboard", { tag: "analytics:read" }, ctrl.dashboard);

/* ─── Server analytics (scraped from OpenResty mgmt API) ───────────────── */
r.get(
  "/server/:serverId",
  { tag: "server:read", ids: { server: "serverId" } },
  ctrl.serverAnalytics,
);
r.get(
  "/server/:serverId/geo",
  { tag: "server:read", ids: { server: "serverId" } },
  ctrl.serverGeo,
);
r.get(
  "/server/:serverId/live",
  { tag: "server:read", ids: { server: "serverId" } },
  ctrl.serverAnalyticsLive,
);

export const analyticsRoutes = r.hono;
