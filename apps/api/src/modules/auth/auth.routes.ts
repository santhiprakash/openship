/**
 * Auth API — mounted at /api/auth in app.ts.
 *
 * Two surfaces:
 *   1. **Desktop-mode endpoints** (gated by env.DEPLOY_MODE === "desktop")
 *      — bootstrap zero-auth session + cloud OAuth handoff.
 *   2. **Better Auth catch-all** — every standard endpoint
 *      (sign-in/up, organization plugin, OAuth callbacks, etc.) is
 *      delegated to Better Auth's handler.
 *
 * Handlers live in auth.controller.ts; this file is route wiring only.
 */

import { Hono } from "hono";
import { env } from "../../config/env";
import { internalAuth } from "../../middleware/internal-auth";
import * as ctrl from "./auth.controller";

export const authRoutes = new Hono();

if (env.DEPLOY_MODE === "desktop") {
  authRoutes.get("/get-session", ctrl.getSession);
  authRoutes.get("/desktop-login", ctrl.desktopLogin);
  authRoutes.get("/cloud-callback", ctrl.cloudCallback);
  authRoutes.post("/desktop-auth-start", internalAuth, ctrl.desktopAuthStart);
  authRoutes.get("/desktop-auth-poll", ctrl.desktopAuthPoll);
  authRoutes.get("/desktop-claim", ctrl.desktopClaim);
}

// Better Auth catch-all — must be last so the desktop overrides win.
authRoutes.on(["GET", "POST"], "/*", ctrl.betterAuthHandler);
