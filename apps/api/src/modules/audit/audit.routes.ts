/**
 * Audit log API — mounted at /api/audit.
 *
 * GET /api/audit              list events for the active organization
 * GET /api/audit?eventType=X  filter by event taxonomy
 * GET /api/audit?actorUserId  filter by actor
 * GET /api/audit?resourceType=&resourceId=  filter by specific resource
 *
 * All requests are scoped by the caller's active organization. Role gating
 * is applied via permission.assert (resourceType: "audit") in each handler.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { repos } from "@repo/db";
import { authMiddleware } from "../../middleware";
import { getActiveOrganizationId } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";

export const auditRoutes = new Hono();

// All audit routes require auth. The permission resolver enforces the
// access policy: owners/admins always allowed, members denied, and
// restricted users gated through explicit `audit:read` grants on the
// org-level `audit` resource (resourceId "*").
auditRoutes.use("*", authMiddleware);

auditRoutes.get("/", async (c: Context) => {
  await permission.assert(c, { resourceType: "audit", resourceId: "*", action: "read" });
  const organizationId = getActiveOrganizationId(c);
  const cursor = c.req.query("cursor");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Math.min(Number(c.req.query("perPage") ?? 50), 200);
  const eventType = c.req.query("eventType");
  const actorUserId = c.req.query("actorUserId");
  const resourceType = c.req.query("resourceType");
  const resourceId = c.req.query("resourceId");

  // Cursor mode is recommended for any consumer that streams pages —
  // it survives concurrent writes (no shifted rows). Page/perPage is
  // the dashboard's "Showing N of M" fallback.
  const result = cursor !== undefined
    ? await repos.auditEvent.listByOrganization(organizationId, {
        cursor,
        limit,
        eventType: eventType || undefined,
        actorUserId: actorUserId || undefined,
        resourceType: resourceType || undefined,
        resourceId: resourceId || undefined,
      })
    : await repos.auditEvent.listByOrganization(organizationId, {
        page,
        perPage,
        eventType: eventType || undefined,
        actorUserId: actorUserId || undefined,
        resourceType: resourceType || undefined,
        resourceId: resourceId || undefined,
      });

  if ("pageInfo" in result) {
    return c.json({ data: result.rows, pageInfo: result.pageInfo });
  }
  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
});
