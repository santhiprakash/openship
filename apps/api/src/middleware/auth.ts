import type { Context, Next } from "hono";
import { randomUUID } from "node:crypto";
import { repos } from "@repo/db";
import { auth } from "../lib/auth";
import { env, trustedOrigins } from "../config/env";
import { ensureLocalUser } from "../lib/local-user";
import { resolveActiveOrganizationId } from "./active-organization";
import { getAuthMode } from "../lib/auth-mode";
import { isLoopbackRequest, peerAddress } from "./loopback-peer";
import { hashPatToken } from "../lib/pat";
import { isPatToken, parseBearerToken } from "../lib/bearer";
import {
  buildRequestContext,
  type RequestContext,
  type RequestContextRole,
  type SessionKind,
} from "../lib/request-context";

declare module "hono" {
  interface ContextVariableMap {
    ctx: RequestContext;
  }
}

/**
 * Session authentication middleware.
 *
 * Unified flow across every deploy mode:
 *   1. Try the real Better Auth session. If present, stamp the request
 *      and continue.
 *      - DB / machinery errors throw (HIGH F2): we 503 with a code, we
 *        do NOT fall through to zero-auth.
 *      - When the request authenticated via `Authorization: Bearer`
 *        AND its Origin matches a browser-origin trustedOrigin, we
 *        REJECT (HIGH F14). Bearer is for CLI/server-to-server only;
 *        an XSS-exfiltrated session token presented as Bearer from
 *        the dashboard would otherwise defeat httpOnly cookies.
 *   2. No session → consult `getAuthMode()`.
 *   3. authMode !== "none" → 401.
 *   4. authMode === "none" → loopback guardrail (CRITICAL #4):
 *        - Desktop OR `OPENSHIP_ALLOW_ZERO_AUTH=true` is required.
 *        - The request must come from a loopback TCP peer
 *          (kernel-reported, not the Host header). Reverse-proxy
 *          misconfig spoofing Host can no longer escalate to admin.
 *
 * Active-org resolution is delegated to `resolveActiveOrganizationId` —
 * the single source of truth that prefers team orgs over empty personal
 * workspaces (see middleware/active-organization.ts).
 *
 * Supports both cookie-based sessions (dashboard) and Bearer tokens (CLI/API).
 */

function hasBearerHeader(c: Context): boolean {
  const raw = c.req.header("authorization") ?? c.req.header("Authorization");
  return typeof raw === "string" && /^bearer\s+/i.test(raw);
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Sentinel: the PAT path fully handled the request (ran next()). */
const PAT_HANDLED = Symbol("pat-handled");

/**
 * Personal Access Token auth. A Bearer credential of the form
 * `opsh_pat_<secret>` resolves to its owning user + org and builds the same
 * RequestContext a session would — so permission.assert applies unchanged.
 * A read-only token rejects mutation methods.
 *
 * Returns: `null` when the header is not a PAT (fall through to sessions); an
 * error `Response` to short-circuit; or `PAT_HANDLED` after a successful auth +
 * next() (so the caller must NOT continue to the session path).
 */
async function tryPatAuth(c: Context, next: Next): Promise<Response | typeof PAT_HANDLED | null> {
  const token = parseBearerToken(c);
  if (!isPatToken(token)) return null;

  // Parity with the Bearer-from-browser guard below: a PAT is a CLI/API
  // credential and should never arrive from a browser-trusted origin.
  if (originIsBrowserTrusted(c)) {
    return c.json(
      { error: "Access tokens are not allowed from browser origins", code: "BEARER_NOT_ALLOWED_FROM_BROWSER" },
      401,
    );
  }

  const pat = await repos.personalAccessToken.findActiveByHash(hashPatToken(token));
  if (!pat) return c.json({ error: "Invalid or expired access token", code: "INVALID_TOKEN" }, 401);

  // A token bound to an org is confined to it: reject an X-Organization-Id that
  // asks for a different org, so the token can't act in the user's OTHER orgs.
  if (pat.organizationId) {
    const requestedOrg = c.req.header("x-organization-id")?.trim();
    if (requestedOrg && requestedOrg !== pat.organizationId) {
      return c.json(
        { error: "This access token is scoped to a different organization", code: "TOKEN_ORG_SCOPE" },
        403,
      );
    }
  }

  if (pat.readOnly && MUTATION_METHODS.has(c.req.method.toUpperCase())) {
    return c.json({ error: "This access token is read-only", code: "TOKEN_READ_ONLY" }, 403);
  }

  const user = await repos.user.findById(pat.userId);
  if (!user) return c.json({ error: "Invalid or expired access token", code: "INVALID_TOKEN" }, 401);

  void repos.personalAccessToken.touchLastUsed(pat.id).catch(() => {});

  await applyAuthedRequest(
    c,
    user,
    { id: `pat:${pat.id}`, activeOrganizationId: pat.organizationId },
    "bearer",
  );
  await next();
  return PAT_HANDLED;
}

function originIsBrowserTrusted(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  return trustedOrigins.includes(origin);
}

export async function authMiddleware(c: Context, next: Next) {
  // ── 0. Personal Access Token (Bearer opsh_pat_…) ────────────────────
  // Handled before Better Auth so a PAT is never mis-parsed as a session
  // token. null → not a PAT (continue); otherwise the PAT path handled it.
  const patResult = await tryPatAuth(c, next);
  if (patResult !== null) return patResult === PAT_HANDLED ? undefined : patResult;

  // ── 1. Real session ─────────────────────────────────────────────────
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null;
  try {
    session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
  } catch (err) {
    // HIGH F2: a thrown error from getSession (DB outage, decryption
    // failure, etc.) MUST NOT silently fall through to the zero-auth
    // path. Return a 503 with a typed code so callers can distinguish
    // "no session" (cookie missing) from "session machinery broken".
    console.error("[auth] getSession threw:", err);
    return c.json(
      { error: "Authentication service unavailable", code: "AUTH_UNAVAILABLE" },
      503,
    );
  }

  if (session) {
    // HIGH F14: refuse Bearer-from-browser. Bearer is meant for CLI /
    // server-to-server flows. If the request carries a Bearer token AND
    // its Origin is one of our browser-trusted origins, it's almost
    // certainly an XSS-exfiltrated session token being replayed past
    // the httpOnly cookie defence. Block.
    if (hasBearerHeader(c) && originIsBrowserTrusted(c)) {
      return c.json(
        {
          error: "Bearer tokens are not allowed from browser origins",
          code: "BEARER_NOT_ALLOWED_FROM_BROWSER",
        },
        401,
      );
    }

    // Bearer header presence is what distinguishes a CLI/API token from
    // a browser cookie session — both flow through Better Auth's
    // getSession, but only Bearer carries the Authorization header.
    const sessionKind: SessionKind = hasBearerHeader(c) ? "bearer" : "cookie";
    await applyAuthedRequest(
      c,
      session.user,
      session.session as {
        id?: string;
        activeOrganizationId?: string | null;
      },
      sessionKind,
    );
    return next();
  }

  // ── 2. No session: gate everything on operator-controlled authMode ──
  const authMode = await getAuthMode();
  if (authMode !== "none") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // ── 3. Zero-auth path (CRITICAL #4) ─────────────────────────────────
  //
  // Two independent checks:
  //   (a) Operator opt-in: desktop is always allowed, every other
  //       deploy mode requires OPENSHIP_ALLOW_ZERO_AUTH=true. Without
  //       both layers a network-reachable instance flipped to
  //       authMode=none would silently hand out admin.
  //   (b) Loopback TCP peer (kernel-reported address). Replaces the
  //       old Host-header check, which a misconfigured reverse proxy
  //       or LAN exposure could spoof.
  if (env.DEPLOY_MODE !== "desktop" && !env.OPENSHIP_ALLOW_ZERO_AUTH) {
    console.warn(
      `[auth] zero-auth refused: DEPLOY_MODE=${env.DEPLOY_MODE} and OPENSHIP_ALLOW_ZERO_AUTH is not set.`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!isLoopbackRequest(c)) {
    const peer = peerAddress(c);
    console.warn(
      `[auth] zero-auth refused for non-loopback peer=${peer ?? "<unknown>"}`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = await ensureLocalUser();
  c.set("session", { id: "zero-auth", userId: user.id });
  await applyAuthedRequest(c, user, { id: "zero-auth" }, "zero-auth");
  return next();
}

/**
 * Stamp the request with user + session + resolved active org. Shared
 * by every successful auth path so the smart-default org resolution
 * runs in exactly one place.
 *
 * Also constructs the request-scoped RequestContext (single source of
 * truth for user/org/role/session/etc.) and stashes it under `ctx`.
 * The legacy `user`/`session`/`activeOrganizationId` setters stay in
 * place because 296+ call sites still read them through getUserId /
 * getActiveOrganizationId — those helpers are now thin shims that
 * tunnel to ctx, but third-party / older paths still read raw keys.
 */
async function applyAuthedRequest(
  c: Context,
  user: { id: string; email?: string | null; name?: string | null },
  session:
    | { id?: string; activeOrganizationId?: string | null }
    | null,
  sessionKind: SessionKind,
): Promise<void> {
  c.set("user", user);
  if (session && sessionKind !== "zero-auth") c.set("session", session);
  const orgId = await resolveActiveOrganizationId(
    user.id,
    session?.activeOrganizationId ?? null,
  );
  if (orgId) c.set("activeOrganizationId", orgId);

  // Build the RequestContext. If the user has no org membership yet
  // (brand-new signup, mid-provisioning) we skip ctx — downstream
  // handlers that call getRequestContext will get a clear error
  // pointing at the missing org, which is correct behavior: org-bound
  // routes shouldn't have run anyway.
  if (!orgId) return;

  const membership = await repos.member.find(orgId, user.id);
  // Zero-auth's synthetic user is owner of its personal org via
  // provisionUser, so this lookup succeeds there too. If it doesn't,
  // we still skip ctx rather than crash — better-auth-shield and
  // other middlewares will reject the request appropriately.
  if (!membership) return;

  const role = (membership.role ?? "member") as RequestContextRole;
  const clientIp = (c.get("clientIp") as string | null | undefined) ?? null;
  const userAgent = c.req.header("user-agent")?.trim() || null;

  c.set(
    "ctx",
    buildRequestContext({
      user: {
        id: user.id,
        email: (user as { email?: string | null }).email ?? "",
        name: (user as { name?: string | null }).name ?? null,
      },
      organizationId: orgId,
      role,
      membershipId: membership.id,
      sessionId: session?.id ?? "zero-auth",
      sessionKind,
      clientIp,
      userAgent,
      traceId: randomUUID(),
      hono: c,
    }),
  );
}
