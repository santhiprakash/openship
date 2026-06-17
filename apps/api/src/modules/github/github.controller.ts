/**
 * GitHub controller - Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Validates params/query/body via TypeBox schemas (at the route level)
 *   3. Delegates to service/auth functions
 *   4. Returns a consistent JSON response
 *
 * No direct GitHub API calls here - that's the service's job.
 */

import type { Context } from "hono";
import { env } from "../../config/env";
import { auth } from "../../lib/auth";
import { audit, auditContextFrom } from "../../lib/audit";
import * as githubAuth from "./github.auth";
import * as localAuth from "./github.local-auth";
import * as githubService from "./github.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract authenticated user ID from Hono context (set by authMiddleware). */
function getUserId(c: Context): string {
  const user = c.get("user");
  return user?.id;
}

/**
 * Extract the active organization id from context (set by
 * activeOrganizationMiddleware mounted in github.routes.ts).
 *
 * Threaded into every `githubService.*` call so the operator-only
 * gh-cli gate in `tokenFor` knows whether the caller has `owner` role.
 * Returns undefined defensively — middleware should always have set it,
 * but unsetting it falls back rather than 500-ing on a misconfigured route.
 */
function orgId(c: Context): string | undefined {
  const v = c.get("activeOrganizationId");
  return typeof v === "string" ? v : undefined;
}

/** Safely extract a required route param. */
function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const responseHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof responseHeaders.getSetCookie === "function") {
    const cookies = responseHeaders.getSetCookie();
    if (cookies.length > 0) {
      return cookies;
    }
  }

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

// ─── Status / Connection ─────────────────────────────────────────────────────

/**
 * GET /github/status — canonical connection state for the current user.
 * The wire shape is `{ state: GitHubConnectionState }` — see github.types.ts.
 * No `mode` field: the global platform mode is `env.CLOUD_MODE` (backend) /
 * `selfHosted` (frontend's PlatformContext). This endpoint only carries
 * GitHub-specific state.
 */
export async function getStatus(c: Context) {
  const userId = getUserId(c);
  const state = await githubAuth.getGitHubConnectionState(userId);
  return c.json({ state });
}

/**
 * GET /github/home — canonical state plus accounts and repos visible from
 * the active source(s). The install URL is offered whenever the App is
 * an option for this user (any non-CLOUD_MODE-only install ships the App
 * install URL so the dashboard can prompt "install on this org").
 */
export async function getHome(c: Context) {
  const userId = getUserId(c);
  const data = await githubService.getUserHome(userId);
  return c.json({
    ...data,
    installUrl: githubAuth.getInstallUrl(),
  });
}

/** POST /github/connect - Normalized connection flow.
 *
 *  Returns a consistent shape regardless of auth mode:
 *
 *  Already connected:
 *    { connected: true }
 *
 *  Needs redirect (OAuth or App install):
 *    { connected: false, flow: "redirect", url: "https://..." }
 *
 *  Device flow (desktop with CLIENT_ID):
 *    { connected: false, flow: "device_code", userCode, verificationUri, ... }
 *
 *  Terminal instruction (desktop without CLIENT_ID):
 *    { connected: false, flow: "terminal", command, message }
 *
 *  The frontend is mode-agnostic - it just reacts to `flow`.
 */
export async function connect(c: Context) {
  const userId = getUserId(c);
  // Per-user resolution — picks "cloud-app" when self-hosted + cloud-
  // connected, otherwise falls back to the static mode. Every branch
  // below sees the actual mode this user should use.
  const mode = await githubAuth.resolveGitHubAuthMode(userId);

  // Optional `source` discriminator from the dashboard's dual-source
  // (Openship App vs gh CLI) settings panel. When the user explicitly
  // clicks "Connect Openship App", source="oauth" forces the App
  // install flow regardless of whether gh CLI is already authenticated;
  // otherwise the two buttons would be indistinguishable to the server
  // and both would short-circuit on the cli token.
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const source = body && typeof body === "object" && "source" in body
    ? (body.source as "oauth" | "cli" | undefined)
    : undefined;

  // ── Explicit CLI un-suppress (applies in any mode) ───────────────
  // User clicked "Use gh CLI" — they want the prior Disconnect
  // suppression flag cleared so openship reads `gh auth token` again.
  // This MUST run before the mode-based branches below; otherwise in
  // cloud-app mode it would never fire (we'd return the App install
  // URL and the flag would stay set forever).
  //
  // In cloud-app mode there's no further connection step needed once
  // the flag is cleared — the next /github/home refresh sees the CLI
  // available and the dashboard CLI card flips from "Disabled" to
  // "Logged in as @user". Return `connected: true` so the frontend
  // doesn't try to open an auth window.
  //
  // In cli mode we still need to check status (gh might not actually
  // be authed), so we just clear the flag and fall through to the
  // existing cli-mode logic below.
  if (source === "cli") {
    const { setGithubCliDisabled } = await import("../settings/settings.service");
    await setGithubCliDisabled(userId, false);
    if (mode === "cloud-app") {
      return c.json({ connected: true });
    }
  }

  // ── Cloud-app (self-hosted + cloud-connected) ────────────────────
  // SaaS-only architecture: the local instance never holds GitHub OAuth
  // credentials and never runs the OAuth round-trip itself. All GitHub
  // auth flows through api.openship.io.
  //
  // Two-step flow:
  //   1. If the SaaS doesn't yet have a `account` row with
  //      providerId='github' for this user → return the SaaS OAuth
  //      handoff URL. Popup opens it; SaaS bridges to GitHub OAuth;
  //      Better Auth creates the account row on the SaaS DB.
  //   2. Once status.connected is true on SaaS → return the SaaS-bound
  //      install URL (also from cloud-client). User installs; webhook
  //      attributes correctly because the OAuth row now exists.
  //
  // The frontend keeps clicking Connect; the server's response (`step`)
  // tells it which UI to show ("connecting GitHub" vs "installing App").
  if (mode === "cloud-app") {
    const status = await githubAuth.getUserStatus(userId);

    // Step 1: GitHub OAuth via SaaS. The Connect button does this FIRST.
    // Returning the install URL before OAuth is broken — the webhook
    // can't attribute the install to a SaaS user without the account
    // row, and the install becomes orphaned on github.com.
    if (!status.connected) {
      const oauth = await githubAuth.resolveOauthHandoffUrl(userId);
      if (oauth) {
        return c.json({
          connected: false,
          flow: "redirect" as const,
          url: oauth.url,
          step: "oauth" as const,
        });
      }
      // Cloud unreachable — fall through to install URL as a degraded
      // path. The install will still drop on the webhook side but at
      // least the user sees github.com instead of a hard error.
    }

    // Step 2: OAuth done. Check if installations already exist.
    if (status.connected) {
      const installations = await githubAuth.getUserInstallations(userId, status);
      if (installations.length > 0 && source !== "oauth") {
        return c.json({ connected: true });
      }
    }

    // Step 2 continued: no installations yet → return install URL.
    const { url, state } = await githubAuth.resolveInstallUrl(userId);
    return c.json({
      connected: false,
      flow: "redirect" as const,
      url,
      state,
      step: "install" as const,
    });
  }

  // Clicking Connect always means "I want to be connected" - clear any
  // prior cli-suppression flag from a previous Disconnect so the status
  // check below can resolve via the gh CLI fallback if it's available.
  // Skip this when the user explicitly chose the App source — we don't
  // want to silently re-enable cli when they're trying to add the App.
  if (mode === "cli" && source !== "oauth") {
    const { setGithubCliDisabled } = await import("../settings/settings.service");
    await setGithubCliDisabled(userId, false);
  }
  const status = await githubAuth.getUserStatus(userId);

  // ── Explicit App-source request (overrides mode-based routing) ────
  // In cli mode the dashboard shows TWO connect buttons (App + CLI).
  // When the user clicked the App button, ALWAYS run the App install
  // flow — return the install URL (and, if OAuth is missing, kick the
  // OAuth-then-install dance via the redirect endpoint).
  if (source === "oauth") {
    if (!status.connected) {
      // OAuth not present yet — the redirect endpoint will do
      // linkSocialAccount then callbackURL=/auth/callback/install
      // which redirects to the App install URL.
      return c.json({
        connected: false,
        flow: "redirect" as const,
      });
    }
    const installations = await githubAuth.getUserInstallations(userId, status);
    if (installations.length > 0) {
      return c.json({ connected: true });
    }
    return c.json({
      connected: false,
      flow: "redirect" as const,
      url: githubAuth.getInstallUrl(),
    });
  }

  // ── Already connected? ─────────────────────────────────────
  if (mode === "token" && status.connected) {
    return c.json({ connected: true });
  }

  if (mode === "cli") {
    if (status.connected) {
      return c.json({ connected: true });
    }
  }

  if (mode === "oauth" && status.connected) {
    return c.json({ connected: true });
  }

  if (mode === "app" && status.connected) {
    const installations = await githubAuth.getUserInstallations(userId, status);
    if (installations.length > 0) {
      return c.json({ connected: true });
    }

    return c.json({
      connected: false,
      flow: "redirect" as const,
      url: githubAuth.getInstallUrl(),
    });
  }

  // ── CLI: no token yet ──────────────────────────────────────
  if (mode === "cli") {
    // No GITHUB_CLIENT_ID → run `gh auth login` in terminal
    if (!env.GITHUB_CLIENT_ID) {
      return c.json({
        connected: false,
        flow: "terminal" as const,
        command: "gh auth login",
        message: "Run this command in your terminal, then click refresh.",
      });
    }
    // Has CLIENT_ID → start device flow
    try {
      const verification = await localAuth.startDeviceFlow(userId);
      return c.json({
        connected: false,
        flow: "device_code" as const,
        userCode: verification.user_code,
        verificationUri: verification.verification_uri,
        expiresIn: verification.expires_in,
        interval: verification.interval,
      });
    } catch (err) {
      return c.json({ connected: false, error: (err as Error).message }, 500);
    }
  }

  // ── Token mode with no token ───────────────────────────────
  if (mode === "token") {
    return c.json({
      connected: false,
      flow: "terminal" as const,
      command: "GITHUB_TOKEN=ghp_... (set in environment)",
      message: "Set the GITHUB_TOKEN environment variable and restart the server.",
    });
  }

  // ── App / OAuth: need GitHub OAuth → tell frontend to open the redirect popup ──
  return c.json({ connected: false, flow: "redirect" as const });
}

/** GET /github/connect/redirect - Direct browser navigation endpoint.
 *
 *  Instead of returning JSON (which is a cross-origin fetch that can't
 *  persist cookies in the popup's browsing context), this endpoint is
 *  navigated to directly by the popup window. It calls better-auth's
 *  linkSocialAccount, copies the state cookie to the response, and does a
 *  302 redirect to GitHub. The cookie lives in the popup's context so
 *  it's available when GitHub redirects back to the callback URL.
 */
export async function connectRedirect(c: Context) {
  const mode = githubAuth.getGitHubAuthMode();

  const callbackURL = mode === "app" ? "/auth/callback/install" : "/auth/callback/close";

  try {
    // Use linkSocialAccount (not signInSocial) because the user is already
    // authenticated - we want to attach GitHub to their existing account.
    const result = await auth.api.linkSocialAccount({
      body: {
        provider: "github",
        callbackURL,
        disableRedirect: true,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (result instanceof Response) {
      const cookies = getSetCookieHeaders(result.headers);
      let redirectUrl: string | null = null;

      const locationHeader = result.headers.get("location");
      if (locationHeader) {
        redirectUrl = locationHeader;
      }

      try {
        const body = await result.json() as { url?: string };
        redirectUrl = redirectUrl ?? body?.url ?? null;
      } catch {
        // Ignore non-JSON bodies and fall back to headers-only handling.
      }

      if (redirectUrl) {
        const response = c.redirect(redirectUrl);
        for (const cookie of cookies) {
          response.headers.append("Set-Cookie", cookie);
        }
        return response;
      }
    }

    // Fallback: non-Response result with a URL
    if (result && typeof result === "object" && "url" in result) {
      return c.redirect((result as { url: string }).url);
    }
  } catch (err) {
    /* fall through */
  }

  return c.text("Unable to start GitHub authorization", 500);
}

/** GET /github/local-status - Check if the machine has `gh` CLI auth available.
 *  Gated by `localOnly` middleware - never reaches this handler in cloud modes.
 */
export async function getLocalStatus(c: Context) {
  const localStatus = await localAuth.getLocalGhStatus();
  return c.json({
    ...localStatus,
    activeMode: githubAuth.getGitHubAuthMode(),
  });
}

/** GET /github/connect/poll - Poll the device flow status.
 *  Gated by `localOnly` middleware.
 */
export async function pollConnect(c: Context) {
  const userId = getUserId(c);
  const status = localAuth.getDeviceFlowStatus(userId);
  if (!status) {
    return c.json({ status: "none" as const }, 404);
  }
  return c.json(status);
}

/**
 * POST /github/disconnect - Disconnect from one source (or both).
 *
 * Body / query: { source?: "oauth" | "cli" | "all" }   (default "all")
 *
 * Doesn't uninstall the GitHub App - that happens via webhook only.
 */
export async function disconnect(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const body = await c.req.json().catch(() => ({}));
  const queryParam = c.req.query("source");
  const rawSource = (body?.source ?? queryParam) as string | undefined;
  const source: "oauth" | "cli" | "all" =
    rawSource === "oauth" || rawSource === "cli" || rawSource === "all" ? rawSource : "all";
  await githubAuth.disconnectUser(userId, source);
  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "github.disconnect",
      resourceType: "github",
      resourceId: "*",
      after: { source },
    });
  }
  return c.json({ success: true, source });
}

// ─── Accounts / Organisations ────────────────────────────────────────────────
//
// `getHome` (GET /github/home → getUserHome service) is the SINGLE
// dashboard entry point — it returns { state, accounts, repos } in one
// round trip. The previous fan-out endpoints (/accounts, /orgs,
// /orgs/repos) duplicated the same `/user/orgs` fetch across three
// helpers (listUserAccounts, listUserOrgsViaApi, listUserOrgsWithReposViaApi)
// and were never called from the dashboard after the consolidation.
// All deleted. Anything that still needs the per-org breakdown can
// derive it from the unified home response.

// ─── Repositories ────────────────────────────────────────────────────────────

/** GET /github/repos - List repos (mode-aware) */
export async function listRepos(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = c.req.query("owner");
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    // If the owner matches the authenticated user, fetch their own repos
    // (not /orgs/{owner}/repos which would 404 for a user account)
    const status = await githubAuth.getUserStatus(userId);
    const isOwnAccount = owner && status.connected && owner === status.login;
    const repos = await githubService.listUserOwnedRepos(
      userId,
      isOwnAccount ? undefined : (owner || undefined),
      { organizationId },
    );
    return c.json({ data: repos });
  }

  // App mode: use GitHub App installation
  const status = await githubAuth.getUserStatus(userId);
  if (!status.connected) {
    return c.json({ error: "Not connected to GitHub" }, 400);
  }

  if (!owner) {
    const installations = await githubAuth.getUserInstallations(userId, status);
    if (installations.length === 0) {
      return c.json({ error: "Not connected to GitHub" }, 400);
    }
    const repos = await githubService.listInstallationRepos(
      userId,
      installations[0].account.login,
      installations[0].id,
      { organizationId },
    );
    return c.json({ data: repos });
  }

  const repos = await githubService.listInstallationRepos(userId, owner, undefined, {
    organizationId,
  });
  return c.json({ data: repos });
}

/** GET /github/orgs/:org/repos - List repos for an organisation */
export async function listOrgRepos(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const org = param(c, "org");
  const mode = githubAuth.getGitHubAuthMode();

  if (mode !== "app") {
    const repos = await githubService.listUserOwnedRepos(userId, org, { organizationId });
    return c.json({ data: repos });
  }

  const status = await githubAuth.getUserStatus(userId);
  if (!status.connected) {
    return c.json({ error: "Not connected to GitHub" }, 400);
  }

  const repos = await githubService.listInstallationRepos(userId, org, undefined, {
    organizationId,
  });
  return c.json({ data: repos });
}

/** GET /github/repos/:owner/:repo - Get a single repository */
export async function getRepo(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const withBranches = c.req.query("branches") === "true";

  const data = await githubService.getRepository(userId, owner, repo, {
    withBranches,
    organizationId,
  });
  return c.json({ data });
}

/** POST /github/repos - Create a new repository */
export async function createRepo(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const body = await c.req.json();

  const data = await githubService.createRepository(userId, body.name, {
    description: body.description,
    private: body.private,
    owner: body.owner,
    organizationId,
  });

  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "github.repo.create",
      resourceType: "github",
      resourceId: (data as { full_name?: string })?.full_name ?? body.name,
      after: { name: body.name, owner: body.owner, private: !!body.private },
    });
  }

  return c.json({ data }, 201);
}

/** DELETE /github/repos/:owner/:repo - Delete a repository */
export async function deleteRepo(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  await githubService.deleteRepository(userId, owner, repo, { organizationId });

  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "github.repo.delete",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      before: { owner, repo },
    });
  }

  return c.json({ success: true });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/branches - List branches */
export async function listBranches(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.listBranches(userId, owner, repo, { organizationId });
  return c.json({ data });
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/files - List files in a directory */
export async function listFiles(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch");
  const path = c.req.query("path");

  const data = await githubService.listFiles(userId, owner, repo, {
    branch: branch ?? undefined,
    path: path ?? undefined,
    organizationId,
  });
  return c.json({ data });
}

/** GET /github/repos/:owner/:repo/file - Get a single file's content */
export async function getFile(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const file = c.req.query("file") ?? "package.json";
  const branch = c.req.query("branch");

  const data = await githubService.getFileContent(userId, owner, repo, file, {
    branch: branch ?? undefined,
    json: file.endsWith(".json"),
    organizationId,
  });
  return c.json({ data });
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** GET /github/repos/:owner/:repo/webhooks - List repo webhooks */
export async function listWebhooks(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.listWebhooks(userId, owner, repo, { organizationId });
  return c.json({ data });
}

/** POST /github/repos/:owner/:repo/webhooks - Register a webhook (create or find existing) */
export async function registerWebhook(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const data = await githubService.registerWebhook(userId, owner, repo, undefined, {
    organizationId,
  });

  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "github.webhook.register",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      after: {
        owner,
        repo,
        hookId: (data as { id?: number | string })?.id ?? null,
      },
    });
  }

  return c.json({ data });
}

/** DELETE /github/repos/:owner/:repo/webhooks - Delete a webhook */
export async function deleteWebhook(c: Context) {
  const userId = getUserId(c);
  const organizationId = orgId(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const body = await c.req.json();

  if (!body.hookId) {
    return c.json({ error: "hookId is required" }, 400);
  }

  await githubService.deleteWebhook(userId, owner, repo, body.hookId, { organizationId });

  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: "github.webhook.delete",
      resourceType: "github",
      resourceId: `${owner}/${repo}`,
      before: { owner, repo, hookId: body.hookId },
    });
  }
  return c.json({ success: true });
}
