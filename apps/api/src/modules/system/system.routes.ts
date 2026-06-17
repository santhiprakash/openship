/**
 * System routes - mounted at /api/system in app.ts.
 *
 * Self-hosted only (gated by localOnly in app.ts).
 *
 * Auth strategies:
 *   - /setup routes use internalAuth (Electron → API, no user session)
 *     and pass `skipAuth: true` so secureRouter doesn't auto-inject
 *     the user-session authMiddleware on top of internalAuth.
 *   - all other routes get authMiddleware auto-injected by secureRouter.
 */

import { Hono } from "hono";
import { internalAuth, localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as fs from "./filesystem.controller";
import * as setup from "./setup.controller";
import * as serverCheck from "./server-check.controller";
import * as serversCtrl from "./servers.controller";
import * as rateLimit from "./rate-limit.controller";

const r = secureRouter(new Hono(), {
  module: "system",
  basePath: "/api/system",
});

r.use("*", localOnly);

/* ── Onboarding (first-run only, no auth) ───────────────────────── */
r.public("get", "/onboarding", { reason: "First-run onboarding status check - no user exists yet" }, setup.onboardingStatus);
r.public("post", "/onboarding", { reason: "First-run onboarding setup - creates initial admin user" }, setup.onboardingSetup);

/* ── Internal routes (Electron → API with shared token) ─────────── */
r.public("post", "/setup", { reason: "Electron desktop client setup - protected by internalAuth shared token" }, internalAuth, setup.setup);
r.public("get", "/setup", { reason: "Electron desktop client setup read - protected by internalAuth shared token" }, internalAuth, setup.getSetup);

/* ── Authenticated routes (dashboard settings page) ─────────────── */
r.get("/settings", { tag: "settings:read" }, setup.getSetup);
r.patch("/settings", { tag: "settings:write" }, setup.updateSettings);
r.delete("/settings", { tag: "settings:admin" }, setup.deleteSettings);

/* ── Servers CRUD ───────────────────────────────────────────────── */
r.get("/servers", { tag: "server:list" }, serversCtrl.listServers);
r.get("/servers/:id", { tag: "server:read" }, serversCtrl.getServer);
r.post("/servers", { tag: "server:write" }, serversCtrl.createServer);
r.patch("/servers/:id", { tag: "server:write" }, serversCtrl.updateServer);
r.delete("/servers/:id", { tag: "server:admin" }, serversCtrl.deleteServer);

/* ── Per-server rate limiting (OpenResty level) ─────────────────── */
r.get("/servers/:id/rate-limit", { tag: "server:read" }, rateLimit.getRateLimit);
r.patch("/servers/:id/rate-limit", { tag: "server:write" }, rateLimit.updateRateLimit);

/* ── Server check & install (dashboard setup wizard) ────────────── */
r.post("/test-connection", { tag: "server:write" }, serverCheck.testConnection);
r.post("/check", { tag: "server:write" }, serverCheck.checkServer);
r.post("/install", { tag: "server:admin" }, serverCheck.installComponent);
r.post("/remove", { tag: "server:admin" }, serverCheck.removeComponent);
r.post("/install/stream", { tag: "server:admin" }, serverCheck.installStream);
r.get("/install/stream", { tag: "server:read" }, serverCheck.attachInstallStream);
r.get("/install/session", { tag: "server:read" }, serverCheck.getInstallSession);

/* ── Server monitoring (live stats via SSE) ─────────────────────── */
r.get("/monitor/stream", { tag: "server:read" }, serverCheck.monitorStream);

/* ── Filesystem browse ──────────────────────────────────────────── */
r.get("/browse", { tag: "settings:read" }, fs.browse);

export const systemRoutes = r.hono;

