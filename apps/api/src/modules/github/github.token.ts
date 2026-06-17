/**
 * @module github.token
 *
 * THE single source of truth for "what GitHub token do I use for this
 * action?". Every place in the codebase that needs a token reaches into
 * `tokenFor(userId, purpose, ctx)` and that's the whole answer.
 *
 * Two purposes. That's it.
 *
 * ─── purpose: "local" ───────────────────────────────────────────────
 *
 *   The token stays on THIS machine. Used for:
 *     - Repo + org listing
 *     - Reading file contents / branches
 *     - Local-build clones (clone runs on this API host)
 *     - Generic GitHub API calls
 *
 *   Self-hosted priority:
 *     1. Project clone token (per-project override — user explicitly set)
 *     2. User-global clone token (when marked as default)
 *     3. gh CLI                ← source of truth per the user's rule
 *     4. Openship App installation (if owner has one)
 *     5. User OAuth (Better-Auth)
 *     6. null
 *
 *   SaaS priority:
 *     1. Project clone token
 *     2. User-global clone token
 *     3. Openship App installation
 *     4. User OAuth
 *     5. null
 *
 * ─── purpose: "remote" ──────────────────────────────────────────────
 *
 *   The token RIDES OFF this machine to a remote build worker / cloud
 *   workspace. Used for:
 *     - Remote-build clones (cloud workspace clones the repo)
 *
 *   Safest tokens only. **gh CLI is REFUSED** — it's a long-lived,
 *   broad-scope user PAT; shipping it off the host is a real security
 *   hole. Same priority on SaaS + self-hosted:
 *
 *     1. Project clone token
 *     2. User-global clone token
 *     3. Openship App installation (short-lived, repo-scoped)
 *     4. null  ← caller throws "install App or set per-project token"
 *
 * The dispatcher returns `{ token, source }` so callers (logging,
 * audit, metrics) know exactly which step in the chain matched. The
 * full priority chain lives here and ONLY here.
 */

import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { env } from "../../config/env";
import { decrypt } from "../../lib/encryption";
import {
  getInstallationId,
  getInstallationIdByOrg,
  getInstallationToken,
  getUserToken,
} from "./github.auth";
import { getLocalGhToken } from "./github.local-auth";

// ─── Public types ───────────────────────────────────────────────────────────

export type GitHubPurpose = "local" | "remote";

export type GitHubTokenSource =
  | "project"          // per-project clone_token_encrypted
  | "user-pat"         // user_settings clone_token_encrypted (cloneTokenAsDefault=true)
  | "gh-cli"           // local gh CLI token
  | "app-installation" // Openship App installation token (short-lived, scoped)
  | "user-oauth";      // Better-Auth GitHub OAuth (rare fallback)

export interface TokenResult {
  token: string;
  source: GitHubTokenSource;
}

export interface TokenContext {
  /** Repo owner — required for App installation token resolution. */
  owner?: string;
  /** Override the installation id (rare; usually inferred from owner). */
  installationId?: number;
  /** Project id — for per-project clone token lookup. */
  projectId?: string;
  /**
   * Active organization id — when set, App installation resolution prefers
   * `(organizationId, owner)` over the `(userId, owner)` lookup.
   *
   * Multi-user safety: a teammate's clone shouldn't depend on whichever
   * org member happened to install the App. Pass this whenever a request
   * has an active organization in context (every authed dashboard call,
   * every build kicked off by a project owned by an org).
   */
  organizationId?: string;
}

// ─── The dispatcher ─────────────────────────────────────────────────────────

/**
 * Resolve a GitHub token for the given purpose. Side-effect free —
 * only DB reads + decrypt + (optionally) an installation token mint.
 * Returns null when every chain step came up empty; callers decide
 * whether to throw or proceed (use `requireTokenFor` for the throw).
 */
export async function tokenFor(
  userId: string,
  purpose: GitHubPurpose,
  ctx: TokenContext = {},
): Promise<TokenResult | null> {
  // ── User overrides — same priority in every mode/purpose ──────────
  // These are CLI tokens the user explicitly provisioned. Safe for any
  // purpose (the user accepted the scope policy when they pasted them).
  if (ctx.projectId) {
    const t = await readProjectToken(ctx.projectId);
    if (t) return { token: t, source: "project" };
  }
  const userPat = await readUserGlobalToken(userId);
  if (userPat) return { token: userPat, source: "user-pat" };

  // ── Permission gate: restricted members can't transitively use the
  //    org's GitHub App installation unless they hold an explicit
  //    `github` resource grant. Without it, deploy/build flows fall
  //    through to the calling user's OWN OAuth token — they must
  //    connect their GitHub before they can do anything that needs it.
  //    Members/Admins/Owners always pass through.
  const installationAllowed = await canUseOrgInstallation(userId, ctx.organizationId);

  // ── Backend-resolved priority ─────────────────────────────────────
  // CLOUD_MODE = SaaS = no gh CLI on this machine ever; the App is
  // the only auto-resolved source.
  if (env.CLOUD_MODE) {
    if (ctx.owner && installationAllowed) {
      const t = await getInstallationToken(
        userId,
        ctx.owner,
        ctx.installationId,
        ctx.organizationId,
      ).catch(() => null);
      if (t) return { token: t, source: "app-installation" };
    }
    // For non-owner-scoped calls (e.g. /user/repos in OAuth fallback)
    const oauth = await getUserToken(userId);
    if (oauth) return { token: oauth, source: "user-oauth" };
    return null;
  }

  // SELF-HOSTED — purpose actually matters here.
  if (purpose === "local") {
    // Per user's rule: gh CLI is the source of truth in self-hosted.
    // If logged in, it wins over App. App + OAuth are fallbacks.
    //
    // BUT: gh CLI is the OPERATOR's credential (a long-lived, broad-scope
    // PAT bound to whoever ran `gh auth login` on this host). Handing it
    // to every authed user is a privilege escalation — a member/admin/
    // restricted user could use it to act against any repo the operator's
    // GitHub account can reach, well outside this org.
    //
    // Only return it when the caller is the operator: in zero-auth desktop
    // (no organizationId in context) the auto-provisioned local user IS
    // the operator. On a multi-user self-hosted install, restrict to
    // `owner` role in the active org.
    if (ctx.organizationId) {
      const m = await repos.member
        .find(ctx.organizationId, userId)
        .catch(() => null);
      if (m?.role === "owner") {
        const cli = await getLocalGhToken();
        if (cli) return { token: cli, source: "gh-cli" };
      }
      // Non-owners fall through to App / OAuth.
    } else {
      // No org context (desktop zero-auth, internal job) — the caller is
      // the operator, so gh CLI is safe to use.
      const cli = await getLocalGhToken();
      if (cli) return { token: cli, source: "gh-cli" };
    }
    if (ctx.owner && installationAllowed) {
      const t = await getInstallationToken(
        userId,
        ctx.owner,
        ctx.installationId,
        ctx.organizationId,
      ).catch(() => null);
      if (t) return { token: t, source: "app-installation" };
    }
    const oauth = await getUserToken(userId);
    if (oauth) return { token: oauth, source: "user-oauth" };
    return null;
  }

  // purpose === "remote" in self-hosted
  // gh CLI is REFUSED. App installation is the only auto-resolved token
  // that's safe to ship to a remote worker (short-lived, repo-scoped).
  if (ctx.owner && installationAllowed) {
    const t = await getInstallationToken(
      userId,
      ctx.owner,
      ctx.installationId,
      ctx.organizationId,
    ).catch(() => null);
    if (t) return { token: t, source: "app-installation" };
  }
  return null;
}

/**
 * Fast existence check — "could `tokenFor` resolve a token if we asked
 * it to?". Skips the actual installation-token mint (JWT + GitHub API
 * exchange, ~200–500ms) which `tokenFor` does for the App branch; this
 * version only confirms the installation ROW exists in our DB.
 *
 * Use this in preflight where minting is wasteful — the real mint
 * happens later in the build pipeline when we actually need the token.
 *
 * Returns the source that WOULD be matched, or null if none would.
 * The returned source is enough for callers that want to log which
 * credential type was used; an actual token value is NOT exposed.
 */
export async function canResolveTokenFor(
  userId: string,
  purpose: GitHubPurpose,
  ctx: TokenContext = {},
): Promise<GitHubTokenSource | null> {
  // 1. Per-project clone token — DB read only, no mint.
  if (ctx.projectId) {
    const project = await repos.project.findById(ctx.projectId).catch(() => null);
    if (project?.cloneTokenEncrypted) return "project";
  }

  // 2. User-global clone token (DB read only).
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  if (settings?.cloneTokenEncrypted && settings.cloneTokenAsDefault) return "user-pat";

  // 3. Self-hosted "local" purpose — gh CLI wins over App when present.
  //    getLocalGhToken does shell out (~50–150ms) but no GitHub API.
  //
  //    Same operator-only guard as `tokenFor`: only surface gh-cli
  //    existence when the caller is the org owner, or when there's no
  //    org context (desktop zero-auth / internal job). Without this, a
  //    member would see gh-cli as "available" and the dashboard would
  //    offer flows that ultimately fail or, worse, succeed via another
  //    credential while logging gh-cli as the resolved source.
  if (!env.CLOUD_MODE && purpose === "local") {
    let canUseCli = false;
    if (ctx.organizationId) {
      const m = await repos.member
        .find(ctx.organizationId, userId)
        .catch(() => null);
      canUseCli = m?.role === "owner";
    } else {
      canUseCli = true;
    }
    if (canUseCli) {
      const cli = await getLocalGhToken();
      if (cli) return "gh-cli";
    }
  }

  // 4. App installation — existence check only (DB row + small cache).
  //    Both SaaS and self-hosted, both purposes. Mirrors the resolution
  //    order in `tokenFor`: org-scoped row first, then user-scoped.
  if (ctx.owner) {
    let installId: number | null = null;
    if (ctx.organizationId) {
      installId = await getInstallationIdByOrg(ctx.organizationId, ctx.owner).catch(
        () => null,
      );
    }
    if (!installId) {
      installId = await getInstallationId(userId, ctx.owner).catch(() => null);
    }
    if (installId) return "app-installation";
  }

  // 5. OAuth fallback — only on the paths where tokenFor uses it.
  //    SaaS: both purposes. Self-hosted: purpose=local only.
  //    Note: purpose=remote in self-hosted does NOT fall through to OAuth.
  if (env.CLOUD_MODE || purpose === "local") {
    const oauth = await getUserToken(userId).catch(() => null);
    if (oauth) return "user-oauth";
  }

  return null;
}

/**
 * Same as `tokenFor`, but throws an actionable AppError when nothing
 * can be resolved. Use this at deploy/clone entry points where missing
 * credentials are a real "do something" condition.
 */
export async function requireTokenFor(
  userId: string,
  purpose: GitHubPurpose,
  ctx: TokenContext = {},
): Promise<TokenResult> {
  const r = await tokenFor(userId, purpose, ctx);
  if (r) return r;

  const hint =
    purpose === "remote"
      ? "Install the Openship GitHub App on this owner, or set a per-project clone token in Settings."
      : "Run `gh auth login`, connect Openship Cloud, or set a per-project clone token in Settings.";

  throw new AppError(
    `No GitHub token available for ${ctx.owner ?? "this request"} (purpose: ${purpose}). ${hint}`,
    403,
    purpose === "remote" ? "GITHUB_REMOTE_TOKEN_REQUIRED" : "GITHUB_TOKEN_REQUIRED",
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Permission gate: should `userId` be allowed to mint tokens via the
 * org's GitHub App installation?
 *
 * Rules:
 *   - No org context (background jobs, zero-auth desktop) → allow.
 *     The caller is either the operator or a system path.
 *   - Owner / admin / member → allow. The installation is part of the
 *     org's normal toolset and these roles get unrestricted org-resource
 *     access by design.
 *   - Restricted → allow ONLY if they hold a `github` resource_grant
 *     (specific resourceId="*" or any non-empty grant on resourceType
 *     "github"). Without it, deploy/build flows transparently fall
 *     through to the calling user's OWN OAuth — they must connect
 *     their GitHub before they can use anything that needs an
 *     installation token.
 *
 * Returns false on lookup failure (fail closed).
 */
async function canUseOrgInstallation(
  userId: string,
  organizationId: string | undefined,
): Promise<boolean> {
  if (!organizationId) return true;
  try {
    const m = await repos.member.find(organizationId, userId);
    if (!m) return false;
    if (m.role !== "restricted") return true;
    const grant = await repos.resourceGrant.findForResource(
      organizationId,
      userId,
      "github",
      "*",
    );
    if (!grant) return false;
    return grant.permissions.some(
      (p) => p === "read" || p === "write" || p === "admin",
    );
  } catch {
    return false;
  }
}

async function readProjectToken(projectId: string): Promise<string | null> {
  const project = await repos.project.findById(projectId).catch(() => null);
  if (!project?.cloneTokenEncrypted) return null;
  try {
    return decrypt(project.cloneTokenEncrypted);
  } catch {
    return null;
  }
}

async function readUserGlobalToken(userId: string): Promise<string | null> {
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  if (!settings?.cloneTokenEncrypted) return null;
  if (!settings.cloneTokenAsDefault) return null;
  try {
    return decrypt(settings.cloneTokenEncrypted);
  } catch {
    return null;
  }
}
