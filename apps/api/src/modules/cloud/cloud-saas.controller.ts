/**
 * Cloud SaaS controller - runs only in CLOUD_MODE.
 *
 * All imports are top-level (no per-request dynamic imports on hot paths).
 * SaaS owns the Oblien master credentials, auth session management, and
 * handoff code generation.
 *
 *   POST /api/cloud/token           - mint namespace-scoped Oblien tokens
 *   POST /api/cloud/analytics       - proxy Oblien analytics (master client)
 *   POST /api/cloud/edge-proxy      - sync Oblien edge proxy for managed domains
 *   POST /api/cloud/pages           - proxy Oblien pages.create (master client)
 *   POST /api/cloud/preflight       - cloud deployment preflight check
 *   GET  /api/cloud/desktop-handoff - OAuth → one-time code → redirect to desktop
 *   GET  /api/cloud/connect-handoff - OAuth → one-time code → redirect to self-hosted
 *   POST /api/cloud/exchange-code   - exchange code for user + session (no auth)
 */

import type { Context } from "hono";
import { Oblien } from "@repo/adapters";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { getUserId } from "../../lib/controller-helpers";
import { auth, COOKIE_PREFIX } from "../../lib/auth";
import { issueNamespaceToken, getOblienClient } from "../../lib/openship-cloud";
import { generateHandoffCode, exchangeHandoffCode } from "../../lib/cloud-auth-proxy";
import { runCloudPreflight } from "../../lib/cloud-preflight";
import { cloudRuntimeTarget, env } from "../../config/env";
import { repos, db, schema, eq } from "@repo/db";
import { createEphemeralStore } from "../../lib/ephemeral-store";
import * as githubAuth from "../github/github.auth";

/**
 * Resolve the active org's owner — every org-scoped cloud operation
 * (namespace token mint, edge proxy, pages, analytics, GitHub install
 * token) uses the OWNER's identity as the SaaS-side bearer. Team
 * members invoke the SaaS endpoint with their own session; we look up
 * the team's owner and use their namespace/installations so cloud
 * resources are shared across team members within the org.
 *
 * For personal orgs (single-member, isTeam=false) this reduces to the
 * caller themselves — no behavior change for solo SaaS users.
 *
 * Active org resolution: prefer the Better Auth session's
 * activeOrganizationId, fall back to the caller's personal org
 * (always exists via provisionUser).
 */
async function resolveCloudOwner(
  c: Context,
): Promise<{ ownerUserId: string; organizationId: string }> {
  const callerUserId = getUserId(c);
  const session = c.get("session") as
    | { activeOrganizationId?: string | null }
    | undefined;
  const organizationId =
    session?.activeOrganizationId ?? `org_${callerUserId}`;
  const members = await repos.member.listByOrganization(organizationId);
  const owner = members.find((m) => m.role === "owner");
  if (!owner) {
    throw new Error(
      `Organization ${organizationId} has no owner — cannot resolve cloud bearer`,
    );
  }
  return { ownerUserId: owner.userId, organizationId };
}

// ─── Cloud analytics proxy (master client) ───────────────────────────────────

/**
 * POST /api/cloud/analytics  { operation, domain, params }
 *
 * Local/desktop instances call this to get Oblien analytics.
 * Edge proxies + analytics are account-level - namespace tokens can't access them.
 * The SaaS uses the master Oblien client on behalf of the caller.
 */
export async function analyticsProxy(c: Context) {
  const { ownerUserId, organizationId } = await resolveCloudOwner(c);
  const { operation, domain, params } = await c.req.json<{
    operation: "timeseries" | "requests" | "streamToken";
    domain: string;
    params?: Record<string, unknown>;
  }>();

  if (!operation || !domain) {
    return c.json({ error: "operation and domain are required" }, 400);
  }

  // Domain ownership check via the org owner's namespace. Oblien enforces
  // namespace isolation on edgeProxy.list, so a caller cannot probe
  // domains outside the org owner's namespace. The master client below
  // performs the actual analytics read.
  try {
    const { token } = await issueNamespaceToken(ownerUserId);
    const scopedClient = new Oblien({ token });
    const { proxies } = await scopedClient.edgeProxy.list();
    const requested = domain.toLowerCase();
    const ownsDomain = proxies.some(
      (p) =>
        p.name?.toLowerCase() === requested ||
        (p.slug && `${p.slug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}`.toLowerCase() === requested),
    );
    if (!ownsDomain) {
      console.warn(
        `[CLOUD analytics] org=${organizationId} requested analytics for "${domain}" but it isn't in the org owner's namespace`,
      );
      return c.json(
        { error: `You do not own analytics for ${domain}` },
        403,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not verify domain ownership";
    console.error("[CLOUD analytics] domain ownership check failed:", message);
    return c.json({ error: "Could not verify domain ownership" }, 500);
  }

  const client = getOblienClient();

  try {
    switch (operation) {
      case "timeseries": {
        const result = await client.analytics.timeseries(domain, params as any);
        return c.json(result);
      }
      case "requests": {
        const result = await client.analytics.requests(domain, params as any);
        return c.json(result);
      }
      case "streamToken": {
        const result = await client.analytics.streamToken(domain);
        return c.json(result);
      }
      default:
        return c.json({ error: "Unknown operation" }, 400);
    }
  } catch (err: unknown) {
    const status = typeof err === "object" && err !== null && "status" in err
      ? (err as { status: number }).status
      : 500;
    const message = err instanceof Error ? err.message : "Analytics request failed";
    c.status(status as 400 | 404 | 500);
    return c.json({ error: message });
  }
}

// ─── Namespace token minting ─────────────────────────────────────────────────

export async function getToken(c: Context) {
  const { ownerUserId } = await resolveCloudOwner(c);
  const result = await issueNamespaceToken(ownerUserId);
  return c.json({ data: result });
}

export async function preflight(c: Context) {
  const { ownerUserId } = await resolveCloudOwner(c);
  const body = await c.req.json<{ slug?: string; customDomain?: string }>();
  const result = await runCloudPreflight(ownerUserId, {
    slug: body.slug,
    customDomain: body.customDomain,
  });
  return c.json({ data: result });
}

/**
 * POST /api/cloud/disconnect  (bearer-authed)
 *
 * Revoke the current cloud_session_token by deleting its row in the
 * session table. Called from the local `disconnectCloud()` helper
 * BEFORE clearing the token from local DB — so the SaaS-side session
 * stops being usable immediately, instead of lingering for its full
 * 30-day TTL.
 *
 * Defense-in-depth against the threat model of "local DB exfiltrated
 * before disconnect was clicked": even if the attacker has the token
 * bytes, this endpoint kills the row, so the bytes become inert the
 * moment the user clicks Disconnect.
 *
 * Idempotent: if the row is already gone, returns success.
 */
export async function disconnect(c: Context) {
  const session = c.get("session") as { id?: string; token?: string } | undefined;
  const user = c.get("user") as { id?: string } | undefined;
  if (!session?.id) {
    return c.json({ ok: true }, 200);
  }
  try {
    await db.delete(schema.session).where(eq(schema.session.id, session.id));
  } catch (err) {
    console.error(
      "[cloud disconnect] failed to delete session row:",
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Failed to revoke session" }, 500);
  }

  // SaaS users each have a personal org (`org_<userId>`) provisioned at
  // signup. Audit against that so a security reviewer can reconstruct
  // "who disconnected which device when".
  if (user?.id) {
    await repos.auditEvent
      .create({
        organizationId: `org_${user.id}`,
        actorUserId: user.id,
        eventType: "cloud.disconnect",
        resourceType: "cloud",
        resourceId: session.id,
        ipAddress: c.var.clientIp,
        userAgent: c.req.header("user-agent") ?? null,
        before: null,
        after: null,
      })
      .catch((err) =>
        console.warn(
          "[cloud disconnect] audit emit failed:",
          err instanceof Error ? err.message : err,
        ),
      );
  }

  return c.json({ ok: true });
}

export async function account(c: Context) {
  const user = c.get("user") as
    | { name?: string | null; email?: string | null; image?: string | null }
    | undefined;

  if (!user?.email) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: {
      name: user.name ?? user.email,
      email: user.email,
      image: user.image ?? null,
    },
  });
}

// ─── Desktop OAuth handoff ───────────────────────────────────────────────────

/**
 * GET /api/cloud/desktop-handoff?redirect=<url>&state=<state>&code_challenge=<challenge>
 *
 * Security:
 *   - redirect MUST be localhost (desktop callback) - no open redirect
 *   - state is passed through unchanged for CSRF protection
 *   - code_challenge (PKCE S256) is bound to the one-time code
 */
export async function desktopHandoff(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return c.json({ error: "Redirect must target localhost" }, 400);
  }
  const port = parseInt(url.port || "80", 10);
  if (port < 1024 || port > 65535) {
    return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
  }

  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");

  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
    codeChallenge || undefined,
  );

  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

// ─── Self-hosted connect handoff ─────────────────────────────────────────────

/**
 * GET /api/cloud/connect-handoff?redirect=<url>
 *
 * Security:
 *   - redirect MUST be HTTPS (no downgrade to HTTP), except localhost
 *   - Codes are single-use with 60s TTL
 */
export async function connectHandoff(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "No active session" }, 401);
  }

  const redirect = c.req.query("redirect");
  if (!redirect) {
    return c.json({ error: "Missing redirect parameter" }, 400);
  }

  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return c.json({ error: "Invalid redirect URL" }, 400);
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalhost && url.protocol !== "https:") {
    return c.json({ error: "Redirect must use HTTPS" }, 400);
  }
  if (isLocalhost) {
    const port = parseInt(url.port || "80", 10);
    if (port < 1024 || port > 65535) {
      return c.json({ error: "Redirect port must be ≥ 1024" }, 400);
    }
  }

  const code = await generateHandoffCode(
    {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session.session.token,
  );

  url.searchParams.set("code", code);
  return c.redirect(url.toString());
}

// ─── Code exchange (no auth - code is the credential) ────────────────────────

export async function exchangeCode(c: Context) {
  const body = await c.req.json<{ code: string; code_verifier?: string }>();
  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  const result = await exchangeHandoffCode(body.code, body.code_verifier);
  if (!result) {
    return c.json({ error: "Invalid or expired code" }, 401);
  }

  return c.json({ data: result });
}

// ─── Managed edge proxy sync ─────────────────────────────────────────────────

/**
 * POST /api/cloud/edge-proxy  { slug: string, target: string }
 *
 * Self-hosted/desktop instances send just the project slug + target IP.
 * SaaS uses the managed base domain (opsh.io) and creates slug.opsh.io.
 *
 * SECURITY: The handler uses a per-user namespace-scoped Oblien token rather
 * than the master client so the underlying Oblien API enforces namespace
 * isolation. A caller cannot overwrite another tenant's `slug.opsh.io` edge
 * proxy — the slug listing/update/enable calls only see proxies owned by
 * the caller's namespace. As a defense-in-depth layer we additionally
 * check that any pre-existing proxy with the same slug really lives in the
 * caller's namespace before mutating it.
 */
export async function syncEdgeProxy(c: Context) {
  const { ownerUserId } = await resolveCloudOwner(c);
  const body = await c.req.json<{ slug?: string; target?: string }>();
  if (!body.slug || !body.target) {
    return c.json({ error: "slug and target are required" }, 400);
  }

  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) {
    return c.json({ error: "Invalid slug" }, 400);
  }

  const baseDomain = SYSTEM.DOMAINS.CLOUD_DOMAIN;
  const hostname = `${slug}.${baseDomain}`;
  const target = body.target.startsWith("http://") || body.target.startsWith("https://")
    ? body.target
    : `http://${body.target}`;

  try {
    // Org-owner namespace token: every team member of the active org
    // shares the owner's Oblien namespace. Oblien still enforces
    // namespace isolation on edgeProxy.list/create/update/enable —
    // a caller cannot overwrite another org's `<slug>.opsh.io` route.
    const { token } = await issueNamespaceToken(ownerUserId);
    const client = new Oblien({ token });
    const { proxies } = await client.edgeProxy.list();
    const existing = proxies.find(
      (p) => p.slug === slug,
    );

    if (!existing) {
      await client.edgeProxy.create({ name: hostname, slug, domain: baseDomain, target });
    } else {
      if (existing.name !== hostname || existing.slug !== slug || existing.target !== target) {
        await client.edgeProxy.update(existing.id, { name: hostname, slug, target });
      }
      if (existing.status === "disabled") {
        await client.edgeProxy.enable(existing.id);
      }
    }

    return c.json({ ok: true, hostname });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to sync edge proxy";
    const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    const details = typeof err === "object" && err !== null && "details" in err
      ? (err as { details?: unknown }).details
      : undefined;

    console.error("[CLOUD] Edge proxy sync failed", { slug, baseDomain, target, status, code, details, message });
    c.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
    return c.json({ error: message, code, details });
  }
}

// ─── Pages proxy (master client) ─────────────────────────────────────────────

/**
 * POST /api/cloud/pages  { workspace_id, path, name, slug, domain? }
 *
 * Local/desktop instances call this to create an Oblien static page on
 * a shared zone (e.g. `opsh.io`). Page creation on `opsh.io` touches
 * the master account's DNS — namespace tokens can't perform it, so
 * the SaaS executes the call with the master client on the user's
 * behalf. Pages without a `domain` (custom-domain or slug-only) don't
 * need this proxy — the namespace token can create them directly.
 *
 * Returns the raw `{ page }` shape the Oblien SDK returns so the
 * caller can drop it straight into the existing CloudRuntime code path.
 */
export async function pagesProxy(c: Context) {
  const { ownerUserId } = await resolveCloudOwner(c);
  const body = await c.req.json<{
    workspace_id?: string;
    path?: string;
    name?: string;
    slug?: string;
    domain?: string;
  }>();

  if (!body.workspace_id || !body.path || !body.name || !body.slug) {
    return c.json({ error: "workspace_id, path, name and slug are required" }, 400);
  }

  try {
    // Org-owner namespace token: pages.create rejects workspace_ids
    // outside the org owner's namespace, enforcing isolation between
    // team orgs while letting all members of one org share its pages.
    const { token } = await issueNamespaceToken(ownerUserId);
    const client = new Oblien({ token });
    const result = await client.pages.create({
      workspace_id: body.workspace_id,
      path: body.path,
      name: body.name,
      slug: body.slug,
      ...(body.domain ? { domain: body.domain } : {}),
    });
    return c.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Page creation failed";
    const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
    const code = typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    const details = typeof err === "object" && err !== null && "details" in err
      ? (err as { details?: unknown }).details
      : undefined;

    console.error("[CLOUD] Pages proxy failed", { slug: body.slug, domain: body.domain, status, code, details, message });
    c.status(status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500);
    return c.json({ error: message, code, details });
  }
}

// ─── GitHub App proxy (cloud-mode only — holds the App private key) ─────────
//
// These endpoints are what self-hosted instances call via cloud-client.ts.
// All App credentials (GITHUB_APP_ID, GITHUB_PRIVATE_KEY) live here in cloud
// mode and never leave — local just hands off (userId, request) and receives
// resolved data back. Local never sees the JWT, never signs anything.
//
// `cloudSessionAuth` middleware (applied on the routes file) resolves the
// caller's Better-Auth user from their session token; `getUserId(c)` returns
// that user's id. Each cloud user's installations / OAuth identity are
// already managed by the existing local github code paths, so we just reuse
// them — this controller is a thin policy/translation layer.

// Install state lifecycle now lives in lib/github-install-state.ts so the
// webhook handler can also use it as an attribution fallback when the
// install-callback path isn't reachable. See that file for the full
// security contract.
import {
  issueInstallState,
  peekAndConsumeInstallState,
} from "../../lib/github-install-state";

// ─── OAuth bridge (browser-session handoff for linkSocialAccount) ───────────
//
// SaaS-only OAuth flow. Self-hosted instances never hold GitHub OAuth
// credentials — they redirect the user's browser to api.openship.io
// where the real OAuth round-trip happens against the SaaS's Better
// Auth instance. The browser starts with no SaaS session cookie (it
// only has a local session), so we need a 2-hop handoff:
//
//   1. Local POSTs /oauth-handoff with its cloud_session_token Bearer.
//      SaaS resolves the bearer to a Better-Auth session, mints a
//      one-time bridge token storing (userId, sessionToken), returns
//      a URL pointing at /oauth-bridge?token=<bridge>.
//
//   2. Browser opens /oauth-bridge?token=<>. SaaS consumes the bridge
//      (single-use), constructs Better-Auth session headers from the
//      stashed sessionToken, calls auth.api.linkSocialAccount which
//      returns the GitHub OAuth redirect URL + state cookies. SaaS
//      forwards the redirect AND sets the user's Better-Auth session
//      cookie on the browser so when GitHub redirects back to Better
//      Auth's callback URL, it resolves to the right user and creates
//      the `account` row with providerId='github'.
//
// After this, the SaaS has authoritative knowledge of the user's
// GitHub identity. findUserByGitHubId in the install webhook will
// succeed, getUserToken will return the user's OAuth token, and
// getUserInstallations will work end-to-end.

interface OauthBridgeRow {
  userId: string;
  sessionToken: string;
}
const OAUTH_BRIDGE_TTL_MS = 5 * 60 * 1000;
// Adapter-backed store — swap to Redis/DB without touching call sites
// when the SaaS scales beyond a single replica. See lib/ephemeral-store.ts.
const oauthBridgeStore = createEphemeralStore<OauthBridgeRow>();

function getSetCookieHeaders(headers: Headers): string[] {
  // Node 18+ exposes getSetCookie on Headers; fall back for older envs.
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const out: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.push(value);
  });
  return out;
}

// ─── GitHub Connect flow: architecture overview ─────────────────────────────
//
// SaaS-only OAuth + install flow. Local self-hosted instances NEVER hold
// GitHub OAuth credentials, GitHub App private keys, or the gitInstallation
// table for the App. Everything flows through api.openship.io.
//
// Three independent identity envelopes chain together:
//
//   ┌─ Local DB ────────────────┐   ┌─ SaaS process memory ─────┐   ┌─ Browser ─────────────┐
//   │ user_settings.cloud_      │   │ oauthBridges Map          │   │ Better Auth oauth_     │
//   │ session_token (AES at     │ → │ {userId, sessionToken}    │ → │ state cookie           │
//   │ rest with BETTER_AUTH_    │   │ 16 random bytes, 5min TTL │   │ AES-encrypted {link:  │
//   │ SECRET-derived key)       │   │ single-use                │   │ {email, userId}}      │
//   └───────────────────────────┘   └───────────────────────────┘   └───────────────────────┘
//          Step 1: Local→SaaS              Step 2: SaaS→Browser           Step 3: Browser→GitHub→SaaS
//          Authorization: Bearer            ?token=<bridge> in URL         redirect chain
//
// Security invariants:
//   - The popup browser NEVER receives the SaaS Better Auth session
//     cookie. Only the oauth_state cookies are forwarded (see the
//     allowedCookieNames filter in githubOauthBridge below). The state
//     cookie itself carries the {link: {email, userId}} binding all the
//     way to GitHub's callback, and Better Auth's callback handler
//     (callback.mjs:102-128) reads userId from the decrypted state — it
//     never consults c.context.session for link flows.
//   - The bridge token in /oauth-bridge?token=<> is single-use AND
//     time-bound. Leaking it via access logs / browser history is bounded
//     by both: the consumer races first (consumeOauthBridge deletes
//     before returning), and the 5-min TTL.
//   - The link binding (userId) lives ONLY inside the encrypted state
//     cookie. The bridge token itself is opaque randomness — leaking
//     it from a URL reveals no PII or userId.
//
// Do NOT add a session-cookie set on the popup browser response from
// /oauth-bridge — that would silently log the popup into the SaaS
// dashboard, conflating identities across the local and SaaS tiers.

/**
 * POST /api/cloud/github/oauth-handoff   (bearer-authed via cloudSessionAuth)
 *
 * Returns a one-time URL the browser opens to start GitHub OAuth on the
 * SaaS. The URL points at the public /oauth-bridge endpoint with a
 * single-use bridge token. The bridge then calls Better Auth's
 * linkSocialAccount via the bearer plugin (Authorization: Bearer
 * sessionToken) to obtain the GitHub OAuth redirect URL + state
 * cookies, forwards both to the browser, and the browser proceeds to
 * GitHub.
 */
export async function githubOauthHandoff(c: Context) {
  // cloudSessionAuth middleware (mounted on /github/*) already resolved
  // the Bearer token into a session row + user. We read them straight
  // from the context instead of calling auth.api.getSession (which only
  // reads cookies, not the Bearer header we authenticate cloud-client
  // requests with).
  const user = c.get("user") as { id: string } | undefined;
  const session = c.get("session") as { token: string } | undefined;
  if (!user || !session) {
    return c.json({ error: "No active session" }, 401);
  }
  const token = await oauthBridgeStore.issue(
    { userId: user.id, sessionToken: session.token },
    { ttlMs: OAUTH_BRIDGE_TTL_MS },
  );
  return c.json({
    data: {
      url: `${cloudRuntimeTarget.api}/api/cloud/github/oauth-bridge?token=${encodeURIComponent(token)}`,
    },
  });
}

/**
 * GET /api/cloud/github/oauth-bridge?token=<>   (PUBLIC)
 *
 * Browser opens this from a popup. We consume the bridge token, set the
 * user's Better-Auth session cookie on the browser, call
 * auth.api.linkSocialAccount to get GitHub's OAuth start URL + Better
 * Auth's own state cookies, and redirect to that URL with all cookies
 * attached. When GitHub redirects back to Better Auth's callback, the
 * session cookie identifies the user and Better Auth creates the
 * `account` row scoped to them.
 */
export async function githubOauthBridge(c: Context) {
  const token = c.req.query("token");
  if (!token) {
    return c.html(
      renderCallbackHtml(
        "Missing bridge token",
        "GitHub OAuth bridge URL is malformed. Try connecting again from the dashboard.",
      ),
      400,
    );
  }

  const bridge = await oauthBridgeStore.consume(token);
  if (!bridge) {
    return c.html(
      renderCallbackHtml(
        "OAuth link expired",
        "This GitHub OAuth bridge link expired or was already used. Try connecting again.",
      ),
      401,
    );
  }

  try {
    // The Better Auth `bearer` plugin (configured in lib/auth.ts) accepts
    // `Authorization: Bearer <session.token>` and converts it to the
    // signed cookie format internally. This avoids us having to
    // hand-construct the signed cookie value (which is what was failing
    // before — Better Auth's wire format is very particular about
    // encoding + ordering and getting it wrong silently returns 401).
    const linkHeaders = new Headers();
    linkHeaders.set("Authorization", `Bearer ${bridge.sessionToken}`);

    const linkResult = await auth.api.linkSocialAccount({
      body: {
        provider: "github",
        callbackURL: `${cloudRuntimeTarget.api}/api/cloud/github/oauth-success`,
        disableRedirect: true,
      },
      headers: linkHeaders,
      asResponse: true,
    });

    if (linkResult instanceof Response) {
      // Read the body ONCE into text up-front. Trying to .clone() after
      // .json() throws "Body has already been consumed" — so we capture
      // the bytes once and parse the same string for both the success
      // path (looking for { url }) and the error log fallback.
      const status = linkResult.status;
      const bodyText = await linkResult.text().catch(() => "");

      let redirectUrl: string | null = linkResult.headers.get("location");
      if (!redirectUrl && bodyText) {
        try {
          const body = JSON.parse(bodyText) as { url?: string };
          redirectUrl = body?.url ?? null;
        } catch {
          // Not JSON; redirectUrl stays null and we log below.
        }
      }

      if (redirectUrl) {
        const response = c.redirect(redirectUrl);

        // SECURITY INVARIANT: forward ONLY the OAuth state cookies, NEVER
        // the SaaS session cookie. The state cookie carries the encrypted
        // link.userId binding (better-auth/dist/state.mjs lines 14-19,
        // callback.mjs:102-128 reads link.userId straight out of the
        // decrypted state — it never consults c.context.session). So the
        // popup browser doesn't need any session cookie to complete the
        // OAuth callback.
        //
        // If we ever forwarded the SaaS session cookie here, we'd silently
        // log the popup window into the SaaS dashboard at api.openship.io
        // from a popup opened by a local self-hosted instance — that's
        // confused-deputy territory. Future Better Auth versions might
        // start emitting unexpected Set-Cookie headers during
        // linkSocialAccount; this allowlist makes that change inert.
        const allowedCookieNames = [
          "oauth_state",                                 // default name
          `${COOKIE_PREFIX}.oauth_state`,                // prefixed
          `__Secure-${COOKIE_PREFIX}.oauth_state`,       // secure-prefixed (HTTPS prod)
        ];
        const linkCookies = getSetCookieHeaders(linkResult.headers);
        const forwarded: string[] = [];
        for (const cookie of linkCookies) {
          const cookieName = cookie.split("=")[0]?.trim() ?? "";
          if (allowedCookieNames.some((n) => cookieName === n || cookieName.startsWith(`${n}.`))) {
            response.headers.append("Set-Cookie", cookie);
            forwarded.push(cookieName);
          }
        }
        console.log(
          `[github oauth-bridge] hit userId=${bridge.userId} → GitHub OAuth (forwarded ${forwarded.length} state cookie(s): ${forwarded.join(", ")})`,
        );
        return response;
      }

      // No URL — log the actual response body so we can see what Better
      // Auth is complaining about. Without this we just see "no URL" and
      // have no signal on whether it's an auth issue, a config issue,
      // or something else.
      console.error(
        `[github oauth-bridge] linkSocialAccount returned no URL — status=${status} body=${bodyText.slice(0, 300)}`,
      );
    }

    return c.html(
      renderCallbackHtml(
        "OAuth start failed",
        "Could not start GitHub OAuth. Try again or check the server logs.",
      ),
      500,
    );
  } catch (err) {
    console.error("[github oauth-bridge] failed:", err);
    return c.html(
      renderCallbackHtml(
        "OAuth start failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
      500,
    );
  }
}

/**
 * GET /api/cloud/github/oauth-success   (PUBLIC)
 *
 * Better Auth redirects here after the GitHub OAuth callback completes
 * and the `account` row has been written. We just render a friendly
 * close-window page; the dashboard picks up the new state on its next
 * /user-status refresh.
 */
export async function githubOauthSuccess(c: Context) {
  return c.html(
    renderCallbackHtml(
      "GitHub connected",
      "Your GitHub account is now linked. You can close this window — the dashboard will refresh automatically.",
      { closeAfterMs: 2000 },
    ),
  );
}

/**
 * POST /api/cloud/github/install-url
 *
 * Returns the central App's installation URL with a one-time state token
 * embedded as a query parameter. GitHub Apps preserve the `state` query
 * param through the install flow and append it to the Setup URL alongside
 * `installation_id` and `setup_action` — that's what lets us attribute
 * the install back to the userId that started the flow without requiring
 * a SaaS session cookie on the popup browser (the App's Setup URL on
 * github.com should be pointed at /api/cloud/github/install-callback
 * below — that handler does the attribution).
 *
 * Pre-condition: the caller has already completed GitHub OAuth via
 * /api/cloud/github/oauth-handoff. After OAuth, Better Auth has an
 * `account` row with providerId='github' for this user, so the install
 * webhook's findUserByGitHubId will succeed regardless of whether the
 * App's Setup URL is configured (defense in depth — install-callback
 * is the explicit path, webhook is the implicit path).
 */
export async function githubInstallUrl(c: Context) {
  // Bind the install state to the org OWNER — the resulting GitHub
  // installation belongs to the org, not the team member who clicked
  // Install. Every team member sees + uses the same installations via
  // resolveCloudOwner. Solo SaaS users (personal org) bind to themselves.
  const { ownerUserId } = await resolveCloudOwner(c);
  const state = await issueInstallState(ownerUserId);
  const baseUrl = githubAuth.getInstallUrl();
  const url = `${baseUrl}?state=${encodeURIComponent(state)}`;
  return c.json({ data: { url, state } });
}

/**
 * GET /api/cloud/github/install-callback?installation_id=X&setup_action=install&state=<token>
 *
 * Public endpoint (no session auth) — GitHub redirects the user's browser
 * here AFTER they approve the App installation on github.com. We use the
 * one-time state token (issued by githubInstallUrl and embedded into the
 * install URL) to recover the SaaS userId that started the flow, then
 * use the App-JWT (which only the SaaS holds) to read the installation
 * details and write the gitInstallation row. NO OAuth identity required.
 *
 * This is the atomic install-attribution path. It replaces the previous
 * webhook-only attribution (which silently dropped installs when the
 * user hadn't already linked GitHub OAuth on the SaaS — the broken case).
 * The webhook is still useful for catching uninstalls / suspends, but
 * installs are now claimed here authoritatively.
 *
 * Configure the GitHub App's Setup URL to this endpoint:
 *   https://api.openship.io/api/cloud/github/install-callback
 */
export async function githubInstallCallback(c: Context) {
  const installationIdRaw = c.req.query("installation_id");
  const setupAction = c.req.query("setup_action");
  const state = c.req.query("state");

  if (!installationIdRaw || !state) {
    return c.html(
      renderCallbackHtml(
        "Missing parameters",
        "GitHub redirect did not include the expected parameters. Try installing again from the dashboard.",
      ),
      400,
    );
  }

  // peekAndConsumeInstallState verifies+burns the state without the
  // userId-binding check that consumeInstallState does — the user's
  // browser hits this endpoint anonymously after the github.com
  // round-trip, so there's no session userId to compare against. The
  // 16-byte random state IS the binding.
  console.log(
    `[github install-callback] hit installation_id=${installationIdRaw} setup_action=${setupAction} state=${state.slice(0, 8)}…`,
  );
  const stateRow = await peekAndConsumeInstallState(state);
  if (!stateRow) {
    console.log("[github install-callback] state not found or expired");
    return c.html(
      renderCallbackHtml(
        "Install link expired",
        "This installation link expired or was already used. Start a new install from the dashboard.",
      ),
      400,
    );
  }
  const userId = stateRow.userId;
  const installationId = Number(installationIdRaw);
  if (!Number.isFinite(installationId)) {
    return c.html(
      renderCallbackHtml(
        "Invalid installation",
        `installation_id="${installationIdRaw}" is not a valid number.`,
      ),
      400,
    );
  }

  // setup_action="request" means the user lacked admin perms on the org
  // and submitted an approval request instead of installing directly.
  // GitHub will fire installation.created later when the admin approves;
  // at that point our webhook can take over (the org admin's userId may
  // also be linked). No row to write yet.
  if (setupAction === "request") {
    return c.html(
      renderCallbackHtml(
        "Installation requested",
        "An organization admin needs to approve the install. The Openship App will activate once approved.",
      ),
    );
  }

  try {
    // App-JWT lookup — SaaS holds the GitHub App private key, so this
    // works without any user OAuth token. Returns the installation's
    // account (org or user the App was installed on).
    const installation = await githubAuth.appFetch<{
      id: number;
      account: { login: string; id: number; avatar_url: string; type: string };
    }>(`https://api.github.com/app/installations/${installationId}`);

    // Resolve organizationId via the user's first membership; fall
    // back to their personal org (`org_<userId>` — always provisioned).
    // gitInstallation.organizationId is NOT NULL.
    const memberships = await repos.member
      .listByUser(userId)
      .catch(() => [] as Array<{ organizationId: string }>);
    const organizationId =
      memberships[0]?.organizationId ?? `org_${userId}`;

    await repos.gitInstallation.upsert({
      userId,
      organizationId,
      provider: "github",
      installationId,
      owner: installation.account.login.toLowerCase(),
      ownerType: installation.account.type,
      // providerUserId is the GitHub user id of the installer; we don't
      // have it here (GitHub doesn't include it on /app/installations/X
      // — it's only in the webhook payload's `sender`). Leaving null;
      // the webhook will fill it in on subsequent uninstall events.
      providerUserId: undefined,
      providerOwnerId: String(installation.account.id),
      isOrg: installation.account.type === "Organization",
    });

    await repos.auditEvent
      .create({
        organizationId,
        actorUserId: userId,
        eventType: "github.install",
        resourceType: "github",
        resourceId: String(installationId),
        ipAddress: c.var.clientIp,
        userAgent: c.req.header("user-agent") ?? null,
        before: null,
        after: {
          installationId,
          owner: installation.account.login,
          ownerType: installation.account.type,
        },
      })
      .catch((err) =>
        console.warn(
          "[github install-callback] audit emit failed:",
          err instanceof Error ? err.message : err,
        ),
      );

    return c.html(
      renderCallbackHtml(
        "GitHub App installed",
        `${installation.account.login} is now connected. You can close this window — the dashboard will pick up the install on next refresh.`,
        { closeAfterMs: 2500 },
      ),
    );
  } catch (err) {
    console.error("[github install-callback] failed:", err);
    return c.html(
      renderCallbackHtml(
        "Install attribution failed",
        `Could not finalize installation ${installationId}. Refresh the dashboard or try installing again. (${safeErrorMessage(err)})`,
      ),
      500,
    );
  }
}

function renderCallbackHtml(
  title: string,
  message: string,
  opts?: { closeAfterMs?: number },
): string {
  const closeScript = opts?.closeAfterMs
    ? `<script>setTimeout(() => window.close(), ${opts.closeAfterMs});</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Openship</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; color: #1a1a1a; background: #fafafa; }
    .card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06); }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
    p { font-size: 14px; line-height: 1.55; color: #555; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  ${closeScript}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * GET /api/cloud/github/installations
 *
 * The org owner's GitHub installations — every team member sees the
 * same list because they all belong to the org whose owner connected
 * GitHub. Read-through to GitHub refreshes the DB cache.
 */
export async function githubInstallations(c: Context) {
  const { ownerUserId } = await resolveCloudOwner(c);
  const installations = await githubAuth.getUserInstallations(ownerUserId);
  return c.json({
    data: installations.map((i) => ({
      id: i.id,
      login: i.account.login,
      avatarUrl: i.account.avatar_url,
      type: i.account.type,
    })),
  });
}

/**
 * POST /api/cloud/github/installation-token  { owner, repos? }
 *
 * Mints a short-lived (~60min) installation access token for the given
 * owner. Cloud signs the JWT with its private key and hits GitHub's
 * /access_tokens endpoint. Local uses the returned token directly
 * against github.com for the actual git clone — cloud never sees the
 * source code.
 *
 * SECURITY: `installationId` is intentionally NOT accepted from the
 * request body — a caller-supplied id is a privilege-escalation surface
 * (Bob could pass Alice's installation id and mint a token against her
 * GitHub App installation). The id is resolved server-side from
 * (ownerUserId, owner) via repos.gitInstallation.findByOwner. If the
 * org owner doesn't have an installation for `owner`, we return 404.
 */
export async function githubInstallationToken(c: Context) {
  const { ownerUserId } = await resolveCloudOwner(c);
  const body = await c.req.json<{
    owner?: string;
    repos?: string[];
  }>();
  if (!body.owner) {
    return c.json({ error: "owner is required" }, 400);
  }

  // Resolve installationId from the ORG OWNER's row — the org's GitHub
  // installations all live on the owner's account. Never trust the
  // client-supplied installationId.
  const installation = await repos.gitInstallation.findByOwner(ownerUserId, body.owner);
  if (!installation) {
    return c.json(
      { error: `No GitHub App installation found for ${body.owner}` },
      404,
    );
  }

  const token = await githubAuth
    .getInstallationToken(ownerUserId, body.owner, installation.installationId)
    .catch(() => null);
  if (!token) {
    return c.json(
      { error: `No GitHub App installation found for ${body.owner}` },
      404,
    );
  }

  // getInstallationToken caches the token for 50min; the returned
  // expiresAt is approximate — clients should not rely on it being
  // exact. The cloud-client refreshes ~5min before this.
  return c.json({
    data: {
      token,
      expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
    },
  });
}

/**
 * GET /api/cloud/github/user-status
 * The cloud-resolved OAuth identity (login, avatar) for the calling user.
 * Local renders this in the GitHub settings panel; the OAuth account itself
 * lives in cloud's Better-Auth, NOT in the self-hosted instance.
 */
export async function githubUserStatus(c: Context) {
  const userId = getUserId(c);
  const status = await githubAuth.getUserStatus(userId);
  if (!status.connected) {
    return c.json({ data: { connected: false as const } });
  }
  return c.json({
    data: {
      connected: true as const,
      login: status.login,
      avatarUrl: status.avatar_url,
      id: status.id,
    },
  });
}

