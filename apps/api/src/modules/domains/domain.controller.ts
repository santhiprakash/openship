/**
 * Domain controller - Hono request handlers.
 */

import type { Context } from "hono";
import { getUserId, getActiveOrganizationId, param } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import * as domainService from "./domain.service";
import type { TAddDomainBody } from "./domain.schema";

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function list(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return c.json({ error: "projectId query parameter required" }, 400);
  }
  await permission.assert(c, { resourceType: "project", resourceId: projectId, action: "read" });
  const domains = await domainService.listDomains(projectId, organizationId);
  return c.json({ data: domains });
}

export async function add(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const body = await c.req.json<TAddDomainBody>();
  if (body.projectId) {
    await permission.assert(c, { resourceType: "project", resourceId: body.projectId, action: "write" });
  }
  const result = await domainService.addDomain(organizationId, body);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "domain.added",
    resourceType: "domain",
    resourceId: result.domain.id,
    after: {
      projectId: result.domain.projectId,
      hostname: result.domain.hostname,
      isPrimary: result.domain.isPrimary,
    },
  });
  return c.json({ data: result.domain, records: result.records }, 201);
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "domain", resourceId: id, action: "admin" });
  await domainService.removeDomain(id, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "domain.removed",
    resourceType: "domain",
    resourceId: id,
    after: null,
  });
  return c.json({ message: "domain removed" });
}

export async function verify(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "domain", resourceId: id, action: "write" });
  const result = await domainService.verifyDomain(id, organizationId);

  // Audit verify attempts (both success and failure) so DNS verification
  // is traceable in the audit log alongside domain.added / domain.removed.
  // Useful for incident response — if a domain is hijacked via brief CNAME
  // control, the audit trail shows exactly when and from where the verify
  // ran.
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: result.verified ? "domain.verified" : "domain.verify_failed",
    resourceType: "domain",
    resourceId: id,
    after: {
      verified: result.verified,
      cnameVerified: result.cnameVerified,
      txtVerified: result.txtVerified,
    },
  });

  // Failed verification returns 422 so the dashboard's React Query / fetch
  // wrapper can use the standard error path while still reading
  // message/cnameVerified/txtVerified from the body. 200 on success.
  return c.json(result, result.verified ? 200 : 422);
}

export async function records(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "domain", resourceId: id, action: "read" });
  const result = await domainService.getDomainRecords(id, organizationId);
  return c.json({ data: result });
}

/** POST /domains/preview - get DNS records for a hostname (no DB write) */
export async function preview(c: Context) {
  const body = await c.req.json<{ hostname: string }>();
  if (!body.hostname?.trim()) {
    return c.json({ error: "hostname is required" }, 400);
  }
  const result = await domainService.previewRecords(body.hostname.trim().toLowerCase());
  return c.json({ data: result });
}

/** POST /domains/:id/renew - renew SSL for a single domain */
export async function renewSsl(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "domain", resourceId: id, action: "write" });
  const result = await domainService.renewDomainSsl(id, organizationId);
  return c.json({ data: result });
}

/** POST /domains/renew-all - batch SSL renewal for the requesting org's domains */
export async function renewAllSsl(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const result = await domainService.renewOrgCerts(organizationId);
  return c.json({ data: result });
}

/**
 * POST /domains/verify-pending - admin/cron endpoint.
 *
 * Re-runs DNS verification for every custom domain still in `pending`
 * state and added more than `minAgeMinutes` ago. Wire this up to a
 * scheduled job (Kubernetes CronJob / systemd timer / external scheduler)
 * so domains whose DNS finishes propagating after the user closed the
 * tab eventually flip to verified without manual re-clicks.
 *
 * Body: { minAgeMinutes?: number; limit?: number }
 */
export async function verifyPending(c: Context) {
  // Auth is the standard authMiddleware applied at the routes file —
  // any logged-in user can trigger a run; the work itself runs against
  // each domain's own project owner via verifyDomain, so the requester
  // can only kick off the sweep, not cross-tenant verify.
  type Body = { minAgeMinutes?: number; limit?: number };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));
  const result = await domainService.verifyPendingDomains({
    minAgeMinutes: typeof body.minAgeMinutes === "number" ? body.minAgeMinutes : undefined,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  });
  return c.json({ data: result });
}
