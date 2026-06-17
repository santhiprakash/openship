/**
 * Project routes - mounted at /api/projects in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter
 * middleware (check + audit emission). The boot scanner refuses to
 * start if any route lacks one.
 */

import { Hono } from "hono";
import { localOnly } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./project.controller";

const r = secureRouter(new Hono(), {
  module: "projects",
  basePath: "/api/projects",
});

/* All project routes require authentication. The route-level
   `requirePermission` middleware (mounted automatically by secureRouter)
   loads each resource and validates org membership via the resource's
   own `organization_id` — no session-mutating auto-switch needed. */

/* ─── Local-only routes (hidden in cloud mode) ─────────────────────────── */
r.get("/local", { tag: "project:list" }, localOnly, ctrl.listLocal);
r.post("/scan", { tag: "project:write" }, localOnly, ctrl.scanLocal);
r.post("/import", { tag: "project:write" }, localOnly, ctrl.importLocal);

/* ─── Top-level project operations ─────────────────────────────────────── */
r.get("/home", { tag: "project:list" }, ctrl.getHome);
r.post("/ensure", { tag: "project:write" }, ctrl.ensure);
r.get("/", { tag: "project:list" }, ctrl.list);
r.post("/", { tag: "project:write" }, ctrl.create);

/* ─── Projects CRUD ────────────────────────────────────────────────────── */
r.get("/:id", { tag: "project:read" }, ctrl.getById);
r.patch("/:id", { tag: "project:write" }, ctrl.update);
r.delete("/:id", { tag: "project:admin" }, ctrl.remove);
r.get("/:id/info", { tag: "project:read" }, ctrl.getInfo);
r.get("/:id/environments", { tag: "project:read" }, ctrl.listEnvironments);
r.post("/:id/environments", { tag: "project:write" }, ctrl.createEnvironment);
r.get("/:id/deletion-preview", { tag: "project:read" }, ctrl.deletionPreview);

/* ─── Build options ────────────────────────────────────────────────────── */
r.post("/:id/options", { tag: "project:write" }, ctrl.setOptions);

/* ─── Enable / Disable ─────────────────────────────────────────────────── */
r.post("/:id/enable", { tag: "project:write" }, ctrl.enable);
r.post("/:id/disable", { tag: "project:write" }, ctrl.disable);

/* ─── Environment variables ────────────────────────────────────────────── */
r.get("/:id/env", { tag: "project:env_var:read" }, ctrl.listEnvVars);
r.put("/:id/env", { tag: "project:env_var:write" }, ctrl.setEnvVars);

/* ─── Per-project clone token (git credential override) ────────────────── */
r.get("/:id/clone-token", { tag: "project:read" }, ctrl.getCloneToken);
r.patch("/:id/clone-token", { tag: "project:admin" }, ctrl.updateCloneToken);

/* ─── Git ──────────────────────────────────────────────────────────────── */
r.get("/:id/git", { tag: "project:read" }, ctrl.getGitInfo);
r.post("/:id/git/link", { tag: "project:write" }, ctrl.linkRepo);
r.get("/:id/branches", { tag: "project:read" }, ctrl.listBranches);
r.post("/:id/auto-deploy", { tag: "project:write" }, ctrl.setAutoDeploy);
r.post("/:id/webhook-domain", { tag: "project:write" }, ctrl.setWebhookDomain);
r.post("/:id/branch", { tag: "project:write" }, ctrl.setBranch);

/* ─── Resources ────────────────────────────────────────────────────────── */
r.get("/:id/resources", { tag: "project:read" }, ctrl.getResources);
r.patch("/:id/resources", { tag: "project:write" }, ctrl.updateResources);
r.post("/:id/resources", { tag: "project:write" }, ctrl.updateResources);

/* ─── Sleep mode ───────────────────────────────────────────────────────── */
r.post("/:id/sleep-mode", { tag: "project:write" }, ctrl.setSleepMode);

/* ─── Deployments ──────────────────────────────────────────────────────── */
r.get("/:id/deployments", { tag: "project:deployment:list" }, ctrl.listDeployments);
r.post("/:id/deployment-session", { tag: "project:deployment:write" }, ctrl.deploymentSession);

/* ─── Custom domain ────────────────────────────────────────────────────── */
r.post("/:id/connect", { tag: "project:domain:write" }, ctrl.connectDomain);

/* ─── Runtime logs ─────────────────────────────────────────────────────── */
r.get("/:id/logs", { tag: "project:read" }, ctrl.runtimeLogs);
r.get("/:id/logs/stream", { tag: "project:read" }, ctrl.runtimeLogStream);

/* ─── Server HTTP request logs ─────────────────────────────────────────── */
r.get("/:id/server-logs/recent", { tag: "project:read" }, ctrl.recentServerLogs);
r.get("/:id/server-logs/stream-token", { tag: "project:read" }, ctrl.serverLogStreamToken);
r.get("/:id/server-logs/stream", { tag: "project:read" }, ctrl.serverLogStream);

export const projectRoutes = r.hono;
