/**
 * HTTP handlers for /backup-destinations. Ownership is org-scoped via
 * activeOrganizationId set by authMiddleware; userId is recorded as the
 * forensic actor stamp on create.
 */

import type { Context } from "hono";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { safeErrorMessage } from "@repo/core";
import {
  createDestination,
  deleteDestination,
  getDestination,
  getDestinationUsage,
  listDestinations,
  preflightDestination,
  preflightDraft as preflightDraftService,
  updateDestination,
  type CreateDestinationInput,
  type UpdateDestinationInput,
} from "./destination.service";

export async function listAll(c: Context) {
  const ctx = getRequestContext(c);
  const rows = await listDestinations(ctx);
  return c.json({ data: rows });
}

export async function getOne(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "backup_destination", resourceId: id, action: "read" });
  try {
    return c.json({ data: await getDestination(ctx, id) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function getUsage(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(ctx, { resourceType: "backup_destination", resourceId: id, action: "read" });
  try {
    return c.json({ data: await getDestinationUsage(ctx, id) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<CreateDestinationInput>();
  try {
    return c.json({ data: await createDestination(ctx, body) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function update(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "backup_destination", resourceId: id, action: "write" });
  const body = await c.req.json<UpdateDestinationInput>().catch(() => ({}));
  try {
    return c.json({ data: await updateDestination(ctx, id, body) });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "backup_destination", resourceId: id, action: "admin" });
  try {
    await deleteDestination(ctx, id);
    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}

export async function preflight(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  await permission.assert(getRequestContext(c), { resourceType: "backup_destination", resourceId: id, action: "write" });
  try {
    const result = await preflightDestination(ctx, id);
    return c.json({ data: result });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 404);
  }
}

/**
 * Test an UNSAVED destination (the modal's "Test connection"). Body is a
 * CreateDestinationInput; an optional `id` lets edit-mode reuse stored secrets
 * for fields left blank. Nothing is persisted. The route tag gates write.
 */
export async function preflightDraft(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req
    .json<CreateDestinationInput & { id?: string }>()
    .catch(() => null);
  if (!body || typeof body.kind !== "string") {
    return c.json({ error: "A destination kind is required" }, 400);
  }
  const { id, ...input } = body;
  if (id) {
    await permission.assert(ctx, { resourceType: "backup_destination", resourceId: id, action: "write" });
  }
  try {
    const result = await preflightDraftService(ctx, input, id);
    return c.json({ data: result });
  } catch (err) {
    return c.json({ error: safeErrorMessage(err) }, 400);
  }
}
