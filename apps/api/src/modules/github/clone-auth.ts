/**
 * @module clone-auth
 *
 * Thin adapter over the unified token dispatcher in `github.token.ts` for
 * the deploy pipeline. The dispatcher (`tokenFor(userId, purpose, ctx)`)
 * already encodes the full priority chain; this file only translates the
 * deploy-specific `buildStrategy` discriminator into a `purpose`:
 *
 *   - buildStrategy="local"  → tokenFor(..., "local")
 *   - buildStrategy="server" → requireTokenFor(..., "remote")
 *
 * gh CLI tokens are never returned for "remote" — that policy lives in
 * `tokenFor("remote", ...)` and the rejection happens before this
 * function ever sees a token.
 *
 * Token priority (single source of truth — see github.token.ts):
 *   - purpose: "local"  → project > user-pat > gh CLI > App > OAuth
 *   - purpose: "remote" → project > user-pat > App > REFUSE (no gh CLI)
 */

import { type BuildStrategy } from "@repo/core";
import { tokenFor, requireTokenFor, type TokenContext } from "./github.token";

export async function resolveBuildGitToken(opts: {
  userId: string;
  projectId: string;
  owner?: string | null;
  buildStrategy: BuildStrategy;
  /** Active organization id — prefers org-scoped App installation lookup.
   *  See TokenContext for details. */
  organizationId?: string;
}): Promise<string | null> {
  const ctx: TokenContext = {
    projectId: opts.projectId,
    owner: opts.owner ?? undefined,
    organizationId: opts.organizationId,
  };

  if (opts.buildStrategy === "local") {
    const r = await tokenFor(opts.userId, "local", ctx);
    return r?.token ?? null;
  }

  // Remote — throw if nothing resolvable. requireTokenFor builds an
  // actionable error message with the right hint per purpose.
  const r = await requireTokenFor(opts.userId, "remote", ctx);
  return r.token;
}
