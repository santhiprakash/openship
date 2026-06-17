/**
 * Domain routes - mounted at /api/domains in app.ts.
 *
 * Every route declares a permission tag enforced by secureRouter.
 */

import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./domain.controller";
import { AddDomainBody } from "./domain.schema";

const r = secureRouter(new Hono(), {
  module: "domains",
  basePath: "/api/domains",
});


/* ─── Domains ──────────────────────────────────────────────────────────── */
r.get("/", { tag: "domain:list" }, ctrl.list);
r.post("/", { tag: "domain:write" }, tbValidator("json", AddDomainBody), ctrl.add);
// Side-effect-free DNS probe — POST is used to carry hostname in body.
// readOnly opts out of the scanner's "POST must be write/admin" rule.
r.post("/preview", { tag: "domain:read", readOnly: true }, ctrl.preview);
r.delete("/:id", { tag: "domain:admin" }, ctrl.remove);
r.post("/:id/verify", { tag: "domain:write" }, ctrl.verify);
r.get("/:id/records", { tag: "domain:read" }, ctrl.records);
r.post("/:id/renew", { tag: "domain:write" }, ctrl.renewSsl);
r.post("/renew-all", { tag: "domain:write" }, ctrl.renewAllSsl);
r.post("/verify-pending", { tag: "domain:write" }, ctrl.verifyPending);

export const domainRoutes = r.hono;
