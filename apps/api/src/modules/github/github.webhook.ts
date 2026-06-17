/**
 * GitHub webhook handler - processes incoming GitHub App webhook events.
 *
 * Implements the WebhookProvider interface so it plugs into the
 * unified webhook dispatcher in modules/webhooks/.
 *
 * Handles:
 *   - installation.created  → store installation in DB
 *   - installation.deleted  → remove installation from DB
 *   - push                  → trigger branch-matched redeployment
 *   - check_run             → acknowledged, no action
 */

import { repos, type Project } from "@repo/db";
import { env } from "../../config/env";
import { triggerDeployment } from "../deployments/build.service";
import { verifyHmacSha256 } from "../webhooks/webhook.service";
import { invalidateOrgGitHubCache, invalidateUserGitHubCache } from "./github.auth";
import { getRepository } from "./github.service";
import { safeErrorMessage } from "@repo/core";
import type {
  WebhookProvider,
  WebhookVerifyResult,
  WebhookHandlerResult,
} from "../webhooks/webhook.types";
import type {
  GitHubInstallationPayload,
  GitHubPushPayload,
} from "./github.types";

// ─── Deployment deduplication ────────────────────────────────────────────────

const activeBranchDeployments = new Set<string>();

// ─── GitHub Webhook Provider ─────────────────────────────────────────────────

export const githubWebhookProvider: WebhookProvider = {
  name: "github",

  verify(payload: string | Buffer, headers: Record<string, string>): WebhookVerifyResult {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    const signature = headers["x-hub-signature-256"];

    if (!secret) {
      if (env.CLOUD_MODE || env.GITHUB_AUTH_MODE === "app") {
        return { valid: false, error: "GITHUB_WEBHOOK_SECRET is required in GitHub App mode" };
      }

      // Self-hosted installs may use unsigned repo webhooks while setting up.
      return { valid: true };
    }

    // Secret configured but no signature in request - reject
    if (!signature) {
      return { valid: false, error: "Missing x-hub-signature-256 header" };
    }

    const valid = verifyHmacSha256(payload, secret, signature);
    return valid ? { valid: true } : { valid: false, error: "Invalid signature" };
  },

  async handle(payload: unknown, headers: Record<string, string>): Promise<WebhookHandlerResult> {
    const event = headers["x-github-event"];
    if (!event) {
      return { success: true, event: "unknown", message: "Missing x-github-event header" };
    }

    switch (event) {
      case "installation":
        return handleInstallation(payload as GitHubInstallationPayload);
      case "push":
        return handlePush(payload as GitHubPushPayload);
      case "check_run":
        return { success: true, event, message: "Check run acknowledged" };
      case "ping":
        return { success: true, event, message: "Pong" };
      default:
        return { success: true, event, message: `Event '${event}' not handled` };
    }
  },
};

// ─── Installation events ─────────────────────────────────────────────────────

async function handleInstallation(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  // SaaS-only contract: the GitHub App is owned by openship.io, so
  // installation events ONLY have authoritative meaning on the SaaS
  // (env.CLOUD_MODE=true). On a self-hosted instance the App's webhook
  // is configured to point at api.openship.io — an installation event
  // arriving here means a misconfiguration. The local DB MUST NOT
  // become a parallel source of truth for installations: cloud-app mode
  // reads installations strictly from SaaS, and a stale local row would
  // lie for up to 50min after the user uninstalls or moves the App.
  // Acknowledge with 200 (so GitHub doesn't retry forever) and refuse to
  // touch local state.
  //
  // The narrow exception is GITHUB_AUTH_MODE=app, the self-host path
  // where the operator IS running their own App with local credentials
  // and no SaaS proxy. There the webhook IS the authoritative source.
  if (!env.CLOUD_MODE && env.GITHUB_AUTH_MODE !== "app") {
    console.log(
      `[GitHub Webhook] Ignoring installation.${payload.action} on self-hosted instance — SaaS (api.openship.io) is the authoritative source for GitHub App installations.`,
    );
    return {
      success: true,
      event: "installation",
      message: "Ignored on self-hosted — SaaS is the source of truth",
    };
  }

  switch (payload.action) {
    case "created":
      return handleInstallationCreated(payload);
    case "deleted":
      return handleInstallationDeleted(payload);
    case "suspend":
      return handleInstallationSuspended(payload);
    case "unsuspend":
      return handleInstallationCreated(payload); // Re-upsert to restore
    default:
      return {
        success: true,
        event: "installation",
        message: `Installation action '${payload.action}' not handled`,
      };
  }
}

async function handleInstallationCreated(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();
  const accountType = payload.installation.account.type;

  /* Find the user by their GitHub provider ID in Better Auth's account table.
   * The connect flow runs GitHub OAuth on the SaaS BEFORE the install URL,
   * so this row should always exist by the time the install webhook fires. */
  const account = await findUserByGitHubId(senderId);
  if (!account) {
    console.log(
      `[GitHub Webhook] installation.created from GitHub user ${senderId} (${accountLogin}) — no Better Auth account row. The user installed the App without doing GitHub OAuth on the SaaS first; the connect flow should have run OAuth before returning the install URL. Returning 200 so GitHub doesn't retry; user must redo Connect from the dashboard.`,
    );
    return {
      success: true,
      event: "installation",
      message: "No linked Openship user - ignored (OAuth required first)",
    };
  }

  // Webhook has no auth context. Pick the user's first membership; fall
  // back to their personal org (deterministic id `org_<userId>` —
  // provisioned for every user). gitInstallation.organizationId is
  // NOT NULL so a fallback is required, not optional.
  const memberships = await repos.member.listByUser(account.userId).catch(() => []);
  const organizationId =
    memberships[0]?.organizationId ?? `org_${account.userId}`;

  await repos.gitInstallation.upsert({
    userId: account.userId,
    organizationId,
    provider: "github",
    installationId,
    owner: accountLogin,
    ownerType: accountType,
    providerUserId: senderId,
    providerOwnerId: String(payload.installation.account.id),
    isOrg: accountType === "Organization",
  });
  await invalidateUserGitHubCache(account.userId);
  await invalidateOrgGitHubCache(organizationId);

  console.log(
    `[GitHub Webhook] installation.created on ${accountLogin} written for userId ${account.userId}`,
  );
  return {
    success: true,
    event: "installation",
    message: `Installation created for ${accountLogin}`,
  };
}

async function handleInstallationDeleted(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const account = await findUserByGitHubId(senderId);
  if (!account) {
    await repos.gitInstallation.removeByInstallationIdForProvider(installationId);
    return { success: true, event: "installation", message: "No linked user - ignored" };
  }

  // Capture the install row's organizationId BEFORE deleting so the
  // team's shared cache entries get cleared too.
  const existing = await repos.gitInstallation
    .findByOwner(account.userId, accountLogin)
    .catch(() => null);
  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);
  await invalidateUserGitHubCache(account.userId);
  if (existing?.organizationId) {
    await invalidateOrgGitHubCache(existing.organizationId);
  }

  return { success: true, event: "installation", message: "Installation removed" };
}

async function handleInstallationSuspended(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const account = await findUserByGitHubId(senderId);
  if (!account) {
    await repos.gitInstallation.removeByInstallationIdForProvider(installationId);
    return { success: true, event: "installation", message: "No linked user - ignored" };
  }

  // Suspended installations can't issue tokens - remove so token resolution
  // falls back to the user's OAuth token, and linkRepo will prompt re-install.
  const existing = await repos.gitInstallation
    .findByOwner(account.userId, accountLogin)
    .catch(() => null);
  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);
  await invalidateUserGitHubCache(account.userId);
  if (existing?.organizationId) {
    await invalidateOrgGitHubCache(existing.organizationId);
  }
  console.log(`[GitHub Webhook] Installation suspended for ${accountLogin} - removed from DB`);

  return { success: true, event: "installation", message: `Installation suspended for ${accountLogin}` };
}

// ─── Branch deployment events ────────────────────────────────────────────────

async function handlePush(payload: GitHubPushPayload): Promise<WebhookHandlerResult> {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const ref = payload.ref;
  const commitSha = payload.head_commit?.id;
  const defaultBranch = payload.repository?.default_branch;

  if (!owner || !repo) {
    return { success: false, event: "push", error: "Missing repository info in payload" };
  }

  if (payload.deleted) {
    return { success: true, event: "push", message: "Ignoring deleted branch push" };
  }

  if (!ref?.startsWith("refs/heads/")) {
    return { success: true, event: "push", message: `Ignoring non-branch ref: ${ref ?? "unknown"}` };
  }

  const branch = ref.replace("refs/heads/", "");

  return triggerBranchDeployments({
    event: "push",
    owner,
    repo,
    branch,
    defaultBranch,
    commitSha,
    commitMessage: payload.head_commit?.message,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface BranchDeploymentTrigger {
  event: "push";
  owner: string;
  repo: string;
  branch: string;
  defaultBranch?: string | null;
  commitSha?: string;
  commitMessage?: string;
}

async function triggerBranchDeployments(
  input: BranchDeploymentTrigger,
): Promise<WebhookHandlerResult> {
  const deploymentKey = branchDeploymentKey(input);

  if (activeBranchDeployments.has(deploymentKey)) {
    return {
      success: true,
      event: input.event,
      message: `Already handled deployment trigger for ${input.owner}/${input.repo}#${input.branch}`,
    };
  }

  activeBranchDeployments.add(deploymentKey);

  try {
    const projects = await repos.project.findByGitRepo(input.owner, input.repo);
    const defaultBranch = await resolveDefaultBranch(input, projects);
    const autoDeployProjects = projects.filter(
      (p) => p.autoDeploy && projectWebhookBranch(p, defaultBranch) === input.branch,
    );

    if (autoDeployProjects.length === 0) {
      console.log(
        `[GitHub Webhook] ${input.event} for ${input.owner}/${input.repo}#${input.branch} - no matching auto-deploy projects`,
      );
      return { success: true, event: input.event, message: "No auto-deploy projects matched" };
    }

    const results = await Promise.allSettled(
      autoDeployProjects.map(async (p) => {
        // Webhooks have no human actor — resolve a system actor from the
        // project's org membership for token resolution + audit attribution.
        const actorUserId = await resolveOrgActor(p.organizationId);
        if (!actorUserId) {
          throw new Error(
            `No org member available to act as webhook actor for project ${p.id} (org ${p.organizationId})`,
          );
        }
        return triggerDeployment(actorUserId, {
          projectId: p.id,
          branch: input.branch,
          commitSha: input.commitSha,
          commitMessage: input.commitMessage,
          trigger: "webhook",
        });
      }),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    if (failed > 0) {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason));
      console.error(
        `[GitHub Webhook] ${input.event} deploy failures for ${input.owner}/${input.repo}#${input.branch}:`,
        errors,
      );
    }

    return {
      success: true,
      event: input.event,
      message:
        `Triggered ${succeeded} deployment(s) for ${input.owner}/${input.repo}#${input.branch}` +
        `${failed ? `, ${failed} failed` : ""}`,
    };
  } finally {
    activeBranchDeployments.delete(deploymentKey);
  }
}

function projectWebhookBranch(project: Project, defaultBranch?: string | null): string | null {
  return project.gitBranch?.trim() || defaultBranch?.trim() || null;
}

async function resolveDefaultBranch(
  input: BranchDeploymentTrigger,
  projects: Project[],
): Promise<string | null> {
  const payloadDefaultBranch = input.defaultBranch?.trim();
  if (payloadDefaultBranch) return payloadDefaultBranch;

  const unbranchedProject = projects.find(
    (p) => !p.gitBranch?.trim() && p.gitOwner && p.gitRepo,
  );
  if (!unbranchedProject) return null;

  try {
    const actorUserId = await resolveOrgActor(unbranchedProject.organizationId);
    if (!actorUserId) return null;
    const repository = await getRepository(actorUserId, input.owner, input.repo, {
      organizationId: unbranchedProject.organizationId,
    });
    return repository.default_branch;
  } catch (err) {
    const message = safeErrorMessage(err);
    console.warn(
      `[GitHub Webhook] Could not resolve default branch for ${input.owner}/${input.repo}: ${message}`,
    );
    return null;
  }
}

function branchDeploymentKey(input: BranchDeploymentTrigger): string {
  const commit = input.commitSha?.trim() || "unknown";
  return `${input.owner}/${input.repo}#${input.branch}@${commit}`.toLowerCase();
}

/**
 * Resolve a system actor for webhook-initiated work — pick the first member
 * of the project's organization so token resolution and audit attribution
 * have a real userId to hang off of. Webhooks have no human session.
 */
async function resolveOrgActor(organizationId: string): Promise<string | null> {
  const members = await repos.member.listByOrganization(organizationId).catch(() => []);
  return members[0]?.userId ?? null;
}

/**
 * Find our user by their GitHub account ID using Better Auth's account table.
 */
async function findUserByGitHubId(githubId: string) {
  const account = await repos.account.findByProviderAccountId("github", githubId);
  if (!account) return null;
  return { userId: account.userId, accountId: account.accountId };
}


