import { Hono } from "hono";
import { requireRole } from "../../middleware";
import { secureRouter } from "../../lib/secure-router";
import * as local from "./cloud-local.controller";

/** Local-only cloud routes. */
export const cloudLocalRoutes = new Hono();
const r = secureRouter(cloudLocalRoutes, {
  module: "cloud-local",
  basePath: "/api/cloud",
});


// Disconnect + connect-callback take over the org's cloud bearer —
// owner role only. A cloud:admin grant alone isn't enough.
r.post("/disconnect", { tag: "cloud:admin" }, requireRole("owner"), local.disconnect);
r.get("/connect-callback", { tag: "cloud:read" }, requireRole("owner"), local.connectCallback);
r.get("/status", { tag: "cloud:read" }, local.status);
