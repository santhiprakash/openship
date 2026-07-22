import { Type, type Static } from "@sinclair/typebox";

const TokenGrant = Type.Object({
  resourceType: Type.String(),
  resourceId: Type.String(),
  permissions: Type.Array(
    // "create" is the collection-only capability used by the "projects it
    // creates" scope: a {project,"*",[create]} grant. See permission.ts.
    Type.Union([
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("admin"),
      Type.Literal("create"),
    ]),
  ),
});

export const CreateTokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** Read-only tokens reject mutation methods (POST/PUT/PATCH/DELETE). */
  readOnly: Type.Optional(Type.Boolean()),
  /** Optional expiry, in days from now (1–365). Omit for a non-expiring token. */
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  /**
   * Optional resource scope. When present + non-empty, the token is limited to
   * exactly these resources (a restricted principal) — even below the minter's
   * role. Each grant must be within the minter's own access (validated server-side).
   */
  grants: Type.Optional(Type.Array(TokenGrant)),
});
export type TCreateTokenBody = Static<typeof CreateTokenBody>;

/**
 * Mint-time hardening for the "projects it creates" scope. A wildcard project
 * grant ({project,"*"}) is EXCLUSIVELY that scope, so it must be create-ONLY.
 * Anything else on {project,"*"} (read/write/admin, or create + extras) is
 * rejected: such a token would otherwise reach every project by id (bounded by
 * the minter's access) while staying INVISIBLE in the self-created-only list
 * view. Read/write/admin must target specific project ids. Single source of
 * truth for the rule — shared by both mint paths (PAT create + MCP authorize).
 * Returns true when the grant must be rejected.
 */
export function wildcardProjectGrantRejected(g: {
  resourceType: string;
  resourceId: string;
  permissions: readonly string[];
}): boolean {
  if (g.resourceType !== "project" || g.resourceId !== "*") return false;
  return !(g.permissions.length === 1 && g.permissions[0] === "create");
}
