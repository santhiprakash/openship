/**
 * HTTP handlers for /backup-destinations. Ownership is org-scoped via
 * activeOrganizationId set by authMiddleware; userId is recorded as the
 * forensic actor stamp on create.
 */

import type { Context } from "hono";
import { getUserId, getActiveOrganizationId, param } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { safeErrorMessage } from "@repo/core";
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  preflightDestination,
  updateDestination,
  type CreateDestinationInput,
  type UpdateDestinationInput,
} from "./destination.service";

export async function listAll(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const rows = await listDestinations(organizationId);
  return c.json({ data: rows });
}

export async function getOne(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "backup_destination", resourceId: id, action: "read" });
  try {
    return c.json({ data: await getDestination(id, organizationId) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const body = await c.req.json<CreateDestinationInput>();
  try {
    return c.json({ data: await createDestination(userId, organizationId, body) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function update(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "backup_destination", resourceId: id, action: "write" });
  const body = await c.req.json<UpdateDestinationInput>().catch(() => ({}));
  try {
    return c.json({ data: await updateDestination(id, organizationId, body) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function remove(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "backup_destination", resourceId: id, action: "admin" });
  try {
    await deleteDestination(id, organizationId);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function preflight(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const id = param(c, "id");
  await permission.assert(c, { resourceType: "backup_destination", resourceId: id, action: "write" });
  try {
    const result = await preflightDestination(id, organizationId);
    return c.json({ data: result });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}
