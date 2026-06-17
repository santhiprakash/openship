/**
 * Deployment routes - mounted at /api/deployments in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./deployment.controller";

const r = secureRouter(new Hono(), {
  module: "deployments",
  basePath: "/api/deployments",
});


/* ── CRUD + operations ─────────────────────────────────────────────── */
r.get("/", { tag: "deployment:list" }, ctrl.list);
r.post("/", { tag: "deployment:write" }, ctrl.create);
r.post("/prepare", { tag: "deployment:write" }, ctrl.prepare);

/* ── Build access (creates a new deployment - no ID yet) ───────────── */
r.post("/build/access", { tag: "deployment:write" }, ctrl.buildAccess);

/* ── SSL ───────────────────────────────────────────────────────────── */
// Side-effect-free SSL status probe — uses POST only to carry hostname
// in body. Permission required is "read"; readOnly tells the scanner
// the POST + read combination is intentional.
r.post("/ssl/status", { tag: "deployment:read", readOnly: true }, ctrl.sslStatus);
r.post("/ssl/renew", { tag: "deployment:write" }, ctrl.sslRenew);

/* ── Deployment by ID ──────────────────────────────────────────────── */
r.get("/:id", { tag: "deployment:read" }, ctrl.getById);
r.get("/:id/logs", { tag: "deployment:read" }, ctrl.logs);
r.get("/:id/stream", { tag: "deployment:read" }, ctrl.stream);
r.get("/:id/build", { tag: "deployment:read" }, ctrl.buildStatus);
r.post("/:id/build", { tag: "deployment:write" }, ctrl.buildStart);
r.post("/:id/redeploy", { tag: "deployment:write" }, ctrl.buildRedeploy);
r.post("/:id/rollback", { tag: "deployment:write" }, ctrl.rollback);
r.post("/:id/pin", { tag: "deployment:write" }, ctrl.pin);
r.post("/:id/reject", { tag: "deployment:write" }, ctrl.reject);
r.post("/:id/cancel", { tag: "deployment:write" }, ctrl.cancel);
r.delete("/:id", { tag: "deployment:admin" }, ctrl.remove);
r.post("/:id/restart", { tag: "deployment:write" }, ctrl.restart);
r.post("/:id/build/respond", { tag: "deployment:write" }, ctrl.buildRespond);
r.get("/:id/info", { tag: "deployment:read" }, ctrl.containerInfo);
r.get("/:id/usage", { tag: "deployment:read" }, ctrl.containerUsage);

export const deploymentRoutes = r.hono;
