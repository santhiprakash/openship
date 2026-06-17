/**
 * Active organization resolution.
 *
 * Every authenticated request operates within the user's "active org" —
 * either explicitly set on the session via Better Auth's `setActive` flow,
 * or implicitly resolved to the user's first membership.
 *
 * The active org id is set on Hono context as `activeOrganizationId` and
 * read via `getActiveOrganizationId(c)` from controller-helpers. Repos
 * scope `WHERE organization_id = X`.
 *
 * `userId` is still stamped on every resource as the actor/creator —
 * preserved for forensic queries (who deployed, who restored).
 */

import type { Context, Next } from "hono";
import { repos } from "@repo/db";

/**
 * Resolve the active organization for an authenticated user — the
 * single source of truth for "what org am I scoped to right now".
 *
 * Resolution order:
 *   1. `session.activeOrganizationId` (set by Better Auth `setActive`)
 *      — validated as still being a membership; falls through on
 *      mismatch (the user may have been removed from that org since
 *      the session was issued).
 *   2. The user's first team org (Cloudflare model: a team org is
 *      where shared work lives; the personal workspace is the
 *      always-there fallback and is empty by default).
 *   3. First membership by creation order (single-org users land on
 *      their personal workspace).
 *   4. Null — caller decides whether to 403 or let the request proceed
 *      (org-free routes like /api/auth/* don't need this).
 *
 * Returns the resolved orgId or null. Does NOT mutate the context;
 * the caller is responsible for `c.set("activeOrganizationId", ...)`.
 */
export async function resolveActiveOrganizationId(
  userId: string,
  sessionOrgId: string | null,
): Promise<string | null> {
  const memberships = await repos.member.listByUser(userId).catch(() => []);
  if (memberships.length === 0) return null;
  const memberOrgIds = new Set(memberships.map((m) => m.organizationId));

  if (sessionOrgId && memberOrgIds.has(sessionOrgId)) {
    return sessionOrgId;
  }

  // Prefer a team org over an empty personal workspace. Batch lookup —
  // every authenticated request hits this resolver, an N+1 per
  // membership would be unacceptable.
  const orgs = await repos.organization
    .findManyById(Array.from(memberOrgIds))
    .catch(() => []);
  const teamOrg = orgs.find((o) => o?.isTeam === true);
  if (teamOrg) return teamOrg.id;

  return memberships[0].organizationId;
}

/**
 * Middleware variant — sets `activeOrganizationId` on context, 403s
 * when the user has no memberships at all (provisionUser failed).
 *
 * Runs AFTER authMiddleware (assumes c.get("user") + c.get("session")).
 * Used by routes that need org context outside the standard
 * authMiddleware path (e.g. GitHub webhook handlers).
 */
export async function activeOrganizationMiddleware(c: Context, next: Next) {
  const user = c.get("user") as { id: string } | undefined;
  const session = c.get("session") as { activeOrganizationId?: string | null } | undefined;

  if (!user?.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const orgId = await resolveActiveOrganizationId(
    user.id,
    session?.activeOrganizationId ?? null,
  );
  if (!orgId) {
    return c.json(
      { error: "No organization membership", code: "NO_ACTIVE_ORGANIZATION" },
      403,
    );
  }

  c.set("activeOrganizationId", orgId);
  await next();
}

/**
 * Role-gated middleware factory. Use on admin/owner-only routes:
 *   members.use("/invite", requireRole("admin"));
 *
 * Roles in ascending privilege: member < admin < owner.
 */
export function requireRole(min: "member" | "admin" | "owner") {
  const RANK = { member: 0, admin: 1, owner: 2 } as const;
  return async (c: Context, next: Next) => {
    const userId = c.get("user")?.id as string | undefined;
    const orgId = c.get("activeOrganizationId") as string | undefined;
    if (!userId || !orgId) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const m = await repos.member.find(orgId, userId);
    if (!m) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }
    const role = (m.role as "member" | "admin" | "owner") ?? "member";
    if (RANK[role] < RANK[min]) {
      return c.json(
        { error: `Requires ${min} role`, code: "INSUFFICIENT_ROLE" },
        403,
      );
    }
    await next();
  };
}
