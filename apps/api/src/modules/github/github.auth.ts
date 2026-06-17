/**
 * GitHub auth - handles GitHub App JWT, installation tokens, and user tokens.
 *
 * This module is the single source of truth for authenticating with the GitHub API.
 * It manages:
 *   - App-level JWT generation (for GitHub App endpoints)
 *   - Installation access tokens (for repo-scoped operations)
 *   - User OAuth tokens (for user-scoped operations, via Better Auth)
 *   - A thin `githubFetch` helper that picks the right auth automatically
 *
 * In local / desktop mode, token resolution falls back to the machine's
 * `gh` CLI credentials - see `github.local-auth.ts`.
 *
 * Token caching uses a simple in-memory Map with TTL to avoid hitting
 * GitHub's token endpoint on every request.
 */

import crypto from "crypto";
import { repos } from "@repo/db";
import { APIError } from "better-auth/api";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import { createCacheStore, type CacheStore } from "../../lib/cache-store";
import { getLocalGhStatus, getLocalGhToken } from "./github.local-auth";
import type {
  GitHubConnectionState,
  GitHubInstallation,
  MappedAccount,
} from "./github.types";

// ─── Token cache ─────────────────────────────────────────────────────────────

/**
 * Cache TTL for installation IDs and installation access tokens.
 *
 * GitHub installation access tokens expire 60 minutes after they're
 * minted. We cache for 45 minutes — a 15-minute safety margin that
 * absorbs NTP clock skew between replicas, queue delays, and the
 * round-trip cost of refreshing. The token endpoint is rate-limited
 * per installation, so refreshing too aggressively is real cost.
 */
const GITHUB_TOKEN_CACHE_TTL_SECONDS = 45 * 60;

/**
 * Cache key shapes — all owned by this module. The shape matters for
 * invalidation: anything prefixed with `inst:user:${userId}:` or
 * `instToken:${userId}:` belongs to a single user; anything with
 * `inst:org:${organizationId}:` or `instToken:cloud:${organizationId}:`
 * belongs to a whole org and is shared between every member.
 *
 * Prefix-based invalidation (below) is the ONLY safe way to clear keys
 * containing a userId — substring matching would clobber unrelated
 * org keys whose IDs happen to share characters with the userId.
 */
let _tokenStore: Promise<CacheStore<string>> | null = null;

function getTokenStore(): Promise<CacheStore<string>> {
  if (!_tokenStore) {
    _tokenStore = createCacheStore<string>("gh-tokens", { maxSize: 5_000 });
  }
  return _tokenStore;
}

/**
 * Clear every cached entry that belongs to this user — both the
 * user-scoped installation-ID lookup AND the user-scoped installation
 * token mints. Called on OAuth disconnect, webhook installation
 * changes initiated by the user, and the sync of the user's local
 * installations table.
 *
 * Does NOT touch org-scoped entries; for that, see
 * `invalidateOrgGitHubCache`. The two are kept separate so a
 * teammate's OAuth disconnect doesn't blow away the whole org's
 * cached installations.
 */
export async function invalidateUserGitHubCache(userId: string): Promise<void> {
  const store = await getTokenStore();
  await store.invalidateByPrefix(`inst:user:${userId}:`);
  await store.invalidateByPrefix(`instToken:${userId}:`);
}

/**
 * Clear every cached entry scoped to an organization — used when an
 * installation belonging to a team changes (install/uninstall/suspend
 * webhook). All members of the org share these entries, so the whole
 * prefix is swept atomically.
 */
export async function invalidateOrgGitHubCache(organizationId: string): Promise<void> {
  const store = await getTokenStore();
  await store.invalidateByPrefix(`inst:org:${organizationId}:`);
  await store.invalidateByPrefix(`instToken:cloud:${organizationId}:`);
}

// ─── App-level JWT ───────────────────────────────────────────────────────────

/** Cached decoded PEM - decoded once from base64 on first use. */
let _cachedPrivateKey: string | null = null;

/**
 * Resolve the GitHub App private key from environment.
 * Supports two formats:
 *   - GITHUB_PRIVATE_KEY       - raw PEM string (multi-line)
 *   - GITHUB_PRIVATE_KEY_BASE64 - base64-encoded PEM (single env var line)
 * Decoded value is cached in memory.
 */
function resolvePrivateKey(): string {
  if (_cachedPrivateKey) return _cachedPrivateKey;

  if (env.GITHUB_PRIVATE_KEY) {
    _cachedPrivateKey = env.GITHUB_PRIVATE_KEY;
    return _cachedPrivateKey;
  }

  if (env.GITHUB_PRIVATE_KEY_BASE64) {
    _cachedPrivateKey = Buffer.from(env.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf-8");
    return _cachedPrivateKey;
  }

  throw new Error("GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_BASE64 is required");
}

/**
 * Generate a short-lived JWT for authenticating as the GitHub App itself.
 * Valid for 10 minutes (GitHub's maximum).
 *
 * Requires GITHUB_APP_ID and a private key env var.
 */
export function generateAppJwt(): string {
  const appId = env.GITHUB_APP_ID;
  if (!appId) {
    throw new Error("GITHUB_APP_ID is required");
  }

  const privateKey = resolvePrivateKey();
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

// ─── App-level API request ───────────────────────────────────────────────────

/**
 * Make an authenticated request as the GitHub App (not as an installation).
 * Used for endpoints like creating installation tokens.
 */
export async function appFetch<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const jwt = generateAppJwt();
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json() as T & { message?: string };
  if (!res.ok) {
    throw new Error(`GitHub App API error (${res.status}): ${data.message ?? "Unknown"}`);
  }
  return data;
}

// ─── Installation ID lookup ──────────────────────────────────────────────────

/**
 * Resolve the GitHub App installation ID for a given user + owner.
 * Checks cache first, then the database.
 *
 * User-scoped variant. Used by code paths that have no active org
 * context (background jobs, OAuth callbacks pre-membership-resolution).
 * When org context IS available, prefer `getInstallationIdByOrg`.
 */
export async function getInstallationId(
  userId: string,
  owner: string,
): Promise<number | null> {
  if (!owner) return null;

  // Cloud-app mode: ALWAYS ask SaaS. api.openship.io is the canonical
  // store — the GitHub App webhook fires to SaaS, not to us, so its
  // record is authoritative. Skip the local DB entirely; a stale row
  // would lie for up to 50min after a user uninstalls / re-installs.
  // tokenCache provides short-term memoization (50min TTL) so we don't
  // hammer SaaS on every preflight.
  const mode = await resolveGitHubAuthMode(userId).catch(() => "none" as const);
  if (mode === "cloud-app") {
    // Resolve the user's primary org (first membership or personal
    // org) — cloudGithubInstallations is org-keyed and the resolved
    // owner's installations is the canonical SaaS-side state. Cache
    // by org so all members of the same org share the entry.
    const memberships = await repos.member.listByUser(userId).catch(() => []);
    const organizationId = memberships[0]?.organizationId ?? `org_${userId}`;
    const cacheKey = `inst:org:${organizationId}:${owner.toLowerCase()}`;
    const store = await getTokenStore();
    const cached = await store.get(cacheKey);
    if (cached) return Number(cached);
    const { cloudGithubInstallations } = await import("../../lib/cloud-client");
    const list = await cloudGithubInstallations(organizationId).catch(() => null);
    if (!list) return null;
    const match = list.find(
      (entry) => entry.login.toLowerCase() === owner.toLowerCase(),
    );
    if (!match) return null;
    await store.set(cacheKey, String(match.id), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return match.id;
  }

  // Self-hosted "app" mode below — cache by user since the local DB
  // installations are per-user rows.
  const cacheKey = `inst:user:${userId}:${owner.toLowerCase()}`;
  const store = await getTokenStore();
  const cached = await store.get(cacheKey);
  if (cached) return Number(cached);

  // Self-hosted "app" mode — local DB is the only store, since the
  // webhook fired here.
  const row = await repos.gitInstallation.findByOwner(userId, owner);
  if (!row) return null;

  await store.set(cacheKey, String(row.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
  return row.installationId;
}

/**
 * Resolve the GitHub App installation ID for a given organization + owner.
 *
 * The preferred multi-user lookup path. Multiple members of the same org
 * share access to the org's installations — scoping by `organizationId`
 * survives membership churn (members leaving) and lets any teammate use
 * an installation that another teammate originally connected.
 */
export async function getInstallationIdByOrg(
  organizationId: string,
  owner: string,
): Promise<number | null> {
  if (!organizationId || !owner) return null;

  const cacheKey = `inst:org:${organizationId}:${owner.toLowerCase()}`;
  const store = await getTokenStore();
  const cached = await store.get(cacheKey);
  if (cached) return Number(cached);

  // Cloud-app mode: SaaS is the source of truth. cloudGithubInstallations
  // resolves the org owner internally and returns the team's
  // installations in one round-trip — no member iteration needed.
  const ownerMember = (await repos.member
    .listByOrganization(organizationId)
    .catch(() => [] as Array<{ userId: string; role: string }>))
    .find((m) => m.role === "owner");
  const mode = ownerMember
    ? await resolveGitHubAuthMode(ownerMember.userId).catch(() => "none" as const)
    : ("none" as const);

  if (mode === "cloud-app") {
    const { cloudGithubInstallations } = await import("../../lib/cloud-client");
    const list = await cloudGithubInstallations(organizationId).catch(() => null);
    if (!list) return null;
    const match = list.find(
      (entry) => entry.login.toLowerCase() === owner.toLowerCase(),
    );
    if (!match) return null;
    await store.set(cacheKey, String(match.id), GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return match.id;
  }

  // Self-hosted "app" mode. The webhook fires to us, so local DB is
  // the source of truth.
  const row = await repos.gitInstallation.findByOrgAndOwner(organizationId, owner);
  if (!row) return null;

  await store.set(cacheKey, String(row.installationId), GITHUB_TOKEN_CACHE_TTL_SECONDS);
  return row.installationId;
}

// ─── Installation access token ───────────────────────────────────────────────

/**
 * Get an installation access token (scoped to the installed repos).
 *
 * Tokens are cached for 50 minutes (GitHub tokens expire after 60).
 *
 * Path branches on the user's resolved auth mode:
 *   - "app"       → local JWT signing + api.github.com call (cloud-mode only)
 *   - "cloud-app" → cloud-client proxy to api.openship.io
 *
 * Other modes (cli/oauth/token) don't use installation tokens.
 *
 * Resolution order for the installation row when `installationId` is not
 * provided:
 *   1. `organizationId` + owner → preferred multi-user path.
 *   2. `userId` + owner         → single-user fallback for callers that
 *                                 don't have org context.
 */
export async function getInstallationToken(
  userId: string,
  owner: string,
  installationId?: number,
  organizationId?: string,
): Promise<string | null> {
  const mode = await resolveGitHubAuthMode(userId);

  if (mode === "cloud-app") {
    // Proxy through cloud. Resolve the user's primary org when no
    // organizationId is in scope so the SaaS-side owner-resolution
    // still works for background/OAuth-callback callers. Cache by org
    // so all members of the same org share the cache entry.
    const orgId = organizationId
      ?? (await repos.member.listByUser(userId).catch(() => []))[0]?.organizationId
      ?? `org_${userId}`;
    const cacheKey = `instToken:cloud:${orgId}:${owner}`;
    const store = await getTokenStore();
    const cached = await store.get(cacheKey);
    if (cached) return cached;

    const { cloudGithubInstallationToken } = await import("../../lib/cloud-client");
    const minted = await cloudGithubInstallationToken(orgId, {
      installationId,
      owner,
    });
    if (!minted?.token) return null;
    await store.set(cacheKey, minted.token, GITHUB_TOKEN_CACHE_TTL_SECONDS);
    return minted.token;
  }

  // Local-mint path (cloud-mode SaaS, or explicit GITHUB_AUTH_MODE=app).
  // Prefer the org-scoped row when an organizationId is in play, then
  // fall back to the per-user row.
  if (!installationId) {
    if (organizationId) {
      installationId =
        (await getInstallationIdByOrg(organizationId, owner)) ?? undefined;
    }
    if (!installationId) {
      installationId = (await getInstallationId(userId, owner)) ?? undefined;
    }
  }
  if (!installationId) return null;

  const cacheKey = `instToken:${userId}:${owner}:${installationId}`;
  const store = await getTokenStore();
  const cached = await store.get(cacheKey);
  if (cached) return cached;

  const data = await appFetch<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
  );

  await store.set(cacheKey, data.token, GITHUB_TOKEN_CACHE_TTL_SECONDS);
  return data.token;
}

// ─── User OAuth token ────────────────────────────────────────────────────────

/**
 * Get the user's personal GitHub OAuth token stored by Better Auth.
 * Used for user-scoped operations (listing their orgs, etc.).
 */
export async function getUserToken(userId: string): Promise<string | null> {
  try {
    const tokens = await auth.api.getAccessToken({
      body: {
        providerId: "github",
        userId,
      },
    });

    return tokens.accessToken ?? null;
  } catch (error) {
    if (error instanceof APIError) {
      return null;
    }

    throw error;
  }
}

// ─── Unified token resolver ──────────────────────────────────────────────────

export interface TokenOptions {
  userId: string;
  owner?: string;
  installationId?: number;
  /** Active organization id. Required for the operator-only gh-cli gate
   *  in self-hosted mode — without it, non-owners would silently fall
   *  back to the operator's broad-scope CLI token. Optional because
   *  background jobs / internal callers without an org context
   *  legitimately want the user-scoped resolution path. */
  organizationId?: string;
}

/**
 * Resolve a GitHub token for a generic API call. Delegates to the
 * `tokenFor` dispatcher in github.token.ts (purpose=local) which owns
 * the full priority chain (PAT → installation → OAuth).
 */
export async function resolveToken(opts: TokenOptions): Promise<string | null> {
  const { tokenFor } = await import("./github.token");
  const r = await tokenFor(opts.userId, "local", {
    owner: opts.owner,
    installationId: opts.installationId,
    organizationId: opts.organizationId,
  });
  return r?.token ?? null;
}

// ─── GitHub API fetch helper ─────────────────────────────────────────────────

export interface GitHubFetchOptions {
  userId: string;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  owner?: string;
  installationId?: number;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Active organization id — threaded into `resolveToken` so the
   *  operator-only gh-cli gate fires for self-hosted multi-user installs.
   *  See TokenOptions.organizationId. */
  organizationId?: string;
}

/**
 * Make an authenticated GitHub API request on behalf of a user.
 *
 * Automatically resolves the correct token (installation or user OAuth).
 * Appends query params for GET requests, sends JSON body for others.
 */
export async function githubFetch<T = unknown>(opts: GitHubFetchOptions): Promise<T> {
  const method = opts.method ?? "GET";

  const token = await resolveToken({
    userId: opts.userId,
    owner: opts.owner,
    installationId: opts.installationId,
    organizationId: opts.organizationId,
  });

  if (!token) {
    throw new Error("No GitHub access token available. Please connect your GitHub account.");
  }

  let url = opts.url;
  if (method === "GET" && opts.params) {
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.params)) {
      entries[k] = String(v);
    }
    const qs = new URLSearchParams(entries).toString();
    url = qs ? `${url}?${qs}` : url;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers ?? {}),
    },
    body: method !== "GET" ? JSON.stringify(opts.params ?? {}) : undefined,
  });

  /* Some endpoints return 204 No Content */
  if (res.status === 204) {
    return { success: true } as T;
  }

  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}): ${(data as { message?: string }).message ?? "Unknown"}`);
  }
  return data;
}

// ─── User status helpers ─────────────────────────────────────────────────────

/**
 * Check if the user is connected to GitHub and return their profile.
 *
 * Path branches on the per-user resolved auth mode:
 *   - "cloud-app" → cloud-client proxy (cloud owns the OAuth identity)
 *   - "app" / "oauth" → user OAuth token (local Better-Auth)
 *   - "cli"           → OAuth first, then gh CLI fallback
 *   - "token"         → static GITHUB_TOKEN env var
 */
export async function getUserStatus(userId: string) {
  const mode = await resolveGitHubAuthMode(userId);

  // ── Cloud-app: status comes from openship.io ────────────────────────────
  if (mode === "cloud-app") {
    const { cloudGithubUserStatus } = await import("../../lib/cloud-client");
    const status = await cloudGithubUserStatus(userId);
    if (!status?.connected) {
      return { connected: false as const, tokenSource: null };
    }
    return {
      connected: true as const,
      tokenSource: "cloud-app" as GitHubAuthMode,
      oauthConnected: true as const,
      login: status.login ?? "",
      id: status.id ?? 0,
      avatar_url: status.avatarUrl ?? "",
    };
  }

  let token: string | null = null;
  let tokenSource: GitHubAuthMode = mode;

  switch (mode) {
    case "token":
      token = env.GITHUB_TOKEN ?? null;
      break;
    case "cli": {
      token = await getUserToken(userId);
      if (token) { tokenSource = "oauth"; break; }
      // gh CLI fallback - only if the user hasn't explicitly disconnected it.
      // Otherwise a user who clicked "Disconnect" from cli mode would silently
      // stay connected because gh is still authed on the host.
      const { isGithubCliDisabled } = await import("../settings/settings.service");
      const cliDisabled = await isGithubCliDisabled(userId);
      if (cliDisabled) break;
      token = await getLocalGhToken();
      tokenSource = "cli";
      break;
    }
    default: // "app" | "oauth"
      token = await getUserToken(userId);
      tokenSource = "oauth";
      break;
  }

  if (!token) {
    return { connected: false as const, tokenSource: null };
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      return { connected: false as const, tokenSource: null };
    }
    const user = (await res.json()) as { login: string; id: number; avatar_url: string };
    return { connected: true as const, tokenSource, oauthConnected: true as const, ...user };
  } catch {
    return { connected: false as const, tokenSource: null };
  }
}

// ─── Canonical connection state (single source of truth) ────────────────────

/**
 * THE canonical GitHub connection state. Every place in the codebase that
 * asks "is GitHub connected?", "which source is active?", or "is gh CLI
 * available?" reads this. There is no other answer.
 *
 * What it does NOT return:
 *   - `mode`/"saas-app"/"self-hosted" → that's `env.CLOUD_MODE` / `platform()`.
 *     The global platform mode is already the source of truth for that
 *     concept; this function doesn't duplicate it.
 *   - `tokenSource`/"app"|"oauth"|"cli"|"token"|"cloud-app" → those are
 *     INTERNAL token-strategy details of `resolveToken`. They don't belong
 *     on the wire.
 *
 * Priority for `primary`:
 *   1. Openship App when connected — safest (short-lived install tokens)
 *   2. gh CLI when available — local builds only
 *   3. null — nothing usable
 */
export async function getGitHubConnectionState(
  userId: string,
): Promise<GitHubConnectionState> {
  const onSelfHosted = !env.CLOUD_MODE;

  // ── Openship App side ──────────────────────────────────────────────
  // In CLOUD_MODE the App is local-signed; in self-hosted+cloud-connected
  // the App is cloud-proxied. Both flow through getUserStatus which
  // already abstracts that.
  //
  // Tolerant of failure: when the user has a stale cloud session token
  // but the cloud endpoint is unreachable (dev down, DNS, HTML 200
  // captive page, etc.), getUserStatus may throw or return false.
  // Either way, we just say "App not connected" and let gh CLI take
  // over. The library page must NEVER 500 because cloud is offline.
  let appConnected = false;
  let appLogin: string | undefined;
  let appAvatar: string | undefined;
  let hasInstallations: boolean | undefined;
  try {
    // App is connected ONLY when SaaS reports a real GitHub OAuth
    // identity for this user. The Connect flow runs OAuth on SaaS first
    // (creating a Better Auth `account` row for providerId='github'),
    // so this signal is load-bearing. Without it the install webhook
    // can't attribute installs to a SaaS user and the dashboard would
    // be lying if it showed "connected".
    const status = await getUserStatus(userId);
    appConnected = status.connected && status.tokenSource !== "cli";
    if (appConnected && status.connected) {
      appLogin = status.login;
      appAvatar = status.avatar_url;
      // Cheap "has installations" lookup — needed by the dashboard to
      // decide whether to offer "install on this org" vs "you're set".
      try {
        const installs = await getUserInstallations(userId, status);
        hasInstallations = installs.length > 0;
      } catch {
        hasInstallations = undefined;
      }
    }
  } catch {
    // Cloud unreachable / OAuth fetch failed / network blip. App side
    // is "not connected"; gh CLI fallback below still runs.
    appConnected = false;
  }

  // ── gh CLI side ────────────────────────────────────────────────────
  // Only meaningful on self-hosted. On the SaaS the binary isn't there.
  // Single rule: `gh auth token` is valid → connected. `gh auth logout`
  // is the durable way to disconnect. We do NOT consult any per-user
  // suppression flag here — the user already said this is the rule:
  // "if gh cli logged in, use it as source of truth."
  let cliAvailable = false;
  let cliLogin: string | undefined;
  let cliAvatar: string | undefined;
  if (onSelfHosted) {
    const localStatus = await getLocalGhStatus();
    if (localStatus.available) {
      cliAvailable = true;
      cliLogin = localStatus.login;
      cliAvatar = localStatus.avatar_url;
    }
  }

  // ── Resolve primary per the user-stated priority ───────────────────
  const primary: GitHubConnectionState["primary"] = appConnected
    ? "openship-app"
    : cliAvailable
      ? "gh-cli"
      : null;

  return {
    sources: {
      openshipApp: {
        connected: appConnected,
        login: appLogin,
        avatarUrl: appAvatar,
        hasInstallations,
      },
      ghCli: {
        available: cliAvailable,
        login: cliLogin,
        avatarUrl: cliAvatar,
      },
    },
    primary,
  };
}

/**
 * Get all GitHub App installations that the user has access to.
 *
 * Path branches on per-user mode:
 *   - "cloud-app" → cloud-client proxy. Cloud owns the canonical list.
 *   - others      → user OAuth token + GitHub /user/installations call,
 *                   with local DB sync. Stored snapshot is the fallback
 *                   when the live lookup fails after OAuth was validated.
 */
export async function getUserInstallations(
  userId: string,
  status?: { connected: boolean; id?: number },
): Promise<GitHubInstallation[]> {
  const mode = await resolveGitHubAuthMode(userId);

  if (mode === "cloud-app") {
    // SaaS is the canonical source of truth — the GitHub App's webhook
    // fires to api.openship.io, not to us, so api.openship.io is the
    // only place that reliably knows about installations. We do NOT
    // cache to local DB here: a stale local row would lie for up to
    // 50 minutes after the user uninstalls or moves the App, and the
    // local row offers no benefit since every consumer ultimately
    // mints the token via the cloud proxy anyway.
    //
    // Short-term memoization is handled by `tokenCache` in the
    // per-resource lookups (getInstallationId / getInstallationIdByOrg).
    const { cloudGithubInstallations } = await import("../../lib/cloud-client");
    const memberships = await repos.member.listByUser(userId).catch(() => []);
    const organizationId = memberships[0]?.organizationId ?? `org_${userId}`;
    const list = await cloudGithubInstallations(organizationId);
    if (!list) return [];
    return list.map((entry) => ({
      id: entry.id,
      account: {
        login: entry.login,
        id: 0,
        avatar_url: entry.avatarUrl,
        type: entry.type,
      },
      app_id: 0,
      target_type: entry.type,
      permissions: {},
      events: [],
    }));
  }

  const token = await getUserToken(userId);
  if (!token) return [];

  try {
    const userStatus = status ?? await getUserStatus(userId);
    if (!userStatus.connected) return [];

    const data = await githubFetch<{ installations: GitHubInstallation[] }>({
      userId,
      url: "https://api.github.com/user/installations",
    });

    const installations = data.installations ?? [];

    try {
      // No Hono context here (this also runs from background sync paths),
      // so resolve the org via the user's first membership — same fallback
      // the active-org middleware uses. Null is acceptable; the column is
      // nullable and a future audit pass can re-stamp NULL rows.
      const memberships = await repos.member.listByUser(userId).catch(() => []);
      const organizationId = memberships[0]?.organizationId ?? null;

      await repos.gitInstallation.replaceForUser(
        userId,
        installations.map((installation) => ({
          organizationId,
          installationId: installation.id,
          owner: installation.account.login,
          ownerType: installation.account.type,
          providerUserId: userStatus.id ? String(userStatus.id) : undefined,
          providerOwnerId: String(installation.account.id),
          isOrg: installation.account.type === "Organization",
        })),
      );
      await invalidateUserGitHubCache(userId);
    } catch (err) {
      console.warn("[GitHub] Failed to sync installations:", (err as Error).message);
    }

    return installations;
  } catch {
    return getStoredInstallations(userId);
  }
}

async function getStoredInstallations(userId: string): Promise<GitHubInstallation[]> {
  const installations = await repos.gitInstallation.listByUser(userId);
  return installations.map((installation) => ({
    id: installation.installationId,
    account: {
      login: installation.owner,
      id: storedAccountId(installation.providerOwnerId),
      avatar_url: storedAccountAvatarUrl(installation.owner, installation.providerOwnerId),
      type: installation.ownerType === "Organization" ? "Organization" : "User",
    },
    app_id: Number(env.GITHUB_APP_ID ?? 0),
    target_type: installation.ownerType,
    permissions: {},
    events: [],
  }));
}

function storedAccountId(providerOwnerId?: string | null): number {
  const id = Number(providerOwnerId);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function storedAccountAvatarUrl(owner: string, providerOwnerId?: string | null): string {
  const id = storedAccountId(providerOwnerId);
  if (id > 0) return `https://avatars.githubusercontent.com/u/${id}?v=4`;
  return `https://github.com/${encodeURIComponent(owner)}.png`;
}

/**
 * Map raw installation data to a clean account summary.
 */
export function mapAccounts(installations: GitHubInstallation[]): MappedAccount[] {
  return installations.map((i) => ({
    login: i.account.login,
    id: i.account.id,
    avatar_url: i.account.avatar_url,
    type: i.account.type,
  }));
}

// ─── Connect / Disconnect ────────────────────────────────────────────────────

// ─── GitHub auth mode ─────────────────────────────────────────────────────

export type GitHubAuthMode = "app" | "oauth" | "cli" | "token" | "cloud-app";

/**
 * Resolve the effective GitHub auth mode (SYNC — caller has no userId).
 *
 * Used by code paths that need a mode without a user context (e.g. boot-
 * time checks, batch jobs). Returns the LOCAL-only resolution:
 *   - CLOUD_MODE=true  → "app"  (this IS api.openship.io — holds App creds)
 *   - CLOUD_MODE=false → "cli"  (defaults to local gh CLI for offline use)
 *
 * Per-user requests should call `resolveGitHubAuthMode(userId)` instead
 * — that one returns `"cloud-app"` when the user is connected to openship
 * cloud, which is the canonical self-hosted path.
 */
export function getGitHubAuthMode(): GitHubAuthMode {
  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;

  if (env.CLOUD_MODE) return "app";
  return "cli";
}

/**
 * Per-user mode resolution (ASYNC).
 *
 * The canonical answer for any request that has a userId. Resolution:
 *
 *   1. Explicit `GITHUB_AUTH_MODE` env var → used as-is (escape hatch).
 *   2. `CLOUD_MODE=true` (this IS api.openship.io) → "app".
 *   3. Self-hosted + the user is connected to Openship Cloud → "cloud-app".
 *      All App-scoped operations (install URL, list installations, mint
 *      install token, OAuth identity) proxy through api.openship.io.
 *   4. Self-hosted + NOT cloud-connected → "cli" (the gh CLI / PAT
 *      escape hatch — no App-scoped features available).
 */
export async function resolveGitHubAuthMode(userId: string): Promise<GitHubAuthMode> {
  const explicit = env.GITHUB_AUTH_MODE;
  if (explicit !== "auto") return explicit as GitHubAuthMode;

  if (env.CLOUD_MODE) return "app";

  // Self-hosted: check cloud connection per user.
  try {
    const { isCloudConnected } = await import("../../lib/cloud-client");
    if (await isCloudConnected(userId)) return "cloud-app";
  } catch {
    // If the cloud-client import / DB read fails, fall through to cli.
  }
  return "cli";
}

/** Shorthand - true when the resolved auth mode is "app" or "cloud-app"
 *  (i.e. any GitHub App-scoped flow, whether locally signed or proxied). */
export function isCloudMode(): boolean {
  const mode = getGitHubAuthMode();
  return mode === "app" || mode === "cloud-app";
}

/**
 * Get the GitHub App installation URL (sync, local-only).
 *
 * Used when this process IS the App owner — i.e. cloud-mode SaaS or an
 * explicit GITHUB_AUTH_MODE=app self-host with creds set. For the
 * canonical self-hosted path (cloud-app), use `resolveInstallUrl(userId)`
 * which proxies through openship.io and returns a state-bound URL.
 */
export function getInstallUrl(): string {
  // Single source of truth: env.GITHUB_APP_SLUG defaults to "openship-io"
  // via the zod schema in apps/api/src/config/env.ts. No fallback needed
  // here — the schema guarantees a value.
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;
}

/**
 * Per-user install URL resolution. In cloud-app mode this round-trips
 * through openship.io to get a state-bound URL; otherwise returns the
 * sync `getInstallUrl()` result. `state` is empty string when not
 * applicable (local-app mode).
 */
export async function resolveInstallUrl(
  userId: string,
): Promise<{ url: string; state: string }> {
  const mode = await resolveGitHubAuthMode(userId);
  if (mode === "cloud-app") {
    // Bind the install to the user's org owner so the resulting
    // installation belongs to the team, not the clicking member.
    const memberships = await repos.member.listByUser(userId).catch(() => []);
    const organizationId = memberships[0]?.organizationId ?? `org_${userId}`;
    const { cloudGithubInstallUrl } = await import("../../lib/cloud-client");
    const res = await cloudGithubInstallUrl(organizationId);
    if (res) return res;
    // Cloud unreachable — fall back to the canonical install URL with no
    // state. The exchange will fail later if the user actually installs,
    // but at least they can SEE the install screen.
  }
  return { url: getInstallUrl(), state: "" };
}

/**
 * Resolve the GitHub OAuth start URL for this user.
 *
 * Cloud-app mode (self-hosted + Openship Cloud connected): proxies to the
 * SaaS's /oauth-handoff endpoint, which mints a single-use bridge URL.
 * The browser opens that URL and the SaaS handles the entire OAuth
 * round-trip — local never has GitHub OAuth credentials. After OAuth
 * completes, the SaaS has a Better Auth `account` row for this user.
 *
 * App mode (this IS the SaaS): linkSocialAccount is called directly via
 * the controller's connectRedirect handler — the OAuth flow runs in the
 * same process. resolveOauthHandoffUrl is not used.
 *
 * cli mode (self-hosted + NO cloud): there's no GitHub OAuth flow
 * available — the user can only use gh CLI. Returns null.
 */
export async function resolveOauthHandoffUrl(
  userId: string,
): Promise<{ url: string } | null> {
  const mode = await resolveGitHubAuthMode(userId);
  if (mode !== "cloud-app") return null;

  const { cloudGithubOauthHandoff } = await import("../../lib/cloud-client");
  return cloudGithubOauthHandoff(userId);
}

/**
 * Disconnect a user from a GitHub source.
 *
 * `source`:
 *   - "oauth" → remove the OAuth account row (Openship App / standalone OAuth)
 *   - "cli"   → set the cli-suppression flag so the host's `gh auth token`
 *               is ignored even when present. NEVER touches the host's gh
 *               config - we only refuse to use it.
 *   - "all"   → both of the above (default - preserves the old contract)
 *
 * GitHub App installations remain until GitHub sends uninstall/suspend events.
 */
export async function disconnectUser(
  userId: string,
  source: "oauth" | "cli" | "all" = "all",
): Promise<void> {
  if (source === "oauth" || source === "all") {
    await repos.account.unlinkProvider(userId, "github");
  }
  if (source === "cli" || source === "all") {
    const { setGithubCliDisabled } = await import("../settings/settings.service");
    await setGithubCliDisabled(userId, true);
  }
  await invalidateUserGitHubCache(userId);
}
