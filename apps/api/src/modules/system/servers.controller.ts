/**
 * Servers CRUD controller - manage SSH server configurations.
 *
 * Security: Gated behind localOnly + authMiddleware (no cloud, no unauthenticated).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { invalidateOpenRestyPaths } from "@/lib/openresty-paths";
import { env } from "../../config";
import { sshManager } from "../../lib/ssh-manager";
import { encryptSecretField } from "@/lib/credential-encryption";
import { getUserId, getActiveOrganizationId } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";

/** Guard - returns 404 in cloud mode (defense-in-depth) */
function assertNotCloud(c: Context): boolean {
  if (env.CLOUD_MODE) {
    c.status(404);
    c.body(null);
    return false;
  }
  return true;
}

/** Public shape - what the controller returns to clients (no SSH secrets). */
function serializeServer(s: Awaited<ReturnType<typeof repos.server.get>>) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    sshHost: s.sshHost,
    sshPort: s.sshPort,
    sshUser: s.sshUser,
    sshAuthMethod: s.sshAuthMethod,
    sshKeyPath: s.sshKeyPath,
    sshJumpHost: s.sshJumpHost,
    sshArgs: s.sshArgs,
    createdAt: s.createdAt,
  };
}

/** GET /servers - list servers in the caller's active organization. */
export async function listServers(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  // Org-scoped: only the caller's org's servers.
  const organizationId = getActiveOrganizationId(c);
  const all = await repos.server.listByOrganization(organizationId);
  return c.json(all.map(serializeServer));
}

/** GET /servers/:id - get a single server. */
export async function getServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const id = c.req.param("id")!;
  // Primary gate: permission resolver (404 on deny, IDOR-safe).
  await permission.assert(c, { resourceType: "server", resourceId: id, action: "read" });
  // Org-scoped: out-of-org server ids 404 indistinguishably from missing.
  const organizationId = getActiveOrganizationId(c);
  const server = await repos.server.getInOrganization(id, organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  return c.json(serializeServer(server));
}

/** POST /servers - create a new server */
export async function createServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const body = await c.req.json();

  const host = (body.sshHost as string)?.trim();
  if (!host) return c.json({ error: "SSH host is required" }, 400);

  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const server = await repos.server.create({
    organizationId,
    name: body.name?.trim() || null,
    sshHost: host,
    sshPort: body.sshPort ?? 22,
    sshUser: body.sshUser?.trim() || "root",
    sshAuthMethod: body.sshAuthMethod || null,
    // Encrypted at rest with AES-256-GCM (key derived from BETTER_AUTH_SECRET).
    // Decrypted only inside `buildSshConfig` when the ssh2 client needs it.
    sshPassword: encryptSecretField(body.sshPassword),
    sshKeyPath: body.sshKeyPath || null,
    sshKeyPassphrase: encryptSecretField(body.sshKeyPassphrase),
    sshJumpHost: body.sshJumpHost?.trim() || null,
    sshArgs: body.sshArgs?.trim() || null,
  });

  sshManager.invalidate(server.id);
  invalidateOpenRestyPaths(server.id);

  // Names + non-secret connection details only. SSH passwords & key
  // passphrases are encrypted at rest; never include them in the audit.
  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "server.added",
    resourceType: "server",
    resourceId: server.id,
    after: {
      name: server.name,
      sshHost: server.sshHost,
      sshPort: server.sshPort,
      sshUser: server.sshUser,
      sshAuthMethod: server.sshAuthMethod,
      sshJumpHost: server.sshJumpHost,
    },
  });

  return c.json(serializeServer(server), 201);
}

/** PATCH /servers/:id - update a server */
export async function updateServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const id = c.req.param("id")!;
  // Primary gate: permission resolver. Updating server config is a write.
  await permission.assert(c, { resourceType: "server", resourceId: id, action: "write" });
  // Org-scoped: refuse to update a server outside the caller's org.
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const existing = await repos.server.getInOrganization(id, organizationId);
  if (!existing) return c.json({ error: "Server not found" }, 404);

  const body = await c.req.json();
  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) patch.name = body.name?.trim() || null;
  if (body.sshHost !== undefined) patch.sshHost = body.sshHost?.trim() || existing.sshHost;
  if (body.sshPort !== undefined) patch.sshPort = body.sshPort ?? 22;
  if (body.sshUser !== undefined) patch.sshUser = body.sshUser?.trim() || "root";
  if (body.sshAuthMethod !== undefined) patch.sshAuthMethod = body.sshAuthMethod || null;
  // Sensitive fields are encrypted at rest; see lib/credential-encryption.
  if (body.sshPassword !== undefined) patch.sshPassword = encryptSecretField(body.sshPassword);
  if (body.sshKeyPath !== undefined) patch.sshKeyPath = body.sshKeyPath || null;
  if (body.sshKeyPassphrase !== undefined) patch.sshKeyPassphrase = encryptSecretField(body.sshKeyPassphrase);
  if (body.sshJumpHost !== undefined) patch.sshJumpHost = body.sshJumpHost?.trim() || null;
  if (body.sshArgs !== undefined) patch.sshArgs = body.sshArgs?.trim() || null;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const updated = await repos.server.update(id, patch);
  sshManager.invalidate(id);
  invalidateOpenRestyPaths(id);

  // Audit only the fields the caller intended to touch. Skip secrets entirely.
  const auditAfter: Record<string, unknown> = {};
  if (body.name !== undefined) auditAfter.name = updated?.name ?? null;
  if (body.sshHost !== undefined) auditAfter.sshHost = updated?.sshHost ?? null;
  if (body.sshPort !== undefined) auditAfter.sshPort = updated?.sshPort ?? null;
  if (body.sshUser !== undefined) auditAfter.sshUser = updated?.sshUser ?? null;
  if (body.sshAuthMethod !== undefined) auditAfter.sshAuthMethod = updated?.sshAuthMethod ?? null;
  if (body.sshKeyPath !== undefined) auditAfter.sshKeyPath = updated?.sshKeyPath ?? null;
  if (body.sshJumpHost !== undefined) auditAfter.sshJumpHost = updated?.sshJumpHost ?? null;
  if (body.sshArgs !== undefined) auditAfter.sshArgs = updated?.sshArgs ?? null;
  // Sentinels for credential rotation (no values).
  if (body.sshPassword !== undefined) auditAfter.sshPasswordChanged = true;
  if (body.sshKeyPassphrase !== undefined) auditAfter.sshKeyPassphraseChanged = true;

  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "server.updated",
    resourceType: "server",
    resourceId: id,
    after: auditAfter,
  });

  return c.json(serializeServer(updated));
}

/** DELETE /servers/:id - delete a server */
export async function deleteServer(c: Context) {
  if (!assertNotCloud(c)) return c.res;

  const id = c.req.param("id")!;
  // Primary gate: deleting a server is admin-tier (destructive).
  await permission.assert(c, { resourceType: "server", resourceId: id, action: "admin" });
  // Org-scoped: refuse to delete a server outside the caller's org.
  const userId = getUserId(c);
  const organizationId = getActiveOrganizationId(c);
  const existing = await repos.server.getInOrganization(id, organizationId);
  if (!existing) return c.json({ error: "Server not found" }, 404);

  await repos.server.delete(id);
  // Server is hard-deleted — purge any per-server resource grants so
  // they don't linger as orphan rows. Mail-server grants on the same
  // id need cleanup too since they share the server's id.
  await repos.resourceGrant
    .deleteForResource(organizationId, "server", id)
    .catch((err: unknown) =>
      console.error("[server.delete] grant cleanup failed:", err),
    );
  await repos.resourceGrant
    .deleteForResource(organizationId, "mail_server", id)
    .catch((err: unknown) =>
      console.error("[server.delete] mail_server grant cleanup failed:", err),
    );
  sshManager.invalidate(id);
  invalidateOpenRestyPaths(id);

  audit.recordAsync(auditContextFrom(c, organizationId, userId), {
    eventType: "server.removed",
    resourceType: "server",
    resourceId: id,
    after: {
      name: existing.name,
      sshHost: existing.sshHost,
    },
  });

  return c.json({ ok: true });
}
