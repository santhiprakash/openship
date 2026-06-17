/**
 * Build service - build session lifecycle + build→deploy pipeline.
 */

import { posix as pathPosix } from "node:path";

import { repos, type Project, type Deployment, type Domain } from "@repo/db";
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  DeployError,
  BUILD_ENV_VARS,
  SYSTEM,
  STACKS,
  getRuntimeImage,
  type StackId,
  type DeployTarget,
  type BuildStrategy,
  type StackDefinition,
  safeErrorMessage,
} from "@repo/core";
import type {
  BuildConfig,
  BuildResult,
  CommandExecutor,
  DeployConfig,
  DeployEnvironment,
  LogEntry,
  ResourceConfig,
} from "@repo/adapters";
import {
  BareRuntime,
  BuildLogger,
  CloudRuntime,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  DockerRuntime,
  ensurePortAvailable,
  runDeployPipeline,
  createPlatform,
  isMultiServiceRuntime,
} from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { env, internalApiUrl } from "../../config";
import { resolveDeploymentRuntime, resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { ensureManagedEdgeProxy } from "../../lib/managed-edge-proxy";
import { decryptEnvMap, encrypt } from "../../lib/encryption";
import {
  buildProjectRouteDomains,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
} from "../../lib/routing-domains";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import { withDefaults } from "../../lib/resources";
import { resolveBuildGitToken } from "../github/clone-auth";
import { getLatestCommit, getRepository } from "../github/github.service";
import { pruneRetainedBareReleases } from "./release-retention";
import * as sessionManager from "./session-manager";
import { onFailure, onSuccess, onCancelled, type LifecycleContext } from "./deployment-lifecycle";
import {
  collectDeploymentManifest,
  executeCleanup,
  type CleanupManifest,
} from "../projects/project-cleanup.service";
import { runPreflightChecks, type PreflightResult } from "./preflight";
import { createBuildConfig } from "./build-config";
import {
  executeComposePipeline,
  isMultiServiceProject,
  listProjectComposeServices,
  projectServicesToDeployableServices,
  resolveProjectServicePreflightServices,
  shouldUseProjectServicePipeline,
} from "./compose";
import * as settingsService from "../settings/settings.service";
import { serviceKind, type DeployableService } from "../../lib/deployable-service";
import {
  listProjectRouteRows,
  resolveProjectRouteState,
  syncProjectRouteState,
} from "../domains/project-route.service";

// ─── Terminal output collapsing ──────────────────────────────────────────────

/**
 * Collapse raw log entries into their final terminal-rendered state.
 *
 * During live streaming, xterm handles \r (carriage return) to overwrite lines
 * in-place (e.g., git progress "Counting objects:  42%\r...100%").
 * When persisting to DB we don't want all intermediate lines - just the final
 * rendered result, as a terminal would show.
 *
 * Step events (entries with `step` field) pass through unchanged - they're
 * structured metadata for the stepper UI, not terminal output.
 */
function collapseTerminalLogs(entries: LogEntry[]): LogEntry[] {
  const result: LogEntry[] = [];
  // Virtual line buffer - simulates one terminal line
  let currentLine = "";
  let currentLevel: LogEntry["level"] = "info";
  let currentTimestamp = "";
  let currentServiceName: string | undefined;

  const flushLine = () => {
    const trimmed = currentLine.trimEnd();
    if (trimmed) {
      result.push({
        timestamp: currentTimestamp,
        message: trimmed,
        level: currentLevel,
        serviceName: currentServiceName,
      });
    }
    currentLine = "";
  };

  for (const entry of entries) {
    // Step events pass through as-is
    if (entry.step) {
      flushLine();
      result.push(entry);
      continue;
    }

    if (currentLine && entry.serviceName !== currentServiceName) {
      flushLine();
    }

    const text = entry.message;
    currentLevel = entry.level;
    currentTimestamp = entry.timestamp;
    currentServiceName = entry.serviceName;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\r") {
        // Check for \r\n (treat as plain newline)
        if (i + 1 < text.length && text[i + 1] === "\n") {
          flushLine();
          i++; // skip the \n
        } else {
          // Bare \r - overwrite: reset current line (don't flush)
          currentLine = "";
        }
      } else if (ch === "\n") {
        flushLine();
      } else {
        currentLine += ch;
      }
    }
  }

  // Flush any remaining content
  flushLine();
  return result;
}

function throwPreflightFailure(preflight: PreflightResult): never {
  const failedChecks = preflight.checks.filter((check) => check.status === "fail");
  const failures = failedChecks.map((check) => `${check.label}: ${check.message}`).join("; ");
  const codes = Array.from(
    new Set(
      failedChecks.map((check) => check.code).filter((code): code is string => Boolean(code)),
    ),
  );
  const errorCode =
    codes.length === 1 && failedChecks.every((check) => check.code === codes[0])
      ? codes[0]
      : "PRE_DEPLOY_CHECKS_FAILED";

  throw new AppError(`Pre-deploy checks failed: ${failures}`, 403, errorCode);
}

/** Wrap a snapshot with the project's currently-active deployment id (rollback target). */
export function metaWithPrevious(
  snapshot: DeploymentConfigSnapshot,
  project: Project,
): DeploymentConfigSnapshot {
  return { ...snapshot, previousActiveDeploymentId: project.activeDeploymentId ?? undefined };
}

/**
 * Spawn the actual build pipeline for a freshly-queued deployment.
 *
 * Three callers (triggerDeployment, startBuild, redeployBuildSession) all
 * need to: locate the build session, register the SSE channel, then
 * fire-and-forget executeBuildAndDeploy with the safety-net error handler.
 * Extracted so changes (telemetry, throttling, queueing) happen in one
 * place instead of drifting across three.
 *
 * Returns the buildSessionId on success, or null when the build session
 * row is missing. The caller decides whether to throw or carry on - for
 * `redeploy` we want to skip silently; for `triggerDeployment` we throw.
 */
async function kickoffBuild(project: Project, dep: Deployment): Promise<string | null> {
  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  if (!buildSession) return null;

  // Flip the row to "building" SYNCHRONOUSLY before firing the async
  // `executeBuildAndDeploy`. Without this, callers that chain
  // `redeployBuildSession` → `startBuild` (the dashboard does this on
  // every redeploy, see [build/[id]/page.tsx][1]) hit a race:
  //
  //   1. redeployBuildSession creates dep (status="queued") and calls
  //      kickoffBuild → fires executeBuildAndDeploy as `void`.
  //   2. kickoffBuild returns; the row is STILL "queued" because the
  //      async hasn't updated it yet.
  //   3. Dashboard reads the new deployment_id and calls /build/:id which
  //      runs startBuild → loadDeployment → status="queued" → falls through
  //      the idempotency guard at line ~1045 → kickoffBuild AGAIN.
  //   4. Two executeBuildAndDeploy in parallel for one deployment, both
  //      provisioning workspaces and double-logging to the same SSE
  //      stream - which is what users were seeing.
  //
  // [1]: apps/dashboard/src/app/(dashboard)/(deployment)/build/[id]/page.tsx
  await repos.deployment.updateStatus(dep.id, "building").catch(() => {
    // Best effort - if this fails, the worst case is the old race
    // returns. executeBuildAndDeploy will set the status itself when it
    // starts.
  });
  dep.status = "building";

  sessionManager.createSession(dep.id, project.id);

  void executeBuildAndDeploy(project, dep, buildSession.id).catch(async (err) => {
    console.error(`[DEPLOY] Fatal error for ${dep.id}:`, err);
    // executeBuildAndDeploy's inner try/catch only arms onFailure() after
    // snapshot + route state resolve. Anything that throws before that
    // (missing snapshot, route lookup crash, runtime resolution) would
    // otherwise leave the row queued forever - this guarantees the
    // deployment is marked failed and the SSE stream gets a closing
    // message.
    await markDeploymentFailedFromOutside(dep.id, err);
  });

  return buildSession.id;
}

/**
 * Fallback failure handler for errors thrown out of executeBuildAndDeploy
 * before its own try/catch arms onFailure(). Without this, an early
 * snapshot/route-state crash would leave the deployment stuck at "queued"
 * forever (the void .catch() just logged to console).
 *
 * Idempotent - if the deployment already reached "failed"/"ready"/"cancelled",
 * skips. Otherwise marks failed, flushes a final log line through SSE so the
 * dashboard stops spinning, and ends the session.
 */
async function markDeploymentFailedFromOutside(deploymentId: string, error: unknown): Promise<void> {
  const message = safeErrorMessage(error);
  try {
    const dep = await repos.deployment.findById(deploymentId).catch(() => null);
    if (!dep) return;
    if (["failed", "ready", "cancelled"].includes(dep.status)) {
      // Inner onFailure already ran (or the deploy somehow succeeded). Nothing to do.
      return;
    }
    await repos.deployment.updateStatus(deploymentId, "failed").catch(() => {});
    const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId).catch(() => null);
    if (buildSession) {
      await repos.deployment.updateBuildSession(buildSession.id, {
        status: "failed",
        finishedAt: new Date(),
      }).catch(() => {});
    }
    // SSE: surface the error to anyone watching the stream and close it.
    sessionManager.appendLog(deploymentId, {
      timestamp: new Date().toISOString(),
      message: `Deployment failed before build started: ${message}`,
      level: "error",
    });
    sessionManager.updateStatus(deploymentId, "failed");
  } catch (handlerErr) {
    console.error(`[DEPLOY] markDeploymentFailedFromOutside crashed for ${deploymentId}:`, handlerErr);
  }
}

/**
 * Compose-vs-normal pipeline gate (single source of truth).
 * Single mode short-circuits; otherwise we resolve services + pipeline in parallel.
 */
async function resolveServicePipelineMode(
  project: Project,
  snapshot: DeploymentConfigSnapshot,
): Promise<{
  useSingleAppPipeline: boolean;
  useServicePipeline: boolean;
  servicePreflightServices: DeployableService[];
}> {
  if (snapshot.serviceDeploymentMode === "single") {
    return { useSingleAppPipeline: true, useServicePipeline: false, servicePreflightServices: [] };
  }

  const [servicePreflightServices, useServicePipeline] = await Promise.all([
    resolveProjectServicePreflightServices(project.id, snapshot.composeServices),
    shouldUseProjectServicePipeline(project, snapshot.composeServices),
  ]);

  return { useSingleAppPipeline: false, useServicePipeline, servicePreflightServices };
}

/** Run preflight against a snapshot+route state and throw a structured failure on any check fail. */
export async function runDeploymentPreflight(
  snapshot: DeploymentConfigSnapshot,
  routeState: Awaited<ReturnType<typeof resolveProjectRouteState>>,
  opts: {
    userId: string;
    composeServices?: DeployableService[];
    multiService?: boolean;
    /** Git owner of the source repo. Cloud preflight uses it to verify the
     *  GitHub App is installed for this owner before the build pipeline
     *  spends resources cloning a repo it can't access. */
    gitOwner?: string | null;
    /** Project id — passed to the remote-clone-token preflight check so
     *  project-scoped clone tokens are considered. */
    projectId?: string;
    /** Active organization id — preflight uses this for the org-scoped
     *  App installation lookup. */
    organizationId?: string;
  },
): Promise<void> {
  const preflight = await runPreflightChecks(snapshot, {
    customDomain: routeState.primaryCustomDomain,
    slug:
      routeState.publicEndpoints.length > 0 && routeState.primaryDomainType === "free"
        ? routeState.primarySlug
        : undefined,
    userId: opts.userId,
    publicEndpoints: routeState.publicEndpoints,
    ...(opts.composeServices ? { composeServices: opts.composeServices } : {}),
    ...(opts.multiService !== undefined ? { multiService: opts.multiService } : {}),
    ...(opts.gitOwner !== undefined ? { gitOwner: opts.gitOwner } : {}),
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    ...(opts.organizationId !== undefined ? { organizationId: opts.organizationId } : {}),
    buildStrategy: snapshot.buildStrategy as "local" | "server" | undefined,
  });
  if (!preflight.ok) {
    throwPreflightFailure(preflight);
  }
}

function buildScopedEnvVars(
  envVars: Record<string, string>,
  opts?: { forceProductionNodeEnv?: boolean },
): {
  envVars: Record<string, string>;
  ignoredNodeEnv?: string;
} {
  const scoped = { ...envVars };
  let ignoredNodeEnv: string | undefined;

  if (opts?.forceProductionNodeEnv) {
    ignoredNodeEnv = scoped.NODE_ENV;
    delete scoped.NODE_ENV;
  }

  return {
    envVars: {
      ...BUILD_ENV_VARS,
      ...scoped,
      ...(opts?.forceProductionNodeEnv ? { NODE_ENV: "production" } : {}),
    },
    ignoredNodeEnv,
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Config snapshot stored in deployment.meta - self-contained build+deploy config. */
export interface DeploymentConfigSnapshot {
  /** Owning organization — required so server lookups can be org-scoped. */
  organizationId?: string;
  repoUrl: string;
  branch: string;
  framework: string;
  buildImage: string;
  runtimeImage: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string[];
  rootDirectory: string;
  port: number;
  startCommand: string;
  resources: ResourceConfig | null;
  buildResources: ResourceConfig | null;
  /** Whether the project needs a running server (false = static, deploy via Pages) */
  hasServer: boolean;
  /** Whether the project needs a build step (false = deploy source directly) */
  hasBuild: boolean;
  /** Absolute path to a local project directory (alternative to repoUrl) */
  localPath?: string;
  /** Build strategy: "server" (build in workspace) or "local" (build on host) */
  buildStrategy?: BuildStrategy;
  /** Deploy target: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget?: DeployTarget;
  /** Target server ID when deployTarget is "server" */
  serverId?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode?: "bare" | "docker";
  /** Project services fan-out mode captured for this deployment. */
  serviceDeploymentMode?: "services" | "single";
  /**
   * Deployable services captured at deploy request time. Mixed shape:
   * compose-source rows AND monorepo sub-app rows travel through the
   * same pipeline, discriminated by `kind`. See `DeployableService`.
   */
  composeServices?: DeployableService[];
  /** Summary of a compose deployment fan-out, when applicable. */
  composeDeployment?: {
    totalServices: number;
    successfulServices: number;
    failedServices: number;
    failedServiceNames: string[];
    warningMessage?: string;
  };
  previousActiveDeploymentId?: string;
}

export interface BuildAccessInput {
  projectId: string;
  branch?: string;
  environment?: string;
  envVars?: Record<string, string>;
  publicEndpoints?: Array<{
    port?: string;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  buildStrategy?: BuildStrategy;
  deployTarget?: DeployTarget;
  serverId?: string;
  runtimeMode?: "bare" | "docker";
  serviceDeploymentMode?: "services" | "single";
  services?: DeployableService[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a config snapshot from the project - pure pass-through, no fallbacks.
 *  All values must be set by prepare / ensureProject before this is called. */
export function buildConfigSnapshot(
  project: Project,
  branch?: string,
): DeploymentConfigSnapshot {
  const runtimeImage = resolveRuntimeImage(project);

  return {
    repoUrl: project.gitUrl ?? "",
    branch: branch || project.gitBranch || (project.localPath ? "main" : ""),
    framework: project.framework!,
    buildImage: project.buildImage!,
    runtimeImage,
    packageManager: project.packageManager!,
    installCommand: project.installCommand!,
    buildCommand: project.buildCommand!,
    outputDirectory: project.outputDirectory!,
    productionPaths: parseProductionPaths(project.productionPaths, project.framework),
    rootDirectory: project.rootDirectory || "",
    port: project.port ?? 3000,
    startCommand: project.startCommand!,
    resources: (project.resources as ResourceConfig) || null,
    buildResources: (project.buildResources as ResourceConfig) || null,
    hasServer: project.hasServer ?? !!project.startCommand?.trim(),
    hasBuild: project.hasBuild ?? true,
    localPath: project.localPath || undefined,
  };
}

async function resolveLatestCommitInfo(userId: string, project: Project, branch: string) {
  if (!project.gitOwner || !project.gitRepo) {
    return {};
  }

  const head = await getLatestCommit(userId, project.gitOwner, project.gitRepo, branch);
  return head ? { commitSha: head.sha, commitMessage: head.message } : {};
}

async function resolveProjectBranch(userId: string, project: Project, branch?: string) {
  const configuredBranch = branch?.trim() || project.gitBranch?.trim();
  if (configuredBranch) return configuredBranch;

  if (project.gitOwner && project.gitRepo) {
    const repository = await getRepository(userId, project.gitOwner, project.gitRepo);
    return repository.default_branch;
  }

  return "main";
}

function resolveRuntimeImage(project: Project): string {
  const hasServer = project.hasServer ?? !!project.startCommand?.trim();
  const stackId = (
    project.framework && project.framework in STACKS ? project.framework : "unknown"
  ) as StackId;

  if (!hasServer) {
    return getRuntimeImage("static", project.packageManager ?? undefined);
  }

  return getRuntimeImage(stackId, project.packageManager ?? undefined);
}

/** Parse productionPaths from DB text (comma-separated) with STACKS fallback. */
function parseProductionPaths(
  raw: string | null | undefined,
  framework: string | null | undefined,
): string[] {
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (framework && framework in STACKS) {
    const paths = STACKS[framework as StackId] as StackDefinition;
    return paths.productionPaths ? [...paths.productionPaths] : [];
  }
  return [];
}

function resolveStaticOutputDirectory(outputDirectory: string, targetPath?: string): string {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  if (!normalizedTargetPath || normalizedTargetPath === "/") {
    return outputDirectory;
  }

  if (!outputDirectory || outputDirectory === ".") {
    return normalizedTargetPath.slice(1);
  }

  return pathPosix.join(outputDirectory, normalizedTargetPath.slice(1));
}

/** Encrypt a plaintext key-value map. Returns null if empty. */
export function encryptEnvVars(envVars?: Record<string, string>): Record<string, string> | null {
  if (!envVars || Object.keys(envVars).length === 0) return null;
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    encrypted[k] = encrypt(v);
  }
  return encrypted;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Load a deployment + its project, refusing if their organizations don't
 * agree. The calling route's permission middleware already verified the
 * caller is a member of the deployment's org; this is a defense-in-depth
 * check against a deployment ever outliving a project moving orgs.
 */
async function loadDeployment(deploymentId: string) {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new NotFoundError("Deployment", deploymentId);

  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Deployment", deploymentId);

  if (dep.organizationId !== project.organizationId) {
    throw new NotFoundError("Deployment", deploymentId);
  }

  return { dep, project };
}

/** Throw if the project already has an in-progress deployment. */
async function checkNoActiveBuild(projectId: string) {
  const { rows } = await repos.deployment.listByProject(projectId, {
    page: 1,
    perPage: SYSTEM.DEPLOYMENTS.MAX_CONCURRENT_PER_PROJECT + 1,
  });
  const active = rows.find((d) => ["queued", "building", "deploying"].includes(d.status));
  if (active) {
    throw new ForbiddenError(
      `A deployment is already in progress (${active.id}). Cancel it first or wait for it to complete.`,
    );
  }
}

/**
 * Create a queued deployment + build session atomically.
 * If the build session insert fails, the deployment is cleaned up.
 */
/**
 * Detection: the partial unique index uq_deployment_one_active_per_project
 * surfaces this Postgres / pglite error code when two webhook
 * deliveries race to create a deployment for the same project.
 */
function isActiveDeploymentRace(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === "23505") return true; // unique_violation
  return Boolean(e.message?.includes("uq_deployment_one_active_per_project"));
}

export async function createQueuedDeployment(opts: {
  projectId: string;
  userId: string;
  /** Org that owns this deployment. Pass project.organizationId. userId
   *  stays as the forensic actor stamp; org is the scoping key. */
  organizationId: string;
  branch: string;
  environment: string;
  framework: string;
  meta: DeploymentConfigSnapshot;
  envVars: Record<string, string> | null;
  commitSha?: string;
  commitMessage?: string;
  trigger?: string;
}) {
  let dep;
  try {
    dep = await repos.deployment.create({
      projectId: opts.projectId,
      organizationId: opts.organizationId,
      branch: opts.branch,
      commitSha: opts.commitSha,
      commitMessage: opts.commitMessage,
      trigger: opts.trigger ?? "manual",
      environment: opts.environment,
      framework: opts.framework,
      status: "queued",
      meta: opts.meta,
      envVars: opts.envVars,
    });
  } catch (err) {
    // Race: another caller raced past checkNoActiveBuild and won the
    // INSERT. Surface as a 403 to match the early-rejection path.
    if (isActiveDeploymentRace(err)) {
      throw new ForbiddenError(
        "Another deployment is already in progress for this project. Wait for it to finish or cancel it.",
      );
    }
    throw err;
  }

  try {
    await repos.deployment.createBuildSession({
      deploymentId: dep.id,
      projectId: opts.projectId,
      status: "queued",
    });
  } catch (err) {
    // Atomicity: clean up orphaned deployment
    await repos.deployment.deleteDeployment(dep.id).catch(() => {});
    throw err;
  }

  return dep;
}

// ─── SSE streaming (re-export) ───────────────────────────────────────────────

/** Subscribe to live build logs by deployment ID (dep_xxx). */
export { subscribe as subscribeToBuildSession } from "./session-manager";

// ─── Build access (create deployment with config snapshot) ───────────────────

/**
 * Create a deployment + build session for an existing project.
 * Snapshots project config into deployment.meta,
 * encrypts env vars into deployment.envVars.
 *
 * Project MUST exist before calling this.
 */

/** Resolve a pending pipeline prompt (e.g. port conflict). */
export async function respondToPrompt(
  deploymentId: string,
  userId: string,
  action: string,
): Promise<boolean> {
  await loadDeployment(deploymentId);
  return sessionManager.respondToPrompt(deploymentId, action);
}

export async function requestBuildAccess(userId: string, input: BuildAccessInput) {
  const {
    projectId,
    branch,
    environment,
    envVars,
    publicEndpoints,
    buildStrategy,
    deployTarget,
    serverId,
    runtimeMode,
    serviceDeploymentMode,
    services,
  } = input;

  const project = await repos.project.findById(projectId);
  if (!project) {
    throw new NotFoundError("Project", projectId);
  }
  // Org-membership is verified by the route-level requirePermission
  // middleware before this is reached.

  await checkNoActiveBuild(project.id);

  const resolvedBranch = await resolveProjectBranch(userId, project, branch);
  const projectDomains = await listProjectRouteRows(project.id);
  let routeState = await resolveProjectRouteState(project, { projectDomains });
  const snapshot = buildConfigSnapshot(project, resolvedBranch);

  if (publicEndpoints !== undefined) {
    const routing = await syncProjectRouteState(project, {
      projectDomains,
      nextPublicEndpoints: publicEndpoints,
      slug: routeState.publicEndpoints.find((endpoint) => endpoint.domainType === "free")?.domain,
    });
    routeState = routing;
  }

  const requestedServiceMode =
    serviceDeploymentMode === "single"
      ? "single"
      : serviceDeploymentMode === "services" || services?.length
        ? "services"
        : undefined;

  if (requestedServiceMode) {
    snapshot.serviceDeploymentMode = requestedServiceMode;
  }
  if (requestedServiceMode === "services" && services?.length) {
    snapshot.composeServices = services;
  }
  const { useServicePipeline, servicePreflightServices } = await resolveServicePipelineMode(
    project,
    snapshot,
  );

  // Resolve effective build strategy via settings service
  snapshot.buildStrategy = await settingsService.resolveStrategy(
    userId,
    snapshot.framework,
    buildStrategy ?? snapshot.buildStrategy,
  );

  // Persist deploy target from the UI (desktop-only picker)
  if (deployTarget) {
    snapshot.deployTarget = deployTarget;
  }
  if (serverId) {
    snapshot.serverId = serverId;
  }
  if (runtimeMode) {
    snapshot.runtimeMode = runtimeMode;
  }

  // ── Preflight: validate config + domain before creating any resources ──
  await runDeploymentPreflight(snapshot, routeState, {
    userId,
    composeServices: servicePreflightServices,
    multiService: useServicePipeline,
    gitOwner: project.gitOwner,
    projectId: project.id,
    organizationId: project.organizationId ?? undefined,
  });
  const env = environment || "production";

  // ── Resolve commit info from the branch HEAD ────
  const { commitSha, commitMessage } = await resolveLatestCommitInfo(
    userId,
    project,
    snapshot.branch,
  );

  const dep = await createQueuedDeployment({
    projectId: project.id,
    userId,
    organizationId: project.organizationId ?? null,
    branch: snapshot.branch,
    commitSha,
    commitMessage,
    environment: env,
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptEnvVars(envVars),
  });

  // Store env vars on project as "latest defaults"
  if (envVars && Object.keys(envVars).length > 0) {
    const vars = Object.entries(envVars).map(([key, value]) => ({
      key,
      value: encrypt(value),
      isSecret: false,
    }));
    await repos.project.bulkSetEnvVars(project.id, env, vars);
  }

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Build session status ────────────────────────────────────────────────────

export async function getBuildSessionStatus(deploymentId: string, userId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  const buildSessionRow = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  const memSession = sessionManager.getSession(deploymentId);
  const isActive =
    memSession != null && !["ready", "failed", "cancelled"].includes(memSession.status);

  const logEntries = isActive
    ? (memSession?.logs ?? (buildSessionRow?.logs as LogEntry[] | null) ?? [])
    : ((buildSessionRow?.logs as LogEntry[] | null) ?? memSession?.logs ?? []);
  // Filter out step-metadata entries - they drive the progress bar, not the terminal
  const terminalEntries = logEntries
    .map((entry, eventId) => ({ entry, eventId }))
    .filter(({ entry }) => !(entry.step && entry.stepStatus));
  const logsText = terminalEntries.map(({ entry }) => entry.message).join("\n");
  const structuredLogs = terminalEntries.map(({ entry, eventId }) => ({
    text: entry.message,
    time: entry.timestamp,
    level: entry.level,
    serviceName: entry.serviceName,
    rawData: entry.rawData,
    eventId,
  }));
  const lastEventId = (() => {
    for (let index = logEntries.length - 1; index >= 0; index--) {
      const entry = logEntries[index];
      if (!(entry.step && entry.stepStatus)) {
        return index;
      }
    }
    return undefined;
  })();

  // In-memory session is real-time truth (updated every phase transition).
  // DB build-session row only moves queued → building → final, so it's stale during deploy.
  const effectiveStatus = memSession
    ? memSession.status
    : buildSessionRow
      ? buildSessionRow.status
      : dep.status;

  // Route state is always resolved live from route rows.
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  const routeState = await resolveProjectRouteState(project);

  // Derive step progress from persisted log entries when no active session
  let currentStep = 0;
  let progress = 0;
  if (isActive) {
    // Truly active session - frontend gets live progress via SSE, don't override
    currentStep = undefined as unknown as number;
    progress = undefined as unknown as number;
  } else if (effectiveStatus === "ready") {
    currentStep = 4; // past deploy
    progress = 100;
  } else {
    // Scan persisted logs for step events to find where it got to
    const STEP_INDEX: Record<string, number> = { clone: 0, install: 1, build: 2, deploy: 3 };
    const STEP_PROGRESS: Record<string, number> = { clone: 5, install: 25, build: 50, deploy: 75 };
    for (const entry of logEntries) {
      if (entry.step && entry.step in STEP_INDEX) {
        const idx = STEP_INDEX[entry.step];
        if (idx >= currentStep) {
          currentStep = idx;
          progress = STEP_PROGRESS[entry.step];
          // If this step completed, advance progress beyond it
          if (entry.stepStatus === "completed") {
            progress = STEP_PROGRESS[entry.step] + 10;
          }
        }
      }
    }
    // For failed/cancelled, keep progress where it stopped
  }

  const [deploymentServices, projectServices] = await Promise.all([
    repos.service.listByDeployment(deploymentId).catch(() => []),
    repos.service.listByProject(project.id).catch(() => []),
  ]);
  const isServiceDeployment =
    snapshot?.serviceDeploymentMode === "services" ||
    (
      snapshot?.serviceDeploymentMode !== "single" &&
      (
        !!snapshot?.composeDeployment ||
        deploymentServices.length > 0 ||
        projectServices.length > 0 ||
        isMultiServiceProject(project)
      )
    );
  const projectType = isServiceDeployment
    ? ("services" as const)
    : snapshot?.runtimeMode === "docker"
      ? ("docker" as const)
      : ("app" as const);

  const composeData =
    projectType === "services"
      ? {
          composeDeployment: snapshot?.composeDeployment ?? null,
          serviceStatuses: deploymentServices.map((service) => ({
            serviceId: service.serviceId,
            status: service.status,
            containerId: service.containerId,
            hostPort: service.hostPort,
            ip: service.ip,
            imageRef: service.imageRef,
          })),
          services: projectServices
            .filter((service) => service.enabled)
            .map((service) => ({
              serviceId: service.id,
              serviceName: service.name,
              image: service.image,
              build: service.build,
            })),
        }
      : {};

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
    status: effectiveStatus,
    is_active: isActive,
    logs: logsText,
    logEntries: structuredLogs,
    lastEventId,
    config: {
      repo: project.gitRepo,
      owner: project.gitOwner,
      projectName: project.name,
      framework: snapshot?.framework || project.framework,
      branch: dep.branch ?? project.gitBranch,
      publicEndpoints: routeState.publicEndpoints.map((endpoint) => ({
        id: endpoint.id,
        ...(endpoint.port !== undefined ? { port: String(endpoint.port) } : {}),
        ...(endpoint.targetPath ? { targetPath: endpoint.targetPath } : {}),
        domain: endpoint.domain || "",
        customDomain: endpoint.customDomain || "",
        domainType: endpoint.domainType || "free",
      })),
      buildCommand: snapshot?.buildCommand,
      outputDirectory: snapshot?.outputDirectory,
      installCommand: snapshot?.installCommand,
      startCommand: snapshot?.startCommand,
      rootDirectory: snapshot?.rootDirectory,
      hasServer: snapshot?.hasServer ?? !!snapshot?.startCommand?.trim(),
      serviceDeploymentMode: snapshot?.serviceDeploymentMode,
    },
    progress,
    currentStep,
    screenshots: [],
    buildDurationMs: buildSessionRow?.durationMs ?? null,
    buildStartedAt: buildSessionRow?.startedAt?.toISOString() ?? null,
    failureMessage: effectiveStatus === "failed" ? dep.errorMessage || "" : "",
    warningMessage:
      effectiveStatus === "ready" ? snapshot?.composeDeployment?.warningMessage || "" : "",
    previousActiveDeploymentId: snapshot?.previousActiveDeploymentId ?? null,
    errorCode:
      dep.errorMessage?.includes("PORT_IN_USE") || dep.errorMessage?.includes("EADDRINUSE")
        ? "PORT_IN_USE"
        : undefined,
    projectType,
    ...composeData,
  };
}

// ─── Cancel build session ────────────────────────────────────────────────────

export async function cancelBuildSession(deploymentId: string, userId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  if (!["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot cancel a deployment that is not in progress");
  }

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  // 1. Abort the running build process. Best-effort - if the build already
  //    finished or never started this is a no-op.
  const { runtime } = platform();
  if (dep.status === "building" && buildSession) {
    await runtime.cancelBuild(buildSession.id).catch(() => {});
  }

  // 2. Tear down whatever the deploy had already provisioned. The shared
  //    deployment manifest enumerates ALL containers (deployment + each
  //    service) and ALL images (deployment + each service's built image),
  //    deduplicated. Volumes are deliberately NOT cleaned - cancel !=
  //    delete, and the user may retry.
  const manifest = await collectDeploymentManifest(dep, project).catch(
    (): CleanupManifest => ({ projectId: dep.projectId, resources: [] }),
  );
  if (manifest.resources.length > 0) {
    await executeCleanup(manifest).catch((err) => {
      // Per-item failures are already isolated inside executeCleanup, so we
      // only land here on an unexpected crash. Log and continue - cancel
      // still has to mark the deployment cancelled, leak or no leak.
      console.error(`[CANCEL] Cleanup crashed for ${dep.id}:`, err);
    });
  }

  // 3. Surface service-level cancellation in the SSE stream so the UI stops
  //    showing per-service spinners.
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (snapshot?.serviceDeploymentMode !== "single") {
    const services = await repos.service.listByProject(dep.projectId).catch(() => []);
    for (const svc of services) {
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: "Deployment cancelled",
      });
    }
  }

  // 4. Persist the cancelled status + close the SSE stream.
  await repos.deployment.updateStatus(dep.id, "cancelled");
  if (buildSession) {
    await repos.deployment.finishBuildSession(buildSession.id, "cancelled", 0);
  }
  // Broadcast cancelled AFTER service statuses so UI receives the service updates first
  sessionManager.updateStatus(dep.id, "cancelled");

  return { success: true, message: "Deployment cancelled" };
}

// ─── Redeploy build session ─────────────────────────────────────────────────

export async function redeployBuildSession(
  deploymentId: string,
  userId: string,
  opts?: { useExistingCommit?: boolean },
) {
  const { dep: oldDep, project } = await loadDeployment(deploymentId);
  const resolvedBranch = await resolveProjectBranch(userId, project, oldDep.branch ?? undefined);

  // Prefer the old deployment's snapshot; fall back to a fresh one from the project
  const meta =
    (oldDep.meta as DeploymentConfigSnapshot | null) ??
    buildConfigSnapshot(project, resolvedBranch);
  const branch = meta.branch || resolvedBranch;

  // Two redeploy modes:
  //   default            — rebuild against the LATEST commit on the branch.
  //                        This is "redeploy this branch" semantics; what
  //                        the auto-redeploy hooks and the main deploy UI use.
  //   useExistingCommit  — rebuild against THE SAME commit the old deployment
  //                        used. The dashboard offers this as a fallback when
  //                        an old deployment's artifact has been purged from
  //                        the retention window — gives the user back that
  //                        specific code without a manual git+redeploy dance.
  const { commitSha, commitMessage } =
    opts?.useExistingCommit && oldDep.commitSha
      ? {
          commitSha: oldDep.commitSha,
          commitMessage: oldDep.commitMessage ?? `Redeploy ${oldDep.commitSha.slice(0, 7)}`,
        }
      : await resolveLatestCommitInfo(userId, project, branch);

  // ── Refresh compose services from current DB state ─────────────────────
  // The old snapshot's `composeServices` is frozen to whatever existed when
  // it was created. If the user added (or disabled) a service since then,
  // the redeploy must see the current shape - otherwise newly-added Postgres
  // / Redis / etc. rows would sit in the DB but never actually deploy.
  //
  // listProjectComposeServices returns BOTH kind="compose" AND
  // kind="monorepo" rows, so this refresh picks up newly-added sub-apps too
  // (e.g. a user adding `apps/admin` to a project that previously had only
  // `apps/web`).
  //
  // We deliberately don't touch `serviceDeploymentMode` - the downstream
  // pipeline gate (shouldUseProjectServicePipeline) re-queries the DB and
  // chooses the right mode regardless. Forcing it here would silently
  // override an explicit user choice on the original deployment.
  const currentComposeRows = await listProjectComposeServices(project.id).catch(() => []);
  const currentComposeServices = projectServicesToDeployableServices(
    currentComposeRows.filter((s) => s.enabled),
  );
  const refreshedMeta: DeploymentConfigSnapshot = {
    ...meta,
    composeServices: currentComposeServices.length > 0 ? currentComposeServices : undefined,
  };

  const dep = await createQueuedDeployment({
    projectId: project.id,
    userId,
    organizationId: project.organizationId ?? null,
    branch,
    commitSha,
    commitMessage,
    trigger: "redeploy",
    environment: oldDep.environment,
    framework: oldDep.framework || refreshedMeta.framework,
    meta: metaWithPrevious(refreshedMeta, project),
    envVars: oldDep.envVars as Record<string, string> | null,
  });

  // Kick off the actual build. Without this, the new deployment row would
  // sit in "queued" status forever - the main deploy UI worked around this
  // by following up with POST /:id/build, but the dashboard's auto-redeploy
  // call sites (ServicesTab, ServiceDetailPanel) don't, and end-users see
  // a stuck "Queued" pill. startBuild is idempotent (see its guard below),
  // so the main UI's follow-up POST is a no-op instead of an error.
  await kickoffBuild(project, dep);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Start build from session ID (direct - no token) ─────────────────────────

export async function startBuild(deploymentId: string, userId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  // Idempotent for already-running / completed deployments. redeploy now
  // auto-triggers the build, but the existing main-deploy UI still POSTs
  // /:id/build right after to attach its SSE stream - we want that POST to
  // succeed (so SSE attaches to the running session) instead of 400'ing.
  // Terminal states (ready/failed/cancelled) are also "do nothing, return ok".
  if (["building", "deploying", "ready", "failed", "cancelled"].includes(dep.status)) {
    return {
      success: true,
      deployment_id: dep.id,
      project_id: project.id,
      alreadyStarted: true as const,
    };
  }

  if (!["queued"].includes(dep.status)) {
    throw new ForbiddenError(`Build session is in an unexpected state: ${dep.status}`);
  }

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new NotFoundError("BuildSession for deployment", deploymentId);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Trigger deployment (internal build pipeline) ────────────────────────────

export async function triggerDeployment(
  userId: string,
  data: {
    projectId: string;
    branch?: string;
    commitSha?: string;
    commitMessage?: string;
    environment?: string;
    trigger?: string;
  },
) {
  const project = await repos.project.findById(data.projectId);
  if (!project) {
    throw new NotFoundError("Project", data.projectId);
  }
  // Org-membership verified at the route boundary. No userId equality
  // check here — that would block team members.

  if (!project.gitUrl && !project.localPath) {
    throw new ForbiddenError("Project has no git repository or local path configured");
  }

  const branch = await resolveProjectBranch(userId, project, data.branch);
  const environment = data.environment ?? "production";

  await checkNoActiveBuild(project.id);

  const snapshot = buildConfigSnapshot(project, branch);
  const routeState = await resolveProjectRouteState(project);

  // ── Preflight: validate config before creating any resources ────
  await runDeploymentPreflight(snapshot, routeState, {
    userId,
    gitOwner: project.gitOwner,
    projectId: project.id,
    organizationId: project.organizationId ?? undefined,
  });

  // Copy env vars from project (already encrypted in env_var table)
  const rawEnvMap = await repos.project.getEnvMap(project.id, environment);
  const encryptedEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;

  // ── Resolve commit info: fetch HEAD from GitHub if not provided ────
  let commitSha = data.commitSha;
  let commitMessage = data.commitMessage;
  if (!commitSha) {
    const head = await resolveLatestCommitInfo(userId, project, branch);
    commitSha = head.commitSha;
    commitMessage = commitMessage ?? head.commitMessage;
  }

  const dep = await createQueuedDeployment({
    projectId: project.id,
    userId,
    organizationId: project.organizationId ?? null,
    branch,
    commitSha,
    commitMessage,
    trigger: data.trigger ?? "manual",
    environment,
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptedEnvVars,
  });

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new Error("Build session was not created");

  return {
    deployment: dep,
  };
}

// ─── Build & Deploy pipeline (private) ───────────────────────────────────────

async function executeBuildAndDeploy(project: Project, dep: Deployment, buildSessionId: string) {
  const plat = platform();
  let { runtime, routing, ssl, system } = plat;

  // ── Read config snapshot early so we can resolve the runtime ──────
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (!snapshot) {
    throw new Error("Deployment has no config snapshot (meta is empty)");
  }
  const routeState = await resolveProjectRouteState(project);

  const logs: LogEntry[] = [];
  const MAX_LOG_ENTRIES = 50_000;

  const logCallback = (entry: LogEntry) => {
    if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
    sessionManager.appendLog(dep.id, entry);
  };

  // Single logger instance for the entire build→deploy lifecycle
  const logger = new BuildLogger(logCallback);

  /** Collapsed logs for DB persistence - resolves \r overwrites to final state. */
  const persistLogs = () => collapseTerminalLogs(logs);

  // ── Lifecycle context - shared across all phases ───────────────────
  const provisioned: { imageRef?: string } = {};
  const ctx: LifecycleContext = {
    runtime,
    project,
    dep,
    buildSessionId,
    persistLogs,
    provisioned,
  };

  try {
    // ── Resolve the full execution platform from deployment snapshot ──
    const resolved = await resolveDeploymentPlatform(snapshot, {
      organizationId: dep.organizationId,
      basePlatform: plat,
    });

    runtime = resolved.platform.runtime;
    routing = resolved.platform.routing;
    ssl = resolved.platform.ssl;
    system = resolved.platform.system;
    ctx.runtime = runtime;

    const usesManagedRouting = resolved.usesManagedRouting;
    const targetExecutor: CommandExecutor | null = resolved.platform.executor;

    // ── Build phase ──────────────────────────────────────────────────
    await repos.deployment.updateStatus(dep.id, "building");
    await repos.deployment.updateBuildSession(buildSessionId, {
      status: "building",
      startedAt: new Date(),
    });
    sessionManager.updateStatus(dep.id, "building");

    const prodResources = withDefaults(snapshot.resources);
    const buildResources = withDefaults(snapshot.buildResources, DEFAULT_BUILD_RESOURCE_CONFIG);

    // Decrypt env vars from deployment (self-contained). decryptEnvMap
    // drops keys that fail decryption rather than leaking ciphertext into
    // the build environment.
    const envMap = decryptEnvMap(
      (dep.envVars ?? {}) as Record<string, string>,
      (key: string, err: unknown) =>
        console.warn(
          `[build] failed to decrypt env var ${key}: ${err instanceof Error ? err.message : err}`,
        ),
    );
    const isLocalBuild = snapshot.buildStrategy === "local";
    const buildEnv = buildScopedEnvVars(envMap, {
      forceProductionNodeEnv: isLocalBuild,
    });

    if (isLocalBuild && buildEnv.ignoredNodeEnv && buildEnv.ignoredNodeEnv !== "production") {
      logger.log(
        `Ignoring deployment NODE_ENV=${buildEnv.ignoredNodeEnv} during local build and forcing NODE_ENV=production.`,
        "warn",
      );
    }

    // Resolve a fresh GitHub token for cloning private repos.
    // Policy lives in resolveBuildGitToken - local builds keep the broad
    // resolver chain (token never leaves the API); remote builds in App
    // mode are installation-only; remote builds in non-App modes still
    // ship the user's token but the preflight check warns first.
    //
    // Org scoping: pass the project's organizationId so the App installation
    // lookup uses (organizationId, owner). The resolver falls back to the
    // per-user installation row when the org has none, but the org path is
    // the canonical one for multi-user deploys.
    // Pick any org member to attribute the GitHub token lookup to.
    // The org-scoped App installation lookup in tokenFor doesn't require a
    // specific user, but the per-user PAT fallback does — so we forward the
    // first member as the "actor" for that path.
    const orgMembers = await repos.member
      .listByOrganization(dep.organizationId)
      .catch(() => [] as Array<{ userId: string }>);
    const actorUserId = orgMembers[0]?.userId ?? "";
    const gitToken = await resolveBuildGitToken({
      userId: actorUserId,
      projectId: project.id,
      owner: project.gitOwner ?? undefined,
      buildStrategy: snapshot.buildStrategy ?? "server",
      organizationId: dep.organizationId,
    });

    // Monorepo sub-app rows (kind="monorepo") fan out through the standard
    // compose pipeline below - each gets its own image, container, and
    // route. Per-app build/start commands live on the service row; no
    // project-row mirroring needed and no snapshot mutation here.

    const buildConfig = createBuildConfig({
      project,
      dep,
      snapshot,
      sessionId: buildSessionId,
      envVars: buildEnv.envVars,
      resources: buildResources,
      gitToken: gitToken ?? undefined,
    });

    const useServicePipeline = (await resolveServicePipelineMode(project, snapshot)).useServicePipeline;

    if (useServicePipeline && isMultiServiceRuntime(runtime)) {
      // snapshot.composeServices is a DeployableService[] - mixed compose +
      // monorepo. syncFromCompose strictly owns compose rows; passing a
      // monorepo entry in causes a ghost compose-kind row to be inserted
      // alongside the real monorepo row (no DB unique constraint on
      // (projectId, name)). Filter to compose-kind before handing it off.
      const composeOnly = snapshot.composeServices?.filter(
        (s) => serviceKind(s) === "compose",
      );
      if (composeOnly?.length) {
        await repos.service.syncFromCompose(project.id, composeOnly);
      }

      await executeComposePipeline({
        project,
        dep,
        runtime,
        routing,
        ssl,
        usesManagedRouting,
        logger,
        ctx,
        snapshot,
        buildSessionId,
        buildEnvVars: buildEnv.envVars,
        buildResources,
        runtimeResources: prodResources,
        gitToken: gitToken ?? undefined,
      });
      return;
    }

    if (useServicePipeline) {
      const msg = `Project services are not supported on the "${runtime.name}" runtime yet. Use Docker runtime or deploy as a single app.`;
      logger.log(msg, "error");
      await onFailure(ctx, msg);
      return;
    }

    if (!snapshot.hasBuild) {
      logger.step(
        "build",
        "completed",
        "Build disabled - skipping install & build, using source directly",
      );
    }

    const buildResult = await runtime.build(buildConfig, logger);
    provisioned.imageRef = buildResult.imageRef;

    if (buildResult.status === "cancelled") {
      await onCancelled(ctx, buildResult.durationMs);
      return;
    }

    if (buildResult.status === "failed") {
      await onFailure(ctx, buildResult.errorMessage ?? "Build failed", buildResult.durationMs);
      return;
    }

    // Guard: build must produce an imageRef to proceed to deploy
    if (buildResult.status !== "deploying" || !buildResult.imageRef) {
      const msg = "Build completed but did not produce a deployable artifact";
      logger.step("build", "failed", msg);
      await onFailure(ctx, msg, buildResult.durationMs);
      return;
    }

    // ── Deploy phase ─────────────────────────────────────────────────
    await repos.deployment.updateStatus(dep.id, "deploying", {
      imageRef: buildResult.imageRef,
      buildDurationMs: buildResult.durationMs,
    });
    sessionManager.updateStatus(dep.id, "deploying");

    const phase: DeployPhaseInputs = {
      ctx,
      project,
      dep,
      snapshot: snapshot,
      buildSessionId,
      runtime,
      routing,
      ssl,
      system,
      targetExecutor,
      usesManagedRouting,
      routeState,
      buildResult,
      envMap,
      prodResources,
      logger,
    };

    if (!snapshot.hasServer && runtime instanceof CloudRuntime) {
      await executeStaticEdgeDeploy(phase, runtime);
    } else {
      await executeServerDeploy(phase);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.log(`Error: ${message}`, "error");
    await onFailure(ctx, message);
  }
}

// ─── Deploy phases ───────────────────────────────────────────────────────────

interface DeployPhaseInputs {
  ctx: LifecycleContext;
  project: Project;
  dep: Deployment;
  snapshot: DeploymentConfigSnapshot;
  buildSessionId: string;
  runtime: Awaited<ReturnType<typeof platform>>["runtime"];
  routing: Awaited<ReturnType<typeof platform>>["routing"];
  ssl: Awaited<ReturnType<typeof platform>>["ssl"];
  system: Awaited<ReturnType<typeof platform>>["system"];
  targetExecutor: CommandExecutor | null;
  usesManagedRouting: boolean;
  routeState: Awaited<ReturnType<typeof resolveProjectRouteState>>;
  buildResult: BuildResult;
  envMap: Record<string, string>;
  prodResources: ResourceConfig;
  logger: BuildLogger;
}

/** Static edge deploy via CloudRuntime (Oblien Pages). */
async function executeStaticEdgeDeploy(
  phase: DeployPhaseInputs,
  runtime: CloudRuntime,
): Promise<void> {
  const { ctx, project, dep, snapshot, buildSessionId, routeState, buildResult, envMap, prodResources, logger } = phase;

  logger.step("deploy", "running", "Deploying to edge (static)...");

  const staticResult = await runtime.deployStatic({
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId,
    imageRef: buildResult.imageRef!,
    environment: dep.environment,
    port: snapshot.port,
    startCommand: snapshot.startCommand,
    stack: snapshot.framework,
    envVars: envMap,
    resources: prodResources,
    restartPolicy: "no",
    runtimeName: project.slug ?? project.id,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: resolveStaticOutputDirectory(
      snapshot.outputDirectory,
      routeState.publicEndpoints[0]?.targetPath,
    ),
    projectName: project.name,
  });

  if (staticResult.status === "failed" || !staticResult.containerId) {
    logger.step("deploy", "failed", "Static deploy failed");
    await onFailure(ctx, "Failed to deploy static site to edge", buildResult.durationMs);
    return;
  }

  logger.step("deploy", "completed", "Deployed to edge successfully");

  await onSuccess(ctx, {
    containerId: staticResult.containerId,
    url: staticResult.url,
    durationMs: buildResult.durationMs ?? 0,
  });
}

/** Server deploy via runDeployPipeline (VM / Docker / Bare). Handles static-self-hosted too. */
async function executeServerDeploy(phase: DeployPhaseInputs): Promise<void> {
  const {
    ctx, project, dep, snapshot, buildSessionId,
    runtime, routing, ssl, system, targetExecutor, usesManagedRouting,
    routeState, buildResult, envMap, prodResources, logger,
  } = phase;

  // Static sites are always served directly from the web server (OpenResty)
  // via file-backed routes - Docker is only for server apps.
  const staticBareRuntime =
    !snapshot.hasServer && runtime instanceof BareRuntime ? runtime : null;
  const isStaticSelfHosted = staticBareRuntime !== null;

  const deployConfig: DeployConfig = {
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId,
    imageRef: buildResult.imageRef!,
    environment: dep.environment,
    port: snapshot.port,
    startCommand: snapshot.startCommand,
    stack: snapshot.framework,
    envVars: envMap,
    resources: prodResources,
    restartPolicy: isStaticSelfHosted ? "no" : "always",
    runtimeName: project.slug ?? project.id,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: snapshot.outputDirectory,
    productionPaths: snapshot.productionPaths.length ? snapshot.productionPaths : undefined,
    // Bare uses this to hard-link identical files across releases.
    // Other runtimes ignore it.
    previousDeploymentId: project.activeDeploymentId ?? undefined,
  };

  // Resolve the previous deployment + its runtime so we can deactivate it cleanly.
  const prevDep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  const previousRuntime = prevDep?.containerId
    ? await resolveDeploymentRuntime(prevDep)
        .then((r) => r.runtime)
        .catch(() => runtime)
    : runtime;

  // ── Gather all domains that need routing ───────────────────────────
  // Sources: custom domain, verified DB domains, free host subdomain.
  // Every domain gets an OpenResty route; SSL is provisioned only for
  // custom domains - the free host subdomain skips SSL (user manages it).
  const projectDomains = await repos.domain.listByProject(project.id);
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );
  const plannedDomains = buildProjectRouteDomains({
    project,
    projectDomains,
    customDomain: routeState.primaryCustomDomain,
    managedSlug: routeState.publicEndpoints.length > 0 ? routeState.primarySlug : undefined,
    publicEndpoints: routeState.publicEndpoints,
    runtimeName: runtime.name,
    usesManagedRouting,
  });
  const activeRouteIds = new Set(
    routeState.publicEndpoints
      .map((endpoint) => endpoint.id)
      .filter((id): id is string => !!id),
  );
  const obsoleteProjectDomains = activeRouteIds.size > 0
    ? projectDomains.filter((domain) => !domain.serviceId && !activeRouteIds.has(domain.id))
    : [];

  // Persist domain records for any new planned domains (free subdomain, custom domain)
  for (const route of plannedDomains) {
    const created = await ensureRouteDomainRecord({
      projectId: project.id,
      route,
      domainByHostname,
    });
    if (created && !projectDomains.some((d) => d.id === created.id)) {
      logger.log(`Created domain record for "${route.hostname}".\n`);
    }
  }

  // Compose deploy environment from runtime adapter
  const deployEnv: DeployEnvironment = {
    preflight: targetExecutor
      ? async (cfg, promptUser) => {
          if (system) {
            const systemLog = (entry: { message: string; level: "info" | "warn" | "error" }) => {
              logger.log(`${entry.message}\n`, entry.level);
            };

            if (!isStaticSelfHosted) {
              await system.ensureFeature("deploy", systemLog);
            }
            if (plannedDomains.length > 0) {
              await system.ensureFeature("routing", systemLog);
            }
            if (plannedDomains.some((d) => d.provisionSsl)) {
              await system.ensureFeature("ssl", systemLog);
            }
          }

          if (!isStaticSelfHosted) {
            const ports = Array.from(
              new Set(
                (routeState.publicEndpoints.length > 0
                  ? routeState.publicEndpoints
                  : [{ port: cfg.port }])
                  .map((endpoint) => endpoint.port ?? cfg.port)
                  .filter((port): port is number => Number.isFinite(port)),
              ),
            );

            for (const port of ports) {
              await ensurePortAvailable(targetExecutor, port, logger, promptUser);
            }
          }
        }
      : undefined,
    activate: async (cfg, onLog) => {
      const r = isStaticSelfHosted
        ? await staticBareRuntime.deployStatic({
            ...cfg,
            outputDirectory: cfg.outputDirectory ?? snapshot.outputDirectory,
          })
        : await runtime.deploy(cfg, onLog);
      if (!r.containerId) throw new Error("Deploy produced no container");
      return { containerId: r.containerId, url: r.url };
    },
    deactivate: (id) =>
      previousRuntime.name === "bare" && !id.includes("/")
        ? previousRuntime.stop(id)
        : previousRuntime.destroy(id),
    resolveRoute: isStaticSelfHosted
      ? async (id, cfg) => ({
          staticRoot: staticBareRuntime.resolveStaticRoot(
            id,
            cfg.outputDirectory ?? snapshot.outputDirectory,
          ),
        })
      : undefined,
    resolveTargetUrl: runtime.supports("containerIp")
      ? async (id, port) => {
          const ip = await runtime.getContainerIp(id);
          return ip ? `http://${ip}:${port}` : null;
        }
      : undefined,
  };

  const deploySsl = plannedDomains.some((domain) => domain.provisionSsl)
    ? createTrackedSslProvider(ssl, domainByHostname)
    : ssl;

  // Pre-deploy backups — fire BEFORE runDeployPipeline so the snapshot
  // captures the OLD container's state before runtime.destroy() in
  // compose/deploy.service.ts wipes it. Best-effort: we await only the
  // enqueue (so we know the run is durably queued before destruction),
  // not the run itself — a failing or slow backup must not block the
  // deploy. firePreDeployBackups returns { enqueued, failed } and
  // logs internally; we surface the count to the build log.
  try {
    const { firePreDeployBackups } = await import(
      "../backups/triggers/pre-deploy"
    );
    const preBackup = await firePreDeployBackups({
      projectId: project.id,
      organizationId: dep.organizationId,
    });
    if (preBackup.enqueued > 0 || preBackup.failed > 0) {
      logger.log(
        `[pre-deploy-backup] enqueued=${preBackup.enqueued} failed=${preBackup.failed}`,
      );
    }
  } catch (err) {
    logger.log(
      `[pre-deploy-backup] trigger crashed (ignoring, best-effort): ${
        safeErrorMessage(err)
      }`,
    );
  }

  const deployResult = await runDeployPipeline(
    deployEnv,
    {
      config: deployConfig,
      previousContainerId: prevDep?.containerId ?? undefined,
      domains: toRoutedDomainInputs(plannedDomains),
      routing,
      ssl: deploySsl,
      routeOptions: project.webhookDomain
        ? {
            webhookDomain: project.webhookDomain,
            webhookProxy: `${internalApiUrl}/api/webhooks/`,
          }
        : undefined,
      promptUser: (prompt) => sessionManager.promptUser(dep.id, prompt),
    },
    logger,
  );

  if (deployResult.status === "failed") {
    await onFailure(ctx, deployResult.error, buildResult.durationMs, {
      errorCode: deployResult.errorCode,
      errorDetails: deployResult.errorDetails,
    });
    return;
  }

  await runPostDeploySync({
    plannedDomains,
    obsoleteProjectDomains,
    routing,
    usesManagedRouting,
    organizationId: dep.organizationId,
    serverId: snapshot.serverId,
    // prevDep is intentionally NOT passed to runPostDeploySync anymore —
    // the RollbackOrchestrator below owns prev-artifact lifecycle now.
    // Keeping runPostDeploySync for managed-routing + obsolete-domain
    // cleanup only.
    logger,
  });

  await onSuccess(ctx, {
    containerId: deployResult.containerId!,
    url: deployResult.url,
    durationMs: buildResult.durationMs ?? 0,
  });

  // Hand the previous-active deployment over to the rollback orchestrator.
  // It archives the artifact (preserves rollback eligibility), sets
  // artifact_retained_at on both prev + new, and runs retention prune.
  const { onDeploymentReady } = await import("./rollback");
  const finalDep = await repos.deployment.findById(dep.id);
  if (finalDep) {
    await onDeploymentReady({
      newDeployment: finalDep,
      previousActive: prevDep ?? null,
    });
  }
}

/** After a successful deploy: managed-edge sync + prune obsolete
 *  domains/routes. Previous-deployment artifact lifecycle has moved
 *  to the RollbackOrchestrator (rollback/rollback-orchestrator.ts). */
async function runPostDeploySync(opts: {
  plannedDomains: ReturnType<typeof buildProjectRouteDomains>;
  obsoleteProjectDomains: Domain[];
  routing: Awaited<ReturnType<typeof platform>>["routing"];
  usesManagedRouting: boolean;
  organizationId: string;
  serverId?: string;
  logger: BuildLogger;
}): Promise<void> {
  const {
    plannedDomains, obsoleteProjectDomains, routing, usesManagedRouting,
    organizationId, serverId, logger,
  } = opts;

  if (usesManagedRouting) {
    for (const domain of plannedDomains.filter((d) => d.isCloud && d.managedSubdomain)) {
      logger.log(`Syncing managed edge proxy for ${domain.hostname}...\n`);
      await ensureManagedEdgeProxy(organizationId, domain.managedSubdomain!, { serverId });
    }
  }

  for (const domain of obsoleteProjectDomains) {
    if (routing) {
      await routing.removeRoute(domain.hostname).catch((err) => {
        const message = safeErrorMessage(err);
        logger.log(`Warning: failed to remove stale route ${domain.hostname}: ${message}\n`, "warn");
      });
    }

    await repos.domain.remove(domain.id).catch((err) => {
      const message = safeErrorMessage(err);
      logger.log(`Warning: failed to remove stale domain record ${domain.hostname}: ${message}\n`, "warn");
    });
  }

  // Previous-image GC moved to the RollbackOrchestrator. It archives
  // the prev image (not destroys it) so rollback stays possible, and
  // prunes beyond rollbackWindow + skips pinned.
}
