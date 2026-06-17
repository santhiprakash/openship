/**
 * GitHub routes - all authenticated GitHub endpoints.
 *
 * Mounted at /api/github in app.ts. Every permission-tagged route
 * runs authMiddleware (auto-injected by secureRouter) which also
 * resolves the active organization id onto context — required by
 * tokenFor's self-hosted gh-cli operator-vs-member gate.
 *
 * The only public route here is /connect/redirect, the GitHub OAuth
 * callback, which intentionally has no user session yet.
 */

import { Hono } from "hono";
import { localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./github.controller";

const r = secureRouter(new Hono(), {
  module: "github",
  basePath: "/api/github",
});

/* ─── Status / Connection ──────────────────────────────────────────────── */
r.get("/status", { tag: "github:read" }, ctrl.getStatus);
r.get("/local-status", { tag: "github:read" }, localOnly, ctrl.getLocalStatus);
r.get("/connect/poll", { tag: "github:read" }, localOnly, ctrl.pollConnect);
r.get("/home", { tag: "github:read" }, ctrl.getHome);
r.post("/connect", { tag: "github:write" }, ctrl.connect);
r.public("get", "/connect/redirect", { reason: "GitHub OAuth callback - no session yet during redirect" }, ctrl.connectRedirect);
r.post("/disconnect", { tag: "github:admin" }, ctrl.disconnect);

/* ─── Accounts / Organisations ─────────────────────────────────────────── */
// /home returns { state, accounts, repos } in one round trip — the
// dashboard's only entry point.
r.get("/orgs/:org/repos", { tag: "github:list" }, ctrl.listOrgRepos);

/* ─── Repositories ─────────────────────────────────────────────────────── */
r.get("/repos", { tag: "github:list" }, ctrl.listRepos);
r.post("/repos", { tag: "github:write" }, ctrl.createRepo);
r.get("/repos/:owner/:repo", { tag: "github:read" }, ctrl.getRepo);
r.delete("/repos/:owner/:repo", { tag: "github:admin" }, ctrl.deleteRepo);

/* ─── Branches ─────────────────────────────────────────────────────────── */
r.get("/repos/:owner/:repo/branches", { tag: "github:list" }, ctrl.listBranches);

/* ─── Files ────────────────────────────────────────────────────────────── */
r.get("/repos/:owner/:repo/files", { tag: "github:list" }, ctrl.listFiles);
r.get("/repos/:owner/:repo/file", { tag: "github:read" }, ctrl.getFile);

/* ─── Repo Webhooks ────────────────────────────────────────────────────── */
r.get("/repos/:owner/:repo/webhooks", { tag: "github:list" }, ctrl.listWebhooks);
r.post("/repos/:owner/:repo/webhooks", { tag: "github:write" }, ctrl.registerWebhook);
r.delete("/repos/:owner/:repo/webhooks", { tag: "github:admin" }, ctrl.deleteWebhook);

export const githubRoutes = r.hono;

