/**
 * @module github.token
 *
 * THE single source of truth for "what GitHub token do I use for this
 * action?". Every place in the codebase that needs a token reaches into
 * `tokenFor(ctx, purpose, tokenCtx)` and that's the whole answer.
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
 *   Self-hosted priority (for purpose="local" — see ordering rationale
 *   block at the dispatcher):
 *     1. gh CLI                ← least config: just needs the operator's
 *                                 CLI present; opt-in gated for multi-user
 *     2. Openship App installation (org-scoped, short-lived, repo-scoped)
 *     3. Project clone token   (per-project user PAT override)
 *     4. User-global clone token (user PAT, when marked as default)
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
// gh-CLI (github.local-auth) is imported DYNAMICALLY at its two self-hosted
// "local"-purpose call sites below, so the gh module never loads in CLOUD_MODE.
import { canUseGitHubRepo } from "./github-access";
import type { RequestContext } from "../../lib/request-context";

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

/**
 * Per-token-call data — owner, installation id, project id. Identity
 * (userId, organizationId) lives in the RequestContext passed alongside,
 * NOT in this interface.
 */
export interface TokenContext {
  /** Repo owner — required for App installation token resolution. */
  owner?: string;
  /** Repo name — enables PER-REPO authorization in the github-access
   *  gate. When set, the gate authorizes this exact repo; when absent it
   *  falls back to owner-level authorization (any grant under the owner). */
  repo?: string;
  /** Override the installation id (rare; usually inferred from owner). */
  installationId?: number;
  /** Project id — for per-project clone token lookup. */
  projectId?: string;
  /** Target server id — threaded so `canResolveTokenFor` (preflight) can stay
   *  in lockstep with a per-server credential consulted upstream in
   *  clone-auth.ts. `tokenFor` itself has no per-server branch (SSH can't be a
   *  TokenResult); this is plumbing for parity, not resolution. */
  serverId?: string;
}

// ─── The dispatcher ─────────────────────────────────────────────────────────

/**
 * Resolve a GitHub token for the given purpose. Side-effect free —
 * only DB reads + decrypt + (optionally) an installation token mint.
 * Returns null when every chain step came up empty; callers decide
 * whether to throw or proceed (use `requireTokenFor` for the throw).
 */
export async function tokenFor(
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext = {},
): Promise<TokenResult | null> {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId || undefined;
  // ── 0-bypass permission gate: GitHub access is default-DENY for
  //    everyone but the org OWNER. Admins/members/restricted can use the
  //    org's App installation only when the owner granted them this repo
  //    (or its installation, or all-GitHub). Denied → the App branch is
  //    skipped; the flow falls through to the caller's OWN PAT/OAuth (or
  //    null → "connect your GitHub"). This is THE funnel: every token
  //    mint passes here, so there is no door around it.
  const installationAllowed = tokenCtx.owner
    ? await canUseGitHubRepo(
        ctx,
        {
          owner: tokenCtx.owner,
          repo: tokenCtx.repo,
          installationId: tokenCtx.installationId,
        },
        "read",
      )
    : false;

  // ── SaaS: no gh CLI on this machine ever; the App is the only
  //    auto-resolved source. PATs (project / user) still win at the
  //    top — they're explicit user provisioning and the SaaS host has
  //    no other way to access a repo the App isn't installed on.
  if (env.CLOUD_MODE) {
    if (tokenCtx.projectId) {
      const t = await readProjectToken(tokenCtx.projectId);
      if (t) return { token: t, source: "project" };
    }
    const userPat = await readUserGlobalToken(userId);
    if (userPat) return { token: userPat, source: "user-pat" };

    if (tokenCtx.owner && installationAllowed) {
      const t = await tryInstallationToken(ctx, tokenCtx.owner, tokenCtx.installationId);
      if (t) return { token: t, source: "app-installation" };
    }
    // For non-owner-scoped calls (e.g. /user/repos in OAuth fallback)
    const oauth = await getUserToken(userId);
    if (oauth) return { token: oauth, source: "user-oauth" };
    return null;
  }

  // ── SELF-HOSTED — purpose actually matters here ───────────────────
  if (purpose === "local") {
    // ─── Ordering rationale (deliberate) ────────────────────────────
    // For local-build clones, prefer auto-resolved credentials over
    // explicit user-provisioned PATs because they're scoped tighter
    // and require less ongoing maintenance:
    //
    //   1. gh-cli           — least configuration: just the operator's
    //                         CLI present (opt-in gated for multi-user
    //                         to prevent privilege escalation, HIGH #7).
    //   2. app-installation — short-lived, repo-scoped, org-bound.
    //   3. project PAT      — explicit per-project user override.
    //   4. user-pat         — explicit user-global PAT.
    //   5. user-oauth       — last-resort fallback.
    //
    // gh-cli is preferred over the App because the App requires the
    // owner to have installed it on the repo; gh-cli works against any
    // repo the operator's GitHub account can see, which is exactly
    // what we want for a local-build clone on this host. For REMOTE
    // builds, gh-cli is refused entirely — see the remote branch below.
    //
    // HIGH #7: gh CLI is the OPERATOR's long-lived broad-scope PAT. The
    // whole "may this caller use it here" policy (remote → never, no-org →
    // yes, org → opt-in) is centralized in mayUseOperatorCliToken so this
    // resolution step is just "pick the token if authorized".
    if (await mayUseOperatorCliToken(userId, organizationId, purpose)) {
      // Dynamic import: reached only on the self-hosted "local" purpose
      // (the CLOUD_MODE branch returned above), so gh never loads on the SaaS.
      const { getLocalGhToken } = await import("./github.local-auth");
      const cli = await getLocalGhToken();
      if (cli) return { token: cli, source: "gh-cli" };
    }
    // Non-operators (multi-user org, not opted in) fall through to App / PAT / OAuth.

    if (tokenCtx.owner && installationAllowed) {
      const t = await tryInstallationToken(ctx, tokenCtx.owner, tokenCtx.installationId);
      if (t) return { token: t, source: "app-installation" };
    }

    // User-provisioned PATs come after auto-resolved sources for local.
    if (tokenCtx.projectId) {
      const t = await readProjectToken(tokenCtx.projectId);
      if (t) return { token: t, source: "project" };
    }
    const userPat = await readUserGlobalToken(userId);
    if (userPat) return { token: userPat, source: "user-pat" };

    const oauth = await getUserToken(userId);
    if (oauth) return { token: oauth, source: "user-oauth" };
    return null;
  }

  // ── purpose === "remote" in self-hosted ───────────────────────────
  // gh CLI is REFUSED — it's a long-lived broad-scope user PAT and the
  // cloud workspace doesn't have gh-cli installed anyway. App
  // installation is the only auto-resolved token safe to ship off-host
  // (short-lived, repo-scoped); explicit user PATs are also safe
  // because the user opted in by pasting them.
  if (tokenCtx.projectId) {
    const t = await readProjectToken(tokenCtx.projectId);
    if (t) return { token: t, source: "project" };
  }
  const userPat = await readUserGlobalToken(userId);
  if (userPat) return { token: userPat, source: "user-pat" };

  if (tokenCtx.owner && installationAllowed) {
    const t = await tryInstallationToken(ctx, tokenCtx.owner, tokenCtx.installationId);
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
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext = {},
): Promise<GitHubTokenSource | null> {
  const userId = ctx.userId;
  const organizationId = ctx.organizationId || undefined;
  // Mirror the dispatch order in `tokenFor` so preflight reports the
  // SAME source that the real resolution will mint later.
  // Self-hosted local: cli → app → project PAT → user PAT → oauth
  // SaaS / self-hosted remote: project PAT → user PAT → app → (oauth in SaaS)

  const isSelfHostedLocal = !env.CLOUD_MODE && purpose === "local";

  // Helper closures — keep the read order auditable.
  const checkProjectPat = async (): Promise<GitHubTokenSource | null> => {
    if (!tokenCtx.projectId) return null;
    const project = await repos.project.findById(tokenCtx.projectId).catch(() => null);
    return project?.cloneTokenEncrypted ? "project" : null;
  };
  const checkUserPat = async (): Promise<GitHubTokenSource | null> => {
    const settings = await repos.settings.findByUser(userId).catch(() => null);
    return settings?.cloneTokenEncrypted && settings.cloneTokenAsDefault ? "user-pat" : null;
  };
  const checkAppInstallation = async (): Promise<GitHubTokenSource | null> => {
    if (!tokenCtx.owner) return null;
    // Same 0-bypass gate as tokenFor — so preflight reports the SAME
    // verdict the real mint will reach (a member without a grant for this
    // repo doesn't get told "app available" then blocked at build time).
    const allowed = await canUseGitHubRepo(
      ctx,
      {
        owner: tokenCtx.owner,
        repo: tokenCtx.repo,
        installationId: tokenCtx.installationId,
      },
      "read",
    );
    if (!allowed) return null;
    let installId: number | null = null;
    if (organizationId) {
      installId = await getInstallationIdByOrg(organizationId, tokenCtx.owner).catch(
        () => null,
      );
    }
    if (!installId) {
      installId = await getInstallationId(ctx, tokenCtx.owner).catch(() => null);
    }
    return installId ? "app-installation" : null;
  };
  const checkOauth = async (): Promise<GitHubTokenSource | null> => {
    const oauth = await getUserToken(userId).catch(() => null);
    return oauth ? "user-oauth" : null;
  };

  if (isSelfHostedLocal) {
    // HIGH #7 — same gh-cli gate as `tokenFor` (isSelfHostedLocal implies
    // purpose "local"), so the existence check can't drift from the real
    // resolution policy.
    if (await mayUseOperatorCliToken(userId, organizationId, "local")) {
      // Dynamic import (self-hosted local only) — gh never loads on the SaaS.
      const { getLocalGhToken } = await import("./github.local-auth");
      const cli = await getLocalGhToken();
      if (cli) return "gh-cli";
    }
    const app = await checkAppInstallation();
    if (app) return app;
    const proj = await checkProjectPat();
    if (proj) return proj;
    const usr = await checkUserPat();
    if (usr) return usr;
    return await checkOauth();
  }

  // SaaS (both purposes) and self-hosted "remote": PATs first, then App.
  const proj = await checkProjectPat();
  if (proj) return proj;
  const usr = await checkUserPat();
  if (usr) return usr;
  const app = await checkAppInstallation();
  if (app) return app;
  // OAuth fallback: SaaS only. Self-hosted remote does NOT fall through.
  if (env.CLOUD_MODE) return await checkOauth();
  return null;
}

/**
 * Same as `tokenFor`, but throws an actionable AppError when nothing
 * can be resolved. Use this at deploy/clone entry points where missing
 * credentials are a real "do something" condition.
 */
export async function requireTokenFor(
  ctx: RequestContext,
  purpose: GitHubPurpose,
  tokenCtx: TokenContext = {},
): Promise<TokenResult> {
  const r = await tokenFor(ctx, purpose, tokenCtx);
  if (r) return r;

  const hint =
    purpose === "remote"
      ? "Install the Openship GitHub App on this owner, or set a per-project clone token in Settings."
      : "Run `gh auth login`, connect Openship Cloud, or set a per-project clone token in Settings.";

  throw new AppError(
    `No GitHub token available for ${tokenCtx.owner ?? "this request"} (purpose: ${purpose}). ${hint}`,
    403,
    purpose === "remote" ? "GITHUB_REMOTE_TOKEN_REQUIRED" : "GITHUB_TOKEN_REQUIRED",
  );
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * HIGH #7 — single source of truth for "can this caller use the gh CLI
 * operator token?". Two ways in:
 *
 *   1. `env.GITHUB_AUTH_MODE === "cli"` — operator explicitly chose CLI
 *      mode for this whole instance. No further gating needed.
 *   2. `user_settings.ghCliOperatorOptedIn === true` — the user is the
 *      single-user instance operator and has flipped the opt-in. Any
 *      other caller (member, admin, owner-of-other-org) is refused.
 *
 * Returns false on lookup failure (fail closed).
 */
async function isCliOperatorAllowed(userId: string): Promise<boolean> {
  if (env.GITHUB_AUTH_MODE === "cli") return true;
  const settings = await repos.settings.findByUser(userId).catch(() => null);
  return settings?.ghCliOperatorOptedIn === true;
}

/**
 * The gh-CLI authorization GATE, split out of token resolution so "which
 * token do I pick" (the priority chains above) and "is this caller allowed
 * to use the operator's broad CLI token here" are separate concerns.
 *
 *   - purpose "remote" → NEVER. The gh CLI token is a long-lived,
 *     broad-scope user PAT; shipping it off this host to a remote build
 *     worker is a real security hole (HIGH #7).
 *   - no org context (zero-auth desktop / internal jobs) → YES. The
 *     auto-provisioned local user IS the operator.
 *   - org context → only if the operator opted in (`isCliOperatorAllowed`),
 *     so a non-operator member can't borrow the operator's token.
 *
 * NOTE: this gate is for CLONE/BUILD token resolution only. Plain repo/org
 * LISTING is a local read and uses the gh token DIRECTLY via the
 * github.local-auth helpers (`listLocalGhRepos`/`listLocalGhOrgs`) — it
 * deliberately never passes through here.
 */
async function mayUseOperatorCliToken(
  userId: string,
  organizationId: string | undefined,
  purpose: GitHubPurpose,
): Promise<boolean> {
  if (purpose === "remote") return false;
  if (!organizationId) return true;
  return isCliOperatorAllowed(userId);
}

/**
 * Mint a GitHub App installation token, but LOG (without the token) when
 * the mint fails before falling through to the next credential. A 403
 * (install suspended / permissions revoked / repo no longer covered) would
 * otherwise be silently downgraded to a broader user PAT / OAuth token with
 * no trace — masking a security-relevant signal. Returns null on failure so
 * the priority chain continues unchanged.
 */
async function tryInstallationToken(
  ctx: RequestContext,
  owner: string,
  installationId?: number,
): Promise<string | null> {
  try {
    return await getInstallationToken(ctx, owner, installationId);
  } catch (err) {
    console.warn(
      `[github.token] App installation token mint failed for owner=${owner}` +
        `${installationId ? ` install=${installationId}` : ""}: ` +
        `${(err as Error).message} — falling through to the next credential`,
    );
    return null;
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
