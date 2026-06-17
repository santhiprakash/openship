import { Hono } from "hono";
import { rateLimiter } from "../../middleware/rate-limiter";
import { secureRouter } from "../../lib/secure-router";
import { cloudSessionAuth } from "./cloud-session-auth";
import * as saas from "./cloud-saas.controller";

/** SaaS-only cloud routes. */
const r = secureRouter(new Hono(), {
  module: "cloud-saas",
  basePath: "/api/cloud",
});

// PUBLIC handoff endpoints — arrive from browser redirects with signed tokens
r.public("get", "/desktop-handoff", { reason: "Desktop handoff redirect - signed token in URL, no session" }, saas.desktopHandoff);
r.public("get", "/connect-handoff", { reason: "Connect handoff redirect - signed token in URL, no session" }, saas.connectHandoff);

r.use("/exchange-code", rateLimiter);
r.public("post", "/exchange-code", { reason: "OAuth code exchange - validated by single-use code, not session" }, saas.exchangeCode);

r.use("/token", cloudSessionAuth);
r.post("/token", { tag: "cloud:write" }, saas.getToken);

r.use("/account", cloudSessionAuth);
r.get("/account", { tag: "cloud:read" }, saas.account);

r.use("/disconnect", cloudSessionAuth);
r.post("/disconnect", { tag: "cloud:admin" }, saas.disconnect);

r.use("/preflight", cloudSessionAuth);
r.post("/preflight", { tag: "cloud:write" }, saas.preflight);

r.use("/edge-proxy", cloudSessionAuth);
r.post("/edge-proxy", { tag: "cloud:write" }, saas.syncEdgeProxy);

r.use("/analytics", cloudSessionAuth);
r.post("/analytics", { tag: "cloud:write" }, saas.analyticsProxy);

r.use("/pages", cloudSessionAuth);
r.post("/pages", { tag: "cloud:write" }, saas.pagesProxy);

// ─── GitHub App proxy (cloud holds the App private key) ───────────────────
// All endpoints below are what self-hosted instances call via cloud-client.
// Cloud signs JWTs / mints install tokens; local never holds App creds.
//
// PUBLIC endpoints (no session auth) — the user's browser arrives here
// directly from github.com / from a popup with no SaaS session cookie.
// Auth is a single-use random token in the URL. Register these BEFORE
// the cloudSessionAuth middleware so it isn't gated.
r.public("get", "/github/install-callback", { reason: "GitHub App install callback - validated by state token in URL" }, saas.githubInstallCallback);
r.public("get", "/github/oauth-bridge", { reason: "GitHub OAuth bridge redirect - validated by state token, no session" }, saas.githubOauthBridge);
r.public("get", "/github/oauth-success", { reason: "GitHub OAuth success page - validated by single-use token in URL" }, saas.githubOauthSuccess);

r.use("/github/*", cloudSessionAuth);
r.post("/github/oauth-handoff", { tag: "cloud:write" }, saas.githubOauthHandoff);
r.post("/github/install-url", { tag: "cloud:write" }, saas.githubInstallUrl);
r.get("/github/installations", { tag: "cloud:read" }, saas.githubInstallations);
r.post("/github/installation-token", { tag: "cloud:write" }, saas.githubInstallationToken);
r.get("/github/user-status", { tag: "cloud:read" }, saas.githubUserStatus);

export const cloudSaasRoutes = r.hono;

