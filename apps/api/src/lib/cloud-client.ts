/**
 * Cloud client - used by local/self-hosted instances to get
 * an Oblien namespace token from api.openship.io.
 *
 * Auth is fully server-side: the user's Openship Cloud session
 * is stored (encrypted) in user_settings.cloud_session_token.
 * This module reads it from DB, fetches namespace tokens from
 * the SaaS API, and caches them in memory.
 *
 * No client-side cookies or tokens involved.
 */

import { repos } from "@repo/db";
import type { CloudPreflightData } from "./cloud-preflight";
import { cloudRuntimeTarget } from "../config/env";
import { decrypt } from "./encryption";

export interface CloudAccount {
  name: string;
  email: string;
  image?: string | null;
}

// ─── Namespace token cache ───────────────────────────────────────────────────

interface TokenCache {
  token: string;
  namespace: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, TokenCache>();
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Authenticated cloud fetch ───────────────────────────────────────────────

/**
 * Make an authenticated request to the SaaS API using the stored cloud session.
 *
 * Handles: read session → decrypt → Bearer auth → 401 session cleanup.
 * Returns the Response, or null if not connected.
 */
async function cloudFetch(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) return null;

  const sessionToken = decrypt(settings.cloudSessionToken);

  let res: Response;
  try {
    res = await fetch(`${cloudRuntimeTarget.api}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
        Authorization: `Bearer ${sessionToken}`,
      },
    });
  } catch {
    // Network error (ECONNREFUSED, DNS failure, timeout, etc.)
    return null;
  }

  if (res.status === 401) {
    await repos.settings.update(userId, { cloudSessionToken: null });
    tokenCache.delete(userId);
  }

  return res;
}

/**
 * Org-bearing variant of cloudFetch. Resolves the org owner's cloud
 * session token via findOrgOwnerCloudLink, then makes the call as
 * that user. Every org-scoped cloud bridge function uses this — the
 * pattern is "any member of the org gets to act with the owner's
 * SaaS identity for org-scoped operations".
 *
 * Returns null when no member of the org has linked Openship Cloud.
 */
async function cloudFetchAsOrgOwner(
  organizationId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const linked = await repos.settings
    .findOrgOwnerCloudLink(organizationId)
    .catch(() => undefined);
  if (!linked) return null;
  return cloudFetch(linked.userId, path, init);
}

/**
 * Defensive JSON parser for cloud responses. Cloud endpoints SHOULD
 * return application/json — but a dev server may serve a 200 HTML
 * error page, or a proxy may return a captive-portal page, etc.
 * `.json()` on that body throws "Unexpected token '<'" and crashes
 * the calling handler.
 *
 * Use this for every cloud-client read: returns the parsed JSON when
 * the body is real JSON, otherwise null (caller treats as unreachable).
 */
async function readCloudJson<T>(res: Response): Promise<T | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── Cloud session management ────────────────────────────────────────────────

/**
 * Disconnect from Openship Cloud.
 *
 * Two-step: (1) tell SaaS to revoke the session row server-side, then
 * (2) clear the local copy. Step 1 is best-effort — if SaaS is
 * unreachable we still clear locally so the user isn't stuck. Without
 * step 1 the SaaS session would linger for its full 30-day TTL,
 * usable by anyone who exfiltrated the token from local DB before the
 * disconnect.
 */
export async function disconnectCloud(userId: string): Promise<void> {
  try {
    const res = await cloudFetch(userId, "/api/cloud/disconnect", {
      method: "POST",
    });
    if (res && !res.ok) {
      console.warn(
        `[cloud disconnect] SaaS returned ${res.status} on session revoke; clearing local anyway`,
      );
    }
  } catch (err) {
    console.warn(
      `[cloud disconnect] SaaS revoke failed (clearing local anyway):`,
      err instanceof Error ? err.message : err,
    );
  }
  await repos.settings.update(userId, { cloudSessionToken: null });
  tokenCache.delete(userId);
}

/**
 * Check whether the user has a stored cloud session.
 */
export async function isCloudConnected(userId: string): Promise<boolean> {
  const settings = await repos.settings.findByUser(userId);
  return !!settings?.cloudSessionToken;
}

export async function getCloudConnectionStatus(
  userId: string,
): Promise<{ connected: boolean; user?: CloudAccount }> {
  const settings = await repos.settings.findByUser(userId);
  if (!settings?.cloudSessionToken) {
    return { connected: false };
  }

  const res = await cloudFetch(userId, "/api/cloud/account", { method: "GET" });

  if (!res) {
    return { connected: true };
  }

  if (res.status === 401) {
    return { connected: false };
  }

  if (!res.ok) {
    return { connected: true };
  }

  const json = await readCloudJson<{ user?: CloudAccount }>(res);
  if (!json) return { connected: true };
  return json.user
    ? { connected: true, user: json.user }
    : { connected: true };
}

// ─── Namespace token fetching ────────────────────────────────────────────────

/**
 * Get a valid namespace-scoped Oblien token for a user.
 *
 * Reads the stored cloud session from DB, calls POST /api/cloud/token
 * on the SaaS API, caches the result in memory.
 *
 * Returns null if the user isn't connected to Openship Cloud.
 */
export async function getCloudToken(
  userId: string,
): Promise<{ token: string; namespace: string } | null> {
  // Check memory cache first
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return { token: cached.token, namespace: cached.namespace };
  }

  const res = await cloudFetch(userId, "/api/cloud/token", { method: "POST" });
  if (!res || !res.ok) return null;

  const json = await readCloudJson<{
    data: { token: string; namespace: string; expiresAt: string };
  }>(res);
  if (!json?.data) return null;

  const { token, namespace, expiresAt } = json.data;

  tokenCache.set(userId, {
    token,
    namespace,
    expiresAt: new Date(expiresAt).getTime(),
  });

  return { token, namespace };
}

/**
 * Org-scoped cloud-token lookup. Returns the owner's cloud token —
 * only the owner can link Openship Cloud, and their connection is the
 * org's cloud identity for every member to use under the hood.
 */
export async function getOrgCloudToken(
  organizationId: string,
): Promise<{ token: string; namespace: string; userId: string } | null> {
  const settings = await repos.settings
    .findOrgOwnerCloudLink(organizationId)
    .catch(() => undefined);
  if (!settings) return null;
  const token = await getCloudToken(settings.userId);
  if (!token) return null;
  return { ...token, userId: settings.userId };
}

/**
 * Preflight is org-scoped (slug availability, custom-domain DNS,
 * namespace quota all check against the org owner's namespace).
 */
export async function getCloudPreflight(
  organizationId: string,
  input: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData | null> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/preflight", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res || !res.ok) return null;
  const json = await readCloudJson<{ data: CloudPreflightData }>(res);
  return json?.data ?? null;
}

// ─── Edge proxy sync ─────────────────────────────────────────────────────────

/**
 * Ask the SaaS to create/update an Oblien edge proxy for a managed domain.
 *
 * Sends just the slug + target IP - the SaaS constructs the full domain.
 */
export async function syncEdgeProxy(
  organizationId: string,
  slug: string,
  target: string,
): Promise<void> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/edge-proxy", {
    method: "POST",
    body: JSON.stringify({ slug, target }),
  });
  if (!res) {
    throw new Error(
      "Cannot sync edge proxy: no member of this organization has linked Openship Cloud",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Edge proxy sync failed (${res.status}): ${text}`);
  }
}

// ─── Analytics proxy ─────────────────────────────────────────────────────────

/**
 * Proxy an analytics call through the SaaS using master Oblien credentials.
 *
 * Edge proxies + analytics are account-level - namespace tokens can't access them.
 * Local/desktop instances call this; the SaaS uses its master client.
 */
export async function cloudAnalyticsProxy<T>(
  organizationId: string,
  operation: "timeseries" | "requests" | "streamToken",
  domain: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/analytics", {
    method: "POST",
    body: JSON.stringify({ operation, domain, params }),
  });
  if (!res?.ok) return null;
  return readCloudJson<T>(res);
}

// ─── Pages proxy ─────────────────────────────────────────────────────────────

/**
 * Proxy an Oblien pages.create call through the SaaS using master
 * credentials. Required for `domain: "opsh.io"` (or any shared zone) —
 * namespace tokens can't create on account-level DNS.
 *
 * Returns the raw `{ page: { slug, url? } }` shape Oblien's SDK
 * returns, so the call site can drop it into the existing flow with
 * no changes. Throws on failure (caller wraps with a friendly error).
 */
export async function cloudPagesProxy(
  organizationId: string,
  input: {
    workspace_id: string;
    path: string;
    name: string;
    slug: string;
    domain?: string;
  },
): Promise<{ page: { slug: string; url?: string | null } }> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/pages", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res) {
    throw new Error("Not connected to Openship Cloud — connect your account in Settings.");
  }

  if (!res.ok) {
    let detail = `Status ${res.status}`;
    const body = await readCloudJson<{ error?: string }>(res);
    if (body?.error) detail = body.error;
    throw new Error(detail);
  }

  const body = await readCloudJson<{ page: { slug: string; url?: string | null } }>(res);
  if (!body) {
    throw new Error("Cloud returned a non-JSON response when creating the page.");
  }
  return body;
}

// ─── GitHub App proxy (cloud holds the App private key) ─────────────────────
//
// Self-hosted instances never hold GITHUB_APP_ID / GITHUB_PRIVATE_KEY.
// All App-scoped operations (install URL, list installations, mint install
// tokens, OAuth identity) are proxied through api.openship.io which is the
// sole holder of the App credentials. The local instance authenticates with
// its cloud_session_token (same as every other cloud-proxied feature).
//
// What stays local on self-hosted:
//   - per-project / per-user clone tokens (PATs) — full escape hatch
//   - gh CLI fallback for offline / CI installs
//   - the resolved access tokens minted by cloud (cached briefly in memory)
//
// What lives in the cloud:
//   - the GitHub App identity, private key, webhook secret
//   - the OAuth client_id/secret + user identity (login, avatar)
//   - the canonical list of installations per cloud user
//   - the JWT signer + access_token mint endpoint

export interface CloudGithubInstallation {
  id: number;
  login: string;
  avatarUrl: string;
  type: "User" | "Organization";
}

export interface CloudGithubInstallationToken {
  token: string;
  /** ISO 8601 timestamp - GitHub install tokens expire in 60min. */
  expiresAt: string;
}

export interface CloudGithubUserStatus {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  id?: number;
}

/**
 * Returns a single-use GitHub OAuth start URL on the SaaS for this user.
 * The local instance opens this URL in a popup; the SaaS handles the
 * entire OAuth round-trip (popup → SaaS oauth-bridge → GitHub OAuth →
 * SaaS Better Auth callback → SaaS oauth-success page). After this
 * completes the SaaS has a `account` row with providerId='github' for
 * the user, and subsequent /user-status and /installations calls work.
 *
 * Returns null when the user isn't connected to Openship Cloud.
 */
export async function cloudGithubOauthHandoff(
  userId: string,
): Promise<{ url: string } | null> {
  const res = await cloudFetch(userId, "/api/cloud/github/oauth-handoff", {
    method: "POST",
  });
  if (!res || !res.ok) return null;
  const json = await readCloudJson<{ data: { url: string } }>(res);
  return json?.data ?? null;
}

/** Returns the GitHub App install URL for the org owner, with a one-time
 *  `state` the cloud will verify on the callback. The local instance opens
 *  this URL in a popup and the cloud attributes the resulting installation
 *  to the org owner so every team member shares access to it. */
export async function cloudGithubInstallUrl(
  organizationId: string,
): Promise<{ url: string; state: string } | null> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/github/install-url", {
    method: "POST",
  });
  if (!res || !res.ok) return null;
  const json = await readCloudJson<{ data: { url: string; state: string } }>(res);
  return json?.data ?? null;
}

/** List the org's GitHub App installations (the org owner's account on
 *  the SaaS owns them). One SaaS round-trip regardless of org size. */
export async function cloudGithubInstallations(
  organizationId: string,
): Promise<CloudGithubInstallation[] | null> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/github/installations", {
    method: "GET",
  });
  if (!res || !res.ok) return null;
  const json = await readCloudJson<{ data: CloudGithubInstallation[] }>(res);
  return json?.data ?? null;
}

/** Mint a short-lived installation access token for cloning the given
 *  owner. Resolves through the org owner so any team member can deploy
 *  using the team's installation. */
export async function cloudGithubInstallationToken(
  organizationId: string,
  input: { installationId?: number; owner: string; repos?: string[] },
): Promise<CloudGithubInstallationToken | null> {
  const res = await cloudFetchAsOrgOwner(organizationId, "/api/cloud/github/installation-token", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res || !res.ok) return null;
  const json = await readCloudJson<{ data: CloudGithubInstallationToken }>(res);
  return json?.data ?? null;
}

/** Cloud-issued OAuth identity for this user (login + avatar). Used by the
 *  dashboard to render "@user" badges on the GitHub settings panel. */
export async function cloudGithubUserStatus(
  userId: string,
): Promise<CloudGithubUserStatus | null> {
  const res = await cloudFetch(userId, "/api/cloud/github/user-status", {
    method: "GET",
  });
  if (!res || !res.ok) return null;
  const json = await readCloudJson<{ data: CloudGithubUserStatus }>(res);
  return json?.data ?? null;
}

// ─── Billing ─────────────────────────────────────────────────────────────────

/**
 * Proxy a billing request to the SaaS API.
 *
 * Used by local/desktop instances so cloud-connected users can manage
 * their subscription, payment methods, and invoices through the SaaS.
 *
 * Returns the raw Response so the caller can forward status + body.
 * Returns null if the user isn't connected to Openship Cloud.
 */
export async function cloudBillingFetch(
  userId: string,
  path: string,
  init?: { method?: string; body?: string },
): Promise<Response | null> {
  return cloudFetch(userId, `/api/billing${path}`, {
    method: init?.method ?? "GET",
    body: init?.body,
  });
}
