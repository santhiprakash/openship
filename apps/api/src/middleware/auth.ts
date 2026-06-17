import type { Context, Next } from "hono";
import { auth } from "../lib/auth";
import { env } from "../config/env";
import { ensureLocalUser } from "../lib/local-user";
import { resolveActiveOrganizationId } from "./active-organization";

/**
 * Session authentication middleware.
 *
 * - Desktop: try real Better Auth session first (cloud-authenticated users),
 *            fall back to zero-auth local admin when `authMode === "none"`.
 *            When authMode is "cloud" or "local", desktop requires login
 *            just like every other deploy mode.
 * - Self-hosted (docker / bare): validates Better Auth session.
 * - SaaS (DEPLOY_MODE=cloud): validates Better Auth session.
 *
 * Active-org resolution is delegated to `resolveActiveOrganizationId` —
 * the single source of truth that prefers team orgs over empty personal
 * workspaces (see middleware/active-organization.ts).
 *
 * Supports both cookie-based sessions (dashboard) and Bearer tokens (CLI/API).
 */
export async function authMiddleware(c: Context, next: Next) {
  /* Desktop mode: try real session first, fall back to zero-auth */
  if (env.DEPLOY_MODE === "desktop") {
    try {
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session) {
        await applyAuthedRequest(c, session.user, session.session as { activeOrganizationId?: string | null });
        return next();
      }
    } catch {
      // No valid session - fall through to the zero-auth check below.
    }

    // Zero-auth fallback - only when authMode is "none". When the
    // operator has switched to "cloud" or "local" authMode, desktop
    // requires a real session like any other deploy mode.
    const { getAuthMode } = await import("../lib/auth-mode");
    const authMode = await getAuthMode();
    if (authMode !== "none") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await ensureLocalUser();
    await applyAuthedRequest(c, user, null);
    c.set("session", { id: "desktop", userId: user.id });
    return next();
  }

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await applyAuthedRequest(c, session.user, session.session as { activeOrganizationId?: string | null });
  await next();
}

/**
 * Stamp the request with user + session + resolved active org. Shared
 * by every successful auth path so the smart-default org resolution
 * runs in exactly one place.
 */
async function applyAuthedRequest(
  c: Context,
  user: { id: string },
  session: { activeOrganizationId?: string | null } | null,
): Promise<void> {
  c.set("user", user);
  if (session) c.set("session", session);
  const orgId = await resolveActiveOrganizationId(
    user.id,
    session?.activeOrganizationId ?? null,
  );
  if (orgId) c.set("activeOrganizationId", orgId);
}
