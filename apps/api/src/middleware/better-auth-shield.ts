import type { Context, Next } from "hono";
import { auth } from "../lib/auth";
import { repos } from "@repo/db";

/**
 * Better Auth organization-plugin shield.
 *
 * Better Auth's organization plugin exposes a handful of GET endpoints
 * inside its catch-all that leak member / invitation data to ANY
 * authenticated org member — including "restricted" users who, by our
 * permission model, should not see admin-tier directory data:
 *
 *   GET /api/auth/organization/list-members
 *   GET /api/auth/organization/list-invitations
 *   GET /api/auth/organization/get-active-member-role  (with ?userId=)
 *
 * We can't patch the plugin handler, so this middleware sits in front
 * of /api/auth/* and intercepts these specific paths.
 *
 *  - restricted             → 403 on all three (admin-tier reads)
 *  - member                 → may list teammates (already in the org),
 *                             but NOT invitations or other users' roles
 *  - admin / owner          → pass through to Better Auth
 *  - anything else / no session → pass through, Better Auth handles 401
 *
 * Failure-safe: if anything throws while reading the session or the
 * caller's membership, we fall through and let Better Auth respond.
 * We never confirm cross-tenant existence in the error path.
 */

const PROTECTED_PATHS = new Set<string>([
  "/api/auth/organization/list-members",
  "/api/auth/organization/list-invitations",
  "/api/auth/organization/get-active-member-role",
]);

export async function betterAuthShield(c: Context, next: Next) {
  // Only intercept GETs on the exact paths above. Everything else —
  // POSTs to invite/update/remove, other GETs in the plugin, etc. —
  // falls through to Better Auth (which has its own role checks).
  if (c.req.method !== "GET") return next();

  // Hono's c.req.path strips query string already; normalise just in
  // case a trailing slash slips in.
  const path = c.req.path.replace(/\/+$/, "");
  if (!PROTECTED_PATHS.has(path)) return next();

  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch {
    return next();
  }

  if (!session?.user?.id) return next();

  const activeOrganizationId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  // No active org → no org-scoped membership to check. Let Better Auth
  // respond however it normally would (typically empty list / 400).
  if (!activeOrganizationId) return next();

  let role: string;
  try {
    const member = await repos.member.find(
      activeOrganizationId,
      session.user.id,
    );
    if (!member) {
      // Caller isn't actually in the active org they claim. Never leak
      // membership/invitation data here — return a generic 403.
      return c.json({ error: "Forbidden" }, 403);
    }
    role = member.role ?? "member";
  } catch {
    return next();
  }

  // Owners / admins: full access to the plugin endpoints.
  if (role === "owner" || role === "admin") return next();

  // Restricted: deny all three admin-tier reads.
  if (role === "restricted") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Regular member: can see who their teammates are (list-members),
  // but not the invitation queue or arbitrary other users' roles.
  if (role === "member") {
    if (path === "/api/auth/organization/list-members") return next();
    return c.json({ error: "Forbidden" }, 403);
  }

  // Unknown role: fail closed.
  return c.json({ error: "Forbidden" }, 403);
}
