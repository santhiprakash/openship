/**
 * Permissions API — team management + per-resource grants.
 *
 * Auth gating (registration order matters):
 *
 *   Just-authed (any member):
 *     GET    /org-meta                        current org's is_team flag
 *     GET    /resources?type=X                catalog of grantable resources
 *     POST   /invitations/:id/materialize     called from accept-invite page
 *     POST   /create-team-org                 upgrade-to-team flow
 *
 *   Admin/owner only (the requireRole gate kicks in below the line):
 *     GET    /grants?userId=X                 list grants for a member
 *     POST   /grants                          upsert one grant (one tuple)
 *     PUT    /grants                           replace a member's whole grant set
 *     DELETE /grants/:id                      revoke a grant
 *     GET    /invitations                     list pending invitations + their grants
 *     POST   /invite-with-grants              invite + attach pending grants in one call
 */

import { Hono } from "hono";
import { requireRole } from "../../middleware/active-organization";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./permissions.controller";

const r = secureRouter(new Hono(), {
  module: "permissions",
  basePath: "/api/permissions",
});

// All routes require authentication. Admin-only routes additionally
// pass through requireRole("admin") below.

// ─── Just-authed endpoints ──────────────────────────────────────────────────

r.get("/org-meta", { tag: "permissions:read" }, ctrl.orgMeta);
r.get("/resources", { tag: "permissions:read" }, ctrl.listResources);
r.post("/create-team-org", { tag: "permissions:write" }, ctrl.createTeamOrg);
r.post(
  "/invitations/:id/materialize",
  { tag: "permissions:write" },
  ctrl.materializeInvitation,
);

// ─── Admin-only endpoints (each requires admin/owner) ───────────────────────
//
// requireRole("admin") is attached PER-ROUTE (not via `r.use("*", …)`).
// secureRouter injects authMiddleware into each route's own handler chain, so a
// router-level `use()` here would run BEFORE auth — requireRole would then read
// an unset RequestContext and 401 every admin route. As a per-route handler it
// runs AFTER authMiddleware + the permission check, so `ctx` is populated.

r.get("/grants", { tag: "permissions:read" }, requireRole("admin"), ctrl.listGrants);
r.post("/grants", { tag: "permissions:write" }, requireRole("admin"), ctrl.upsertGrant);
r.put("/grants", { tag: "permissions:write" }, requireRole("admin"), ctrl.replaceGrants);
r.delete("/grants/:id", { tag: "permissions:admin" }, requireRole("admin"), ctrl.deleteGrant);
r.get("/invitations", { tag: "permissions:read" }, requireRole("admin"), ctrl.listInvitations);
r.post(
  "/invite-with-grants",
  { tag: "permissions:write" },
  requireRole("admin"),
  ctrl.inviteWithGrants,
);

export const permissionsRoutes = r.hono;
