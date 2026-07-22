/**
 * Platform status notices — mounted at /api/notices in app.ts (both modes;
 * consumed mainly on the SaaS). Reads are public: notices are non-sensitive
 * operator announcements shown in the app banner, and may surface pre-login.
 * Writes are internal-token gated — platform-wide notices have no per-org
 * owner, so the operator (who holds INTERNAL_TOKEN) is the only writer.
 */

import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import { internalAuth } from "../../middleware";
import * as ctrl from "./notice.controller";

const r = secureRouter(new Hono(), {
  module: "notices",
  basePath: "/api/notices",
});

r.public(
  "get",
  "/",
  { reason: "Platform status notices — non-sensitive operator announcements shown in the app banner" },
  ctrl.list,
);

// Operator surface (internalAuth): list-all + push + clear.
r.public(
  "get",
  "/all",
  { reason: "Operator notice listing (incl. inactive) — internalAuth shared token" },
  internalAuth,
  ctrl.listAll,
);
r.public(
  "post",
  "/",
  { reason: "Operator status-notice push — internalAuth shared token" },
  internalAuth,
  ctrl.create,
);
r.public(
  "delete",
  "/:id",
  { reason: "Operator status-notice deactivate — internalAuth shared token" },
  internalAuth,
  ctrl.remove,
);

export const noticeRoutes = r.hono;
