/**
 * Branding controller - thin HTTP handlers in front of branding.service.
 *
 * Mounted at `/api/mail/branding/:serverId` behind localOnly + auth in
 * `mail.routes.ts`. The service does the talking to the Zero webmail
 * server; we just map errors to status codes and pull params.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { env } from "../../config";
import { getActiveOrganizationId } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { safeErrorMessage } from "@repo/core";
import {
  BrandingUnauthorizedError,
  BrandingUnreachableError,
  getBranding,
  updateBranding,
  type Branding,
} from "./branding.service";

function localOnlyGuard(c: Context): Response | null {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available in cloud mode" }, 404);
  }
  return null;
}

function requireServerId(c: Context): string {
  const id = c.req.param("serverId");
  if (!id) throw new Error("serverId is required");
  return id;
}

/**
 * Org-scoped guard: refuses to operate against a server outside the
 * caller's active organization. Branding writes hit the Zero webmail's
 * admin endpoint with a shared secret stamped at install time — letting
 * an out-of-org caller through would be a brand-takeover of another
 * tenant's webmail.
 */
async function assertServerInOrg(
  c: Context,
  serverId: string,
): Promise<Response | null> {
  const organizationId = getActiveOrganizationId(c);
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) {
    return c.json({ error: "Server not found" }, 404);
  }
  return null;
}

export async function getBrandingHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  try {
    const branding = await getBranding(serverId);
    return c.json({ branding });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function updateBrandingHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const body = (await c.req.json().catch(() => ({}))) as Partial<Branding>;
  try {
    const branding = await updateBranding(serverId, body);
    return c.json({ branding });
  } catch (err) {
    return errorJson(c, err);
  }
}

function errorJson(c: Context, err: unknown) {
  if (err instanceof BrandingUnauthorizedError) {
    return c.json({ error: err.message }, 502);
  }
  if (err instanceof BrandingUnreachableError) {
    return c.json({ error: err.message }, 502);
  }
  const message = safeErrorMessage(err);
  return c.json({ error: message }, 500);
}
