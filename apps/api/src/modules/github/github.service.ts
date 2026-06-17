/**
 * GitHub service - business logic for repositories, branches, files, and webhooks.
 *
 * All GitHub API interactions go through `githubFetch` from github.auth,
 * keeping this module focused on data transformation and business rules.
 */

import {
  githubFetch,
  getGitHubConnectionState,
  getUserStatus,
  getUserInstallations,
  mapAccounts,
  getGitHubAuthMode,
} from "./github.auth";
import { listLocalGhRepos } from "./github.local-auth";
import { isIgnoredRepoPath } from "../../lib/project-root-detector";
import { repos as dbRepos } from "@repo/db";
import type {
  GitHubRepository,
  GitHubBranch,
  GitHubFileContent,
  GitHubTreeResponse,
  GitHubWebhook,
  GitHubConnectionState,
  MappedRepository,
  MappedAccount,
  RepositoryDetail,
} from "./github.types";
import { env, runtimeTarget } from "../../config/env";

export const GITHUB_DEPLOY_WEBHOOK_EVENTS = ["push"] as const;
const MAX_FALLBACK_TREE_ENTRIES = 5000;

async function listRepositoryTreeViaContents(
  userId: string,
  owner: string,
  repo: string,
  opts: { branch?: string } = {},
): Promise<Array<{ path: string; type: "file" | "dir" }>> {
  const tree: Array<{ path: string; type: "file" | "dir" }> = [];
  const visited = new Set<string>();
  const queue = [""];

  while (queue.length > 0) {
    const currentPath = queue.shift() ?? "";
    if (visited.has(currentPath) || isIgnoredRepoPath(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    const entries = await listFiles(userId, owner, repo, {
      ...opts,
      ...(currentPath ? { path: currentPath } : {}),
    }).catch(() => [] as GitHubFileContent[]);

    for (const entry of entries) {
      const entryType: "file" | "dir" = entry.type === "dir" ? "dir" : "file";
      tree.push({
        path: entry.path,
        type: entryType,
      });

      if (tree.length >= MAX_FALLBACK_TREE_ENTRIES) {
        return tree;
      }

      if (entry.type === "dir" && !isIgnoredRepoPath(entry.path)) {
        queue.push(entry.path);
      }
    }
  }

  return tree;
}

// ─── Repository mapping ─────────────────────────────────────────────────────

/**
 * Map raw GitHub API repos to a clean, consistent shape.
 */
export function mapRepositories(repos: GitHubRepository[]): MappedRepository[] {
  if (!Array.isArray(repos)) return [];

  return repos.map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? r.full_name?.split("/")?.[0] ?? "",
    description: r.description,
    html_url: r.html_url,
    private: r.private,
    visibility: r.visibility,
    default_branch: r.default_branch,
    language: r.language,
    size: r.size,
    forks: r.forks,
    watchers: r.watchers,
    stars: r.stargazers_count ?? 0,
    license: r.license,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  }));
}

// ─── Repository operations ───────────────────────────────────────────────────

/**
 * Fetch repos for a user/org via personal OAuth token (desktop/self-hosted mode).
 * Works without a GitHub App installation.
 */
export async function listUserOwnedRepos(
  userId: string,
  owner?: string,
  opts: { organizationId?: string } = {},
): Promise<MappedRepository[]> {
  if (!owner) {
    // User's own repos
    const data = await githubFetch<GitHubRepository[]>({
      userId,
      organizationId: opts.organizationId,
      url: "https://api.github.com/user/repos",
      params: { per_page: 100, sort: "updated", affiliation: "owner,collaborator,organization_member" },
    });
    return mapRepositories(Array.isArray(data) ? data : []);
  }

  // Org repos
  const data = await githubFetch<GitHubRepository[]>({
    userId,
    organizationId: opts.organizationId,
    url: `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`,
    params: { type: "all", per_page: 100 },
  });
  return mapRepositories(Array.isArray(data) ? data : []);
}

/**
 * Fetch repositories the user can access through a specific GitHub App
 * installation.
 *
 * Uses the USER-SCOPED endpoint /user/installations/{id}/repositories
 * (authed with the user's GitHub OAuth token) rather than the install-
 * scoped /installation/repositories endpoint (which requires an App
 * installation access token — a different token type that fails with
 * 403 "must authenticate with an installation access token" if a user
 * OAuth token leaks in).
 *
 * Why this is the right choice:
 *   - The dashboard wants to show "repos the USER can deploy", which
 *     is the user-scoped intersection of (repos in the install) ∩ (repos
 *     the user has read access to).
 *   - User-scoped tokens are what we always have on the SaaS after the
 *     OAuth-first Connect flow. Installation tokens are minted only when
 *     a deploy actually needs to clone (via tokenFor("remote", ctx)).
 *   - Avoids a class of subtle 403s when tokenFor falls through to OAuth
 *     after an installation-token mint fails on edge cases.
 */
export async function listInstallationRepos(
  userId: string,
  owner: string,
  installationId?: number,
  opts: { organizationId?: string } = {},
): Promise<MappedRepository[]> {
  if (!installationId) return [];
  const data = await githubFetch<{ repositories: GitHubRepository[] }>({
    userId,
    organizationId: opts.organizationId,
    url: `https://api.github.com/user/installations/${installationId}/repositories`,
    params: { per_page: 100 },
  });
  // Owner arg kept in the signature for symmetry with caller sites + future
  // filtering, but the endpoint is installation-id-scoped so the param is
  // currently unused.
  void owner;
  return mapRepositories(data.repositories ?? []);
}

/**
 * Fetch repositories for a specific org.
 */
export async function listOrgRepos(
  userId: string,
  org: string,
  opts: { organizationId?: string } = {},
): Promise<MappedRepository[]> {
  const data = await githubFetch<GitHubRepository[]>({
    userId,
    organizationId: opts.organizationId,
    url: `https://api.github.com/orgs/${encodeURIComponent(org)}/repos`,
    params: { type: "all", per_page: 100 },
    owner: org,
  });
  return mapRepositories(data);
}

/**
 * Get a single repository, optionally with branches.
 */
export async function getRepository(
  userId: string,
  owner: string,
  repo: string,
  opts: { withBranches?: boolean; organizationId?: string } = {},
): Promise<RepositoryDetail> {
  const data = await githubFetch<GitHubRepository>({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  });

  let branches: GitHubBranch[] | undefined;
  if (opts.withBranches) {
    branches = await listBranches(userId, owner, repo, { organizationId: opts.organizationId });
  }

  return {
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    owner: data.owner?.login ?? owner,
    private: data.private,
    default_branch: data.default_branch,
    clone_url: data.clone_url,
    ssh_url: data.ssh_url,
    html_url: data.html_url,
    branches,
  };
}

/**
 * Create a new repository (user or org).
 */
export async function createRepository(
  userId: string,
  name: string,
  opts: { description?: string; private?: boolean; owner?: string; organizationId?: string } = {},
): Promise<GitHubRepository> {
  const url = opts.owner
    ? `https://api.github.com/orgs/${encodeURIComponent(opts.owner)}/repos`
    : "https://api.github.com/user/repos";

  return githubFetch<GitHubRepository>({
    userId,
    organizationId: opts.organizationId,
    url,
    method: "POST",
    owner: opts.owner,
    params: {
      name,
      description: opts.description ?? `Repository created by Openship`,
      private: opts.private ?? false,
    },
  });
}

/**
 * Delete a repository (requires admin permissions).
 */
export async function deleteRepository(
  userId: string,
  owner: string,
  repo: string,
  opts: { organizationId?: string } = {},
): Promise<void> {
  await githubFetch({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    method: "DELETE",
  });
}

// ─── Branches ────────────────────────────────────────────────────────────────

/**
 * List branches for a repository.
 */
export async function listBranches(
  userId: string,
  owner: string,
  repo: string,
  opts: { organizationId?: string } = {},
): Promise<GitHubBranch[]> {
  return githubFetch<GitHubBranch[]>({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    params: { per_page: 100 },
  });
}

/**
 * Get the latest commit on a branch.
 */
export async function getLatestCommit(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const data = await githubFetch<{ sha: string; commit: { message: string } }>({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
    });
    return { sha: data.sha, message: data.commit.message };
  } catch {
    return null;
  }
}

/**
 * Fetch recent commits from a branch via the GitHub API.
 */
export async function getRecentCommits(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
  perPage = 10,
): Promise<Array<{
  sha: string;
  message: string;
  author: string;
  authorAvatar: string;
  date: string;
  url: string;
}>> {
  try {
    const data = await githubFetch<Array<{
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author: { name: string; date: string } | null;
      };
      author: { login: string; avatar_url: string } | null;
    }>>({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      params: { sha: branch, per_page: String(perPage) },
    });

    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author?.name ?? "Unknown",
      authorAvatar: c.author?.avatar_url ?? "",
      date: c.commit.author?.date ?? "",
      url: c.html_url,
    }));
  } catch {
    return [];
  }
}

// ─── Files ───────────────────────────────────────────────────────────────────

/**
 * List files in a repository directory.
 */
export async function listFiles(
  userId: string,
  owner: string,
  repo: string,
  opts: { branch?: string; path?: string; organizationId?: string } = {},
): Promise<GitHubFileContent[]> {
  const filePath = opts.path ?? "";
  return githubFetch<GitHubFileContent[]>({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });
}

/**
 * List the full repository tree recursively.
 */
export async function listRepositoryTree(
  userId: string,
  owner: string,
  repo: string,
  opts: { branch?: string } = {},
): Promise<Array<{ path: string; type: "file" | "dir" }>> {
  const ref = opts.branch?.trim() || "HEAD";
  const data = await githubFetch<GitHubTreeResponse>({
    userId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}`,
    params: { recursive: 1 },
  });

  const tree: Array<{ path: string; type: "file" | "dir" }> = (data.tree ?? [])
    .filter((entry) => entry.type === "blob" || entry.type === "tree")
    .map((entry) => ({
      path: entry.path,
      type: entry.type === "tree" ? "dir" : "file",
    }));

  if (!data.truncated) {
    return tree;
  }

  const fallbackTree = await listRepositoryTreeViaContents(userId, owner, repo, opts).catch(() => tree);
  return fallbackTree.length > 0 ? fallbackTree : tree;
}

/**
 * Get a single file's content (decoded from base64).
 */
export async function getFileContent(
  userId: string,
  owner: string,
  repo: string,
  file: string,
  opts: { branch?: string; json?: boolean; organizationId?: string } = {},
): Promise<{
  sha: string;
  size: number;
  content: string;
  download_url: string | null;
}> {
  const data = await githubFetch<GitHubFileContent>({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file}`,
    params: opts.branch ? { ref: opts.branch } : undefined,
  });

  let content = Buffer.from(data.content ?? "", "base64").toString("utf-8");

  if (opts.json) {
    try {
      content = JSON.parse(content);
    } catch {
      /* return raw string if not valid JSON */
    }
  }

  return {
    sha: data.sha,
    size: data.size,
    content: typeof content === "string" ? content : JSON.stringify(content),
    download_url: data.download_url,
  };
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * List webhooks for a repository.
 */
export async function listWebhooks(
  userId: string,
  owner: string,
  repo: string,
  opts: { organizationId?: string } = {},
): Promise<GitHubWebhook[]> {
  return githubFetch<GitHubWebhook[]>({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
  });
}

function normalizeWebhookUrl(url?: string | null): string {
  return (url ?? "").replace(/\/+$/, "");
}

/**
 * Create a deploy webhook for a repository.
 */
export async function createWebhook(
  userId: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret?: string,
  opts: { organizationId?: string } = {},
): Promise<{ hookId: number; events: string[]; active: boolean }> {
  const config: Record<string, unknown> = {
    url: webhookUrl,
    content_type: "json",
  };
  if (secret) config.secret = secret;

  const data = await githubFetch<GitHubWebhook>({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    method: "POST",
    params: {
      name: "web",
      active: true,
      events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
      config,
    },
  });

  return { hookId: data.id, events: data.events, active: data.active };
}

/**
 * Update a webhook (e.g. toggle active state).
 */
export async function updateWebhook(
  userId: string,
  owner: string,
  repo: string,
  hookId: number,
  patch: {
    active?: boolean;
    events?: string[];
    config?: Record<string, unknown>;
    organizationId?: string;
  },
): Promise<{ id: number; active: boolean; events: string[] }> {
  const { organizationId, ...restPatch } = patch;
  const data = await githubFetch<GitHubWebhook>({
    userId,
    organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
    method: "PATCH",
    params: restPatch,
  });
  return { id: data.id, active: data.active, events: data.events };
}

/**
 * Delete a webhook from a repository.
 */
export async function deleteWebhook(
  userId: string,
  owner: string,
  repo: string,
  hookId: number,
  opts: { organizationId?: string } = {},
): Promise<void> {
  await githubFetch({
    userId,
    organizationId: opts.organizationId,
    owner,
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`,
    method: "DELETE",
  });
}

// ─── Check runs ──────────────────────────────────────────────────────────────

/**
 * Create a GitHub check run (used to report deployment status).
 */
export async function createCheckRun(
  userId: string,
  owner: string,
  repo: string,
  opts: {
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    detailsUrl?: string;
    output?: { title: string; summary: string; text?: string };
  },
): Promise<number | null> {
  try {
    const data = await githubFetch<{ id: number }>({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
      method: "POST",
      params: {
        name: opts.name,
        head_sha: opts.headSha,
        status: opts.status,
        started_at: new Date().toISOString(),
        details_url: opts.detailsUrl,
        output: opts.output,
      },
    });
    return data.id;
  } catch {
    return null;
  }
}

/**
 * Update an existing check run (e.g. mark as completed).
 */
export async function updateCheckRun(
  userId: string,
  owner: string,
  repo: string,
  checkRunId: number,
  opts: {
    status: "completed";
    conclusion: "success" | "failure" | "cancelled";
  },
): Promise<void> {
  try {
    await githubFetch({
      userId,
      owner,
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`,
      method: "PATCH",
      params: {
        status: opts.status,
        completed_at: new Date().toISOString(),
        conclusion: opts.conclusion,
      },
    });
  } catch {
    /* best-effort - don't fail the deployment if check update fails */
  }
}

// ─── User organisations ──────────────────────────────────────────────────────

/**
 * Check whether the user has a default clone token configured.
 *
 * "Default" here = `user_settings.clone_token_encrypted IS NOT NULL
 * AND clone_token_as_default = true`. We don't need to DECRYPT the
 * token — just confirm it exists and is marked default. A configured
 * default clone token means the user has opted in to using it for any
 * repo they can see, so "Local only" badging is misleading for those
 * users (the token covers it). One DB read, no per-repo cost.
 */
async function userHasDefaultCloneToken(userId: string): Promise<boolean> {
  const settings = await dbRepos.settings.findByUser(userId).catch(() => null);
  return !!(settings?.cloneTokenEncrypted && settings.cloneTokenAsDefault);
}

/**
 * SOURCE OF TRUTH for the "Local only" badge.
 *
 * Returns true ONLY when all of these are true:
 *   - The repo is private (public repos clone anonymously — no badge)
 *   - The user has NO default clone token (a clone token works for any
 *     visible repo, regardless of App coverage)
 *   - The Openship App is connected at all (if not, the page-level
 *     "Install App" banner is the right place to surface the gap —
 *     don't badge every single repo)
 *   - The repo's owner has NO App installation (if they do, the App
 *     can mint an install token for the repo, no badge needed)
 *
 * Client never duplicates this logic. It just reads `repo.source`.
 */
function shouldTagLocalOnly(args: {
  repo: { private: boolean; owner: string };
  appInstalledOwners: Set<string>;
  hasUserCloneToken: boolean;
  appConnected: boolean;
}): boolean {
  if (!args.repo.private) return false;
  if (args.hasUserCloneToken) return false;
  if (!args.appConnected) return false;
  if (args.appInstalledOwners.has(args.repo.owner.toLowerCase())) return false;
  return true;
}

/**
 * Get the user's "home" view — the canonical connection state, plus the
 * accounts and repos visible from the active source(s).
 *
 * Shape (the ONLY wire shape callers see):
 *   {
 *     state: GitHubConnectionState,   // sources + primary
 *     accounts: MappedAccount[],
 *     repos: MappedRepository[],
 *   }
 *
 * `state` is the single source of truth — see getGitHubConnectionState.
 * Listings + repos come from `state.primary`:
 *   - "openship-app" → /installations + per-install repos (merged with
 *     gh CLI repos if available, so personal forks the App isn't on
 *     still show up — clone-auth refuses them for remote builds).
 *   - "gh-cli"       → /user/repos + /user/orgs via the CLI token.
 *   - null           → empty arrays.
 */
export async function getUserHome(userId: string): Promise<{
  state: GitHubConnectionState;
  accounts: MappedAccount[];
  repos: MappedRepository[];
}> {
  const state = await getGitHubConnectionState(userId);

  // Nothing connected → return the empty shell. The dashboard renders
  // the connect prompt when state.primary === null.
  if (state.primary === null) {
    return { state, accounts: [], repos: [] };
  }

  // ── Openship App path ──────────────────────────────────────────────
  // Used whenever the App is connected. Installation-scoped tokens are
  // the safest source and produce the canonical account list.
  if (state.primary === "openship-app") {
    let accounts: MappedAccount[] = [];
    let repos: MappedRepository[] = [];
    /**
     * Set of owner logins (lowercased) that have ANY App installation.
     * Used when merging gh CLI repos so a CLI repo whose owner has an
     * App installation does NOT get a misleading "Local only" badge,
     * even though we haven't fetched that secondary install's repo list
     * yet (we don't fan out — that would overload the API on first
     * load with N parallel calls).
     *
     * Trade-off: this is owner-level granularity, not repo-level.
     * A repo-scoped installation (App granted access to only specific
     * repos under an org) will still trigger a misleading "covered"
     * tag here for repos under that org that the install can't actually
     * touch. Clone-auth will refuse those at deploy time with a clear
     * error — much better than every CLI repo flashing "Local only"
     * on every page load.
     */
    const appInstalledOwners = new Set<string>();

    try {
      const status = await getUserStatus(userId);
      const installations = await getUserInstallations(userId, status);
      // Tag every App installation account with source: "app" so the
      // dashboard can distinguish them from any CLI-side accounts that
      // get merged in later. Without this tag the settings card would
      // (and did) render CLI org memberships as if they were App
      // installations — see GitHubConnection.tsx where appAccounts
      // gates rendering on state.sources.openshipApp.connected.
      accounts = mapAccounts(installations).map((acct) => ({ ...acct, source: "app" as const }));
      for (const i of installations) {
        appInstalledOwners.add(i.account.login.toLowerCase());
      }

      if (installations.length > 0) {
        const primaryInstall =
          installations.find((i) => i.account.login === status.login) ??
          installations[0];

        // Only the PRIMARY install's repos are fetched up-front for the
        // initial visible list. Other accounts load their repos when
        // the user clicks them in the picker via fetchReposForOwner.
        repos = await listInstallationRepos(
          userId,
          primaryInstall.account.login,
          primaryInstall.id,
        );
        for (const repo of repos) repo.source = "app";
      }
    } catch (err) {
      console.warn("[GitHub] App path failed:", (err as Error).message);
    }

    // Merge gh CLI repos when available (self-hosted + cloud-connected
    // case). The `source: "cli"` tag means "Local only" in the dashboard,
    // so the rule is precise about when to apply it. SOURCE OF TRUTH for
    // "is this repo Local only?" lives entirely server-side — the client
    // just reads `repo.source`. See shouldTagLocalOnly() for the rule set.
    //
    // Pre-fetch the user's clone-token default ONCE (no per-repo DB hit),
    // so the rule can be evaluated in O(1) per repo.
    const hasUserCloneToken = await userHasDefaultCloneToken(userId);

    if (state.sources.ghCli.available) {
      try {
        const ghRepos = await listLocalGhRepos(userId);
        const byFullName = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
        const mappedGh = mapRepositories(
          Array.isArray(ghRepos) ? (ghRepos as GitHubRepository[]) : [],
        );
        for (const r of mappedGh) {
          const key = r.full_name.toLowerCase();
          const existing = byFullName.get(key);
          if (existing) {
            // Visible from both sources — App-covered, no "Local only" badge.
            existing.source = "both";
          } else if (
            !shouldTagLocalOnly({
              repo: r,
              appInstalledOwners,
              hasUserCloneToken,
              appConnected: true, // we're in the App-primary branch
            })
          ) {
            // CLI-only but the rules say "don't badge" — covered by some
            // other path (public, clone token, owner has install).
            byFullName.set(key, { ...r, source: "both" });
          } else {
            byFullName.set(key, { ...r, source: "cli" });
          }
        }
        repos = Array.from(byFullName.values());
      } catch (err) {
        console.warn("[GitHub] CLI repo merge failed:", (err as Error).message);
      }
    }

    return { state, accounts, repos };
  }

  // ── gh CLI path ────────────────────────────────────────────────────
  // state.primary === "gh-cli". The App isn't connected; listings flow
  // through the user OAuth token (which resolveToken resolves to the
  // gh CLI fallback in this case).
  //
  // Per the source-of-truth rule in shouldTagLocalOnly(): when the App
  // is not connected at all, individual repos do NOT get a "Local only"
  // badge — the page-level "Install GitHub App" banner is the right
  // place to surface that gap. Badging every single row would be noise.
  // We leave `source` undefined so the dashboard renders a clean list.
  let repos: MappedRepository[] = [];
  try {
    const data = await githubFetch<GitHubRepository[]>({
      userId,
      url: "https://api.github.com/user/repos",
      params: {
        per_page: 100,
        sort: "updated",
        affiliation: "owner,collaborator,organization_member",
      },
    });
    repos = mapRepositories(Array.isArray(data) ? data : []);
    // No per-repo source tag — App is unavailable, so badge would be redundant
    // with the page-level connect-the-App prompt.
  } catch {
    /* empty */
  }

  // Build account list from /user + /user/orgs using the same token.
  // Every account on this path is tagged source: "cli" — they're CLI
  // org memberships, NOT GitHub App installations. The library page
  // uses this list to populate the owner picker (still useful for
  // browsing repos) but the settings GitHub card refuses to render
  // them as App installations because of the source tag + the
  // appConnected gate in GitHubConnection.tsx.
  const cliLogin = state.sources.ghCli.login;
  const cliAvatar = state.sources.ghCli.avatarUrl;
  const accounts: MappedAccount[] = cliLogin
    ? [{ login: cliLogin, id: 0, avatar_url: cliAvatar ?? "", type: "User", source: "cli" }]
    : [];
  try {
    const orgs = await githubFetch<
      Array<{ login: string; id: number; avatar_url: string }>
    >({
      userId,
      url: "https://api.github.com/user/orgs",
    });
    for (const org of orgs) {
      accounts.push({
        login: org.login,
        id: org.id,
        avatar_url: org.avatar_url,
        type: "Organization",
        source: "cli",
      });
    }
  } catch {
    /* empty */
  }

  return { state, accounts, repos };
}

// ─── Webhook strategy ────────────────────────────────────────────────────────

export type WebhookStrategy = "app" | "domain" | "repo" | "none";

/**
 * Determine the base webhook strategy from global config (sync, no user context).
 *
 *  - "app"  → GitHub App handles push events natively (cloud mode).
 *  - "repo" → Create per-repo webhooks (self-hosted with a public URL).
 *  - "none" → Can't receive webhooks (localhost / private IP).
 */
export function getWebhookStrategy(): WebhookStrategy {
  if (getGitHubAuthMode() === "app") return "app";

  // For non-app modes, check if the URL is publicly reachable
  const url = runtimeTarget.api;
  if (isLocalUrl(url)) return "none";
  return "repo";
}

/**
 * Resolve the effective webhook strategy for a project + user (async).
 *
 * Priority:
 *   1. "app"    - GitHub App (cloud mode)
 *   2. "domain" - project has a webhookDomain set (direct delivery)
 *   3. "repo"   - current API target is public
 *   4. "none"   - no way to receive webhooks
 */
export async function resolveWebhookStrategy(
  _userId: string,
  project?: { webhookDomain?: string | null },
): Promise<WebhookStrategy> {
  const base = getWebhookStrategy();
  if (base === "app") return "app";

  // Project has a domain configured → direct webhook delivery
  if (project?.webhookDomain) return "domain";

  // Public API target → repo-level webhooks
  if (base === "repo") return "repo";

  return "none";
}

/**
 * Get the list of available webhook strategies for a user + project.
 * Used by the dashboard to show options to the user.
 */
export async function getAvailableStrategies(
  userId: string,
  project?: { webhookDomain?: string | null },
): Promise<{ current: WebhookStrategy; available: WebhookStrategy[] }> {
  const current = await resolveWebhookStrategy(userId, project);
  const available: WebhookStrategy[] = [];

  if (getGitHubAuthMode() === "app") {
    available.push("app");
    return { current, available };
  }

  // Domain is always available if verified domains exist (handled by UI)
  available.push("domain");

  if (!isLocalUrl(runtimeTarget.api)) {
    available.push("repo");
  }

  return { current, available };
}

/**
 * True when the URL points to a host that is NOT reachable from the
 * public internet — so GitHub's webhook delivery would fail.
 *
 * Used to decide between webhook strategies in resolveWebhookStrategy:
 *   - reachable → "repo" (per-repo webhook directly to this URL)
 *   - unreachable → "none" (caller falls back to polling or domain
 *     delivery via the project's webhookDomain)
 *
 * Conservative on parse failure (returns true). A typo'd URL is safer
 * to assume unreachable than to register a webhook GitHub will never
 * be able to deliver to.
 *
 * Covers the full set of non-routable host shapes:
 *   - DNS sentinels: localhost, *.local (mDNS)
 *   - IPv4 loopback: 127.0.0.0/8 (ALL of 127, not just .0.1)
 *   - IPv4 unspecified: 0.0.0.0
 *   - IPv4 RFC1918 private: 10/8, 172.16/12, 192.168/16
 *   - IPv4 link-local / APIPA: 169.254.0.0/16
 *   - IPv6 loopback: ::1 (with optional [::1] bracket form)
 *   - IPv6 link-local: fe80::/10
 *   - IPv6 ULA: fc00::/7 (fc/fd prefix)
 */
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return true;

    // DNS sentinel cases. `.local` is mDNS (Bonjour) — reachable only on
    // the local link, never from the public internet.
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local")
    ) {
      return true;
    }

    // IPv6 (URL parses bracketed form; strip the brackets for matching).
    // Same hostname can also arrive un-bracketed if the caller passed a
    // bare IP. fe80::/10 → fe80..febf (first byte top 10 bits); fc00::/7
    // → fc00..fdff (first byte top 7 bits, fc or fd).
    const v6 = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (v6 === "::1") return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(v6)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // ULA

    // IPv4: full 127/8 + 0/8-sentinel handled above + RFC1918 + link-local.
    // (Not collapsed into a single regex — readability beats brevity here,
    // and each /8|/12|/16 has a different intent that benefits from being
    // named in the source.)
    if (/^127\./.test(hostname)) return true;                       // loopback /8
    if (/^10\./.test(hostname)) return true;                        // RFC1918 /8
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;   // RFC1918 /12
    if (/^192\.168\./.test(hostname)) return true;                  // RFC1918 /16
    if (/^169\.254\./.test(hostname)) return true;                  // link-local /16

    return false;
  } catch {
    return true;
  }
}

// ─── Webhook registration ────────────────────────────────────────────────────

/**
 * Register a deploy webhook on a repo.
 * If creation returns 422 (already exists), finds the existing hook.
 *
 * Callers should check `getWebhookStrategy()` before calling - this will
 * throw if the URL is unreachable (localhost).
 */
export async function registerWebhook(
  userId: string,
  owner: string,
  repo: string,
  webhookUrl = `${runtimeTarget.api}/api/webhooks/github`,
  opts: { organizationId?: string } = {},
): Promise<{ hookId: number | null; events: string[] }> {
  try {
    const result = await createWebhook(
      userId,
      owner,
      repo,
      webhookUrl,
      env.GITHUB_WEBHOOK_SECRET || undefined,
      { organizationId: opts.organizationId },
    );
    return { hookId: result.hookId, events: result.events };
  } catch (err) {
    /* 422 = webhook already exists - find it */
    if (err instanceof Error && err.message.includes("422")) {
      const existing = await listWebhooks(userId, owner, repo, {
        organizationId: opts.organizationId,
      });
      const targetUrl = normalizeWebhookUrl(webhookUrl);
      const match = existing.find((h) =>
        normalizeWebhookUrl(h.config?.url) === targetUrl,
      );
      if (!match) return { hookId: null, events: [] };

      const config = env.GITHUB_WEBHOOK_SECRET
        ? {
            url: webhookUrl,
            content_type: "json",
            secret: env.GITHUB_WEBHOOK_SECRET,
          }
        : undefined;
      const updated = await updateWebhook(userId, owner, repo, match.id, {
        active: true,
        events: [...GITHUB_DEPLOY_WEBHOOK_EVENTS],
        config,
        organizationId: opts.organizationId,
      });
      return { hookId: updated.id, events: updated.events };
    }
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract owner and repo from a GitHub URL.
 */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const parts = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").split("/");
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}
