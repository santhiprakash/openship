import type { Context } from "hono";
import { repos, type PublicPersonalAccessToken } from "@repo/db";
import { param } from "../../lib/controller-helpers";
import { getRequestContext } from "../../lib/request-context";
import { mintPatToken } from "../../lib/pat";
import type { TCreateTokenBody } from "./token.schema";

/** Public view of a token — NEVER includes the hash or the plaintext. */
function serialize(t: PublicPersonalAccessToken) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    readOnly: t.readOnly,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}

/** POST /api/tokens — mint a token. Returns the plaintext ONCE. */
export async function create(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<TCreateTokenBody>();

  const { token, tokenPrefix, tokenHash } = mintPatToken();
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 86_400_000)
    : null;

  const row = await repos.personalAccessToken.create({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    name: body.name,
    tokenPrefix,
    tokenHash,
    readOnly: body.readOnly ?? false,
    expiresAt,
  });

  // `token` is shown exactly once — it's never retrievable again.
  return c.json({ data: { ...serialize(row), token } }, 201);
}

/** GET /api/tokens — the caller's own tokens (no secrets). */
export async function list(c: Context) {
  const ctx = getRequestContext(c);
  const rows = await repos.personalAccessToken.listByUser(ctx.userId);
  return c.json({ data: rows.map(serialize) });
}

/** DELETE /api/tokens/:id — revoke one of the caller's own tokens. */
export async function revoke(c: Context) {
  const ctx = getRequestContext(c);
  const id = param(c, "id");
  const ok = await repos.personalAccessToken.revoke(id, ctx.userId);
  if (!ok) return c.json({ error: "Token not found" }, 404);
  return c.json({ data: { revoked: true } });
}
