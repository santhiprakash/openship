/**
 * Cloud runtime - delegates build/deploy to Oblien cloud infrastructure.
 *
 * Strategy: single workspace per deployment.
 *   1. Build: create temp workspace (high resources) → shared pipeline (clone → install → build)
 *   2. Deploy: makePermanent → resize down → create workload → expose port
 *   3. Redeploy: new workspace, build, swap routing, delete old
 */

import { Oblien } from "oblien";
import type { WorkspaceHandle } from "oblien";
import type { ExecStreamEvent } from "oblien";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  DEFAULT_RESOURCE_CONFIG,
  type BuildConfig,
  type DeployConfig,
  type BuildResult,
  type DeploymentResult,
  type LogEntry,
  type LogCallback,
  type CommandExecutor,
  type ContainerInfo,
  type ResourceUsage,
  type ContainerStatus,
  type ResourceConfig,
} from "../types";

import {
  compileDockerfileToWorkspacePlan,
  type WorkspaceBuildPlan,
  type WorkspaceBuildStagePlan,
  type WorkspaceCopyStep,
  type WorkspaceRuntimePlan,
  type WorkspaceRunStep,
} from "../dockerfile";

import type {
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  MultiServiceGroupHandle,
  MultiServiceRuntimeAdapter,
  RuntimeCapability,
} from "./types";
import {
  BuildLogger,
  injectGitToken,
  runBuildPipeline,
  sq,
  type BuildEnvironment,
} from "./build-pipeline";
import { CloudComposeSupport, type CloudBuiltArtifact } from "./cloud/compose";
import { createDockerBuildContext } from "./docker-build-context";
import { normalizeDockerRelativePath, resolveDockerfileCandidates } from "./docker-paths";
import { runLocalBuild } from "./local-build";
import { transferLocalDirectory } from "./transfer";
import { checkGit } from "../system/checks";
import { installGit } from "../system/installer";
import { STACKS, TRANSFER_EXCLUDES, type StackId, type StackDefinition } from "@repo/core";

type CloudWorkspaceRuntime = Awaited<ReturnType<WorkspaceHandle["runtime"]>>;
const DOCKERFILE_SOURCE_IMAGE = "node:22";
const WORKSPACE_STREAM_EXEC_TIMEOUT_MS = 15 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function applyTail(entries: LogEntry[], tail?: number): LogEntry[] {
  if (typeof tail !== "number") return entries;
  if (tail <= 0) return [];
  return entries.slice(-tail);
}

function summarizeCommandOutput(output: string): string {
  const lines = output
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? "";
  return lastLine.length > 300 ? `${lastLine.slice(0, 297)}...` : lastLine;
}

function exposeTarget(port: number, slug?: string, domain = "opsh.io") {
  return slug ? `port ${port} for slug "${slug}" (${slug}.${domain})` : `port ${port}`;
}

type DeployPrimaryEndpoint = NonNullable<DeployConfig["publicEndpoints"]>[number];

/**
 * Admin-scoped Oblien operations CloudRuntime needs but a namespace
 * token can't perform. Provided by the API layer when this runtime is
 * constructed for a local/desktop instance — the implementation
 * forwards each call to the SaaS, which performs it with master creds.
 *
 * Today this is just `createPage` (Oblien Pages on shared `.opsh.io`).
 * Add new fields here when more admin-scoped paths need proxying.
 */
export interface CloudAdminProxy {
  createPage: (input: {
    workspace_id: string;
    path: string;
    name: string;
    slug: string;
    domain?: string;
  }) => Promise<{ page: { slug: string; url?: string | null } }>;
}

function primaryPublicEndpoint(config: Pick<DeployConfig, "publicEndpoints">): DeployPrimaryEndpoint | undefined {
  return config.publicEndpoints?.[0];
}

function endpointSlug(endpoint?: DeployPrimaryEndpoint): string | undefined {
  const slug = endpoint?.domain?.trim();
  return endpoint?.domainType === "free" && slug ? slug : undefined;
}

function endpointCustomDomain(endpoint?: DeployPrimaryEndpoint): string | undefined {
  const domain = endpoint?.customDomain?.trim();
  return endpoint?.domainType === "custom" && domain ? domain : undefined;
}

function fallbackRuntimeName(config: Pick<DeployConfig, "runtimeName" | "projectId" | "deploymentId">): string {
  const raw = config.runtimeName ?? `${config.projectId.slice(0, 20)}-${config.deploymentId.slice(0, 8)}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return normalized || `deploy-${config.deploymentId.slice(0, 8)}`;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function toEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function validEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function envExportPrefix(env: Record<string, string | null | undefined>): string {
  const parts = Object.entries(env)
    .filter(([key]) => validEnvKey(key))
    .map(([key, value]) => `export ${key}=${sq(value ?? "")}`);

  return parts.length ? `${parts.join(" && ")} && ` : "";
}

function joinWorkspacePath(base: string, ...parts: string[]): string {
  return posix.normalize(posix.join(base, ...parts.filter(Boolean)));
}

function resolveVmPath(workdir: string, target: string): string {
  if (!target || target === ".") return workdir || "/";
  if (target.startsWith("/")) return posix.normalize(target);
  return posix.normalize(posix.join(workdir || "/", target));
}

function hasGlob(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function sourceExpression(baseDir: string, source: string): string {
  const normalized = source === "." ? "." : source.replace(/^\/+/, "");
  const full = normalized === "." ? `${baseDir}/.` : `${baseDir}/${normalized}`;

  if (hasGlob(normalized)) {
    if (!/^[A-Za-z0-9_@%+=:,./*?[\]-]+$/.test(normalized)) {
      throw new Error(`Unsafe glob source in Dockerfile COPY: ${source}`);
    }
    return full;
  }

  return sq(full);
}

function dockerCopyShellCommands(opts: {
  sources: string[];
  destination: string;
  destinationIsDir: boolean;
  destinationTarget: string;
}): string[] {
  const { sources, destination, destinationIsDir, destinationTarget } = opts;
  const destinationExpr = sq(destination);
  const destinationTargetExpr = sq(destinationTarget);

  return sources.flatMap((source) => [
    `for src in ${source}; do`,
    '  if [ ! -e "$src" ]; then',
    '    echo "COPY source not found: $src" >&2',
    "    exit 1",
    "  fi",
    '  if [ -d "$src" ]; then',
    destinationIsDir
      ? `    mkdir -p ${destinationExpr}`
      : `    rm -rf ${destinationExpr} && mkdir -p ${destinationExpr}`,
    // Docker COPY copies directory contents, not the directory wrapper.
    `    cp -a "$src/." ${destinationExpr}/`,
    "  else",
    `    mkdir -p ${destinationTargetExpr}`,
    `    cp -a "$src" ${destinationExpr}`,
    "  fi",
    "done",
  ]);
}

function stageArtifactDownloadPath(source: string): string {
  const normalized = source.trim();
  if (!normalized || normalized === ".") {
    return "/";
  }
  if (normalized.startsWith("/")) {
    return posix.normalize(normalized);
  }
  return posix.normalize(`/${normalized}`);
}

function substituteDockerArgs(value: string, args: Record<string, string | null>): string {
  return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, key: string) => {
    const replacement = args[key];
    return replacement === undefined || replacement === null ? match : replacement;
  });
}

function stageBaseLabel(
  stageBaseImage: string,
  requestedBaseImage: string,
  stageAlias?: string,
): string {
  if (stageAlias) {
    return `${requestedBaseImage} (stage alias -> ${stageBaseImage})`;
  }
  return stageBaseImage === requestedBaseImage
    ? requestedBaseImage
    : `${requestedBaseImage} (resolved to ${stageBaseImage})`;
}

function resolveCopyDestinationPath(
  copy: WorkspaceCopyStep,
  sourcePath: string,
  destination: string,
  destinationIsDir: boolean,
): string {
  if (!destinationIsDir) {
    return destination;
  }

  const basename = posix.basename(sourcePath.replace(/\/+$/g, "")) || ".";
  return posix.normalize(posix.join(destination, basename));
}

type DockerfileBuildSource =
  | {
      kind: "local";
      contextRoot: string;
      dockerfile: string;
      cleanup(): Promise<void>;
    }
  | {
      kind: "remote";
      contextRelativePath: string;
      dockerfile: string;
      cleanup(): Promise<void>;
    };

// ─── CloudRuntime ────────────────────────────────────────────────────────────

export class CloudRuntime implements MultiServiceRuntimeAdapter {
  readonly name = "cloud";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "deploy",
    "multiServiceDeploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "streamLogs",
    "usage",
    "containerIp",
  ]);

  private readonly client: Oblien;
  // Optional admin-scoped proxy. Set when this runtime is constructed
  // by a local/desktop instance whose `client` is a namespace token —
  // admin-scoped operations (e.g. creating pages on shared `.opsh.io`)
  // get handed off to the SaaS through this callback. SaaS instances
  // construct CloudRuntime with master creds and leave it null;
  // `this.client` already has the needed scope there.
  private readonly adminProxy?: CloudAdminProxy;
  private readonly builtArtifacts = new Map<string, CloudBuiltArtifact>();
  private readonly activeBuilds = new Map<string, {
    abort: AbortController;
    workspaceIds: Set<string>;
  }>();
  private readonly compose: CloudComposeSupport;

  constructor(client: Oblien, opts?: { adminProxy?: CloudAdminProxy }) {
    this.client = client;
    this.adminProxy = opts?.adminProxy;
    this.compose = new CloudComposeSupport({
      client,
      builtArtifacts: this.builtArtifacts,
      workspace: (workspaceId) => this.ws(workspaceId),
      provisionWorkspace: (config, logger) => this.provisionWorkspace(config, logger),
      execAndStream: (runtime, command, onLog, timeoutSeconds) =>
        this.execAndStream(runtime, command, onLog, timeoutSeconds),
    });
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // No persistent connections to clean up
  }

  /** Get a scoped workspace handle. */
  private ws(workspaceId: string): WorkspaceHandle {
    return this.client.workspace(workspaceId);
  }

  private createActiveBuild(sessionId: string) {
    const activeBuild = {
      abort: new AbortController(),
      workspaceIds: new Set<string>(),
    };
    this.activeBuilds.set(sessionId, activeBuild);
    return activeBuild;
  }

  private trackActiveBuildWorkspace(sessionId: string, workspaceId: string): void {
    this.activeBuilds.get(sessionId)?.workspaceIds.add(workspaceId);
  }

  private untrackActiveBuildWorkspace(sessionId: string, workspaceId: string): void {
    this.activeBuilds.get(sessionId)?.workspaceIds.delete(workspaceId);
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();
    const activeBuild = this.createActiveBuild(config.sessionId);

    try {
      if (config.stack === "docker" || config.dockerfilePath) {
        const result = await this.buildDockerfileWorkspace(config, log);
        return activeBuild.abort.signal.aborted
          ? { ...result, status: "cancelled", errorMessage: undefined }
          : result;
      }

      // "local" = build on the API host, then upload output to cloud workspace.
      // "server" (default) = build inside the cloud workspace.
      const buildLocally = config.buildStrategy === "local";

      // 1. Provision workspace + acquire runtime token (logs to terminal)
      let wsId: string;
      let rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>>;
      try {
        const provisioned = await this.provisionBuildWorkspace(config, log);
        wsId = provisioned.workspaceId;
        rt = provisioned.runtime;
        this.trackActiveBuildWorkspace(config.sessionId, wsId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.log(`Failed to provision build environment: ${msg}`, "error");
        return {
          sessionId: config.sessionId,
          status: activeBuild.abort.signal.aborted ? "cancelled" : "failed",
          durationMs: 0,
          errorMessage: activeBuild.abort.signal.aborted
            ? undefined
            : `Failed to provision build environment: ${msg}`,
        };
      }

      if (buildLocally) {
        log.log("Build strategy: local (build on API host, upload to cloud)\n");
        const stackDef: StackDefinition | undefined = STACKS[config.stack as StackId];

        let result: Awaited<ReturnType<typeof runLocalBuild>>;
        try {
          result = await runLocalBuild({
            config,
            logger: log,
            abort: activeBuild.abort.signal,
            transferOutput: async (buildDir) => {
              if (activeBuild.abort.signal.aborted) {
                throw new Error("Build cancelled");
              }

              if (stackDef?.productionPaths?.length) {
                // Compiled stacks - transfer only production artifacts
                log.log(`Transferring production paths: ${stackDef.productionPaths.join(", ")}\n`);
                await transferLocalDirectory(
                  buildDir,
                  { kind: "cloud-runtime", runtime: rt, path: "/app" },
                  log,
                  { includes: [...stackDef.productionPaths] },
                );
              } else {
                // Runtime stacks - transfer everything except deps & caches
                const excludes = [...TRANSFER_EXCLUDES, ...(stackDef?.cacheDirs ?? [])];
                await transferLocalDirectory(
                  buildDir,
                  { kind: "cloud-runtime", runtime: rt, path: "/app" },
                  log,
                  { excludes },
                );
              }

              if (activeBuild.abort.signal.aborted) {
                throw new Error("Build cancelled");
              }

              // Install production dependencies with correct platform binaries
              const installCmd = config.installCommand?.trim();
              if (installCmd) {
                log.log("Installing production dependencies on cloud...\n");
                await this.execAndStream(rt, ["sh", "-c", `cd /app && ${installCmd}`], log.callback);
              }
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.log(`Failed to upload local build output: ${msg}`, "error");
          return {
            sessionId: config.sessionId,
            status: activeBuild.abort.signal.aborted ? "cancelled" : "failed",
            imageRef: wsId,
            errorMessage: activeBuild.abort.signal.aborted
              ? undefined
              : `Failed to upload local build output: ${msg}`,
          };
        }

        return {
          sessionId: config.sessionId,
          status: activeBuild.abort.signal.aborted ? "cancelled" : result.status,
          imageRef: wsId,
          durationMs: result.durationMs,
          errorMessage: activeBuild.abort.signal.aborted ? undefined : result.errorMessage,
        };
      }

      // ── Server build: exec delegates to cloud runtime API ──
      log.log("Build strategy: server (build in cloud workspace)\n");

      const buildEnv: BuildEnvironment = {
        projectDir: "/app",
        hasNativeEnv: true,
        exec: async (command, logCb) => {
          if (activeBuild.abort.signal.aborted) {
            throw new Error("Build cancelled");
          }
          await this.execAndStream(rt, ["sh", "-c", command], logCb);
          if (activeBuild.abort.signal.aborted) {
            throw new Error("Build cancelled");
          }
        },
        preflight: async (cfg, plog) => {
          if (activeBuild.abort.signal.aborted) {
            throw new Error("Build cancelled");
          }

          if (!cfg.localPath) {
            await this.ensureWorkspaceGit(rt, plog, "build workspace");
            return;
          }
          await transferLocalDirectory(
            cfg.localPath,
            {
              kind: "cloud-runtime",
              runtime: rt,
              path: "/app",
            },
            plog,
          );
        },
      };

      // 3. Run shared build pipeline (clone → install → build)
      const result = await runBuildPipeline(buildEnv, config, log);

      return {
        sessionId: config.sessionId,
        status: activeBuild.abort.signal.aborted ? "cancelled" : result.status,
        imageRef: wsId,
        durationMs: result.durationMs,
        errorMessage: activeBuild.abort.signal.aborted ? undefined : result.errorMessage,
      };
    } finally {
      this.activeBuilds.delete(config.sessionId);
    }
  }

  private async buildDockerfileWorkspace(
    config: BuildConfig,
    log: BuildLogger,
  ): Promise<BuildResult> {
    const startedAt = Date.now();
    const createdWorkspaceIds: string[] = [];
    let finalWorkspaceId: string | undefined;
    let source: DockerfileBuildSource | undefined;

    try {
      log.log("Build strategy: Dockerfile plan (build in Oblien workspaces)\n");
      source = await this.resolveDockerfileBuildSource(config, log);
      const plan = compileDockerfileToWorkspacePlan(source.dockerfile);

      const blocking = plan.diagnostics.filter(
        (item) => item.severity === "error" || item.severity === "unsupported",
      );
      if (blocking.length > 0) {
        throw new Error(
          blocking
            .map((item) => (item.line ? `line ${item.line}: ${item.message}` : item.message))
            .join("\n"),
        );
      }

      if (plan.stages.length === 0 || !plan.finalStage || !plan.runtime) {
        throw new Error("Dockerfile did not produce a deployable final stage.");
      }

      const unsafe = this.getUnsupportedDockerfilePlanFeatures(plan);
      if (unsafe.length > 0) {
        throw new Error(unsafe.join("\n"));
      }

      for (const warning of plan.diagnostics.filter((item) => item.severity === "warning")) {
        log.log(
          `${warning.line ? `Dockerfile line ${warning.line}: ` : ""}${warning.message}\n`,
          "warn",
        );
      }

      const built = await this.executeDockerfilePlan({
        config,
        plan,
        source,
        logger: log,
        onWorkspaceCreated: (workspaceId) => {
          createdWorkspaceIds.push(workspaceId);
          this.trackActiveBuildWorkspace(config.sessionId, workspaceId);
        },
      });

      finalWorkspaceId = built.workspaceId;
      this.builtArtifacts.set(built.workspaceId, {
        workspaceId: built.workspaceId,
        runtime: built.runtime,
      });
      log.log(
        `Dockerfile runtime plan: workdir ${built.runtime.workdir}${
          built.runtime.exposedPort ? ` · port ${built.runtime.exposedPort}` : " · no EXPOSE port"
        }${built.runtime.startCommand ? ` · start ${built.runtime.startCommand}` : " · no start command"}\n`,
      );

      return {
        sessionId: config.sessionId,
        status: "deploying",
        imageRef: built.workspaceId,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      for (const workspaceId of createdWorkspaceIds) {
        if (workspaceId === finalWorkspaceId) continue;
        await this.ws(workspaceId)
          .delete()
          .catch(() => {});
        this.untrackActiveBuildWorkspace(config.sessionId, workspaceId);
      }

      const message = err instanceof Error ? err.message : String(err);
      log.log(`Dockerfile build failed: ${message}\n`, "error");
      return {
        sessionId: config.sessionId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorMessage: message,
      };
    } finally {
      await source?.cleanup().catch(() => {});
    }
  }

  private async resolveDockerfileBuildSource(
    config: BuildConfig,
    logger: BuildLogger,
  ): Promise<DockerfileBuildSource> {
    if (config.dockerfileContent?.trim()) {
      logger.log("Using Dockerfile content from source metadata.\n");
      return {
        kind: "remote",
        contextRelativePath: normalizeDockerRelativePath(config.rootDirectory),
        dockerfile: config.dockerfileContent,
        cleanup: async () => {},
      };
    }

    if (!config.localPath) {
      return this.resolveRemoteDockerfileBuildSource(config, logger);
    }

    logger.log("Preparing local Dockerfile source...\n");
    const context = await createDockerBuildContext(config, { requireRepositoryDockerfile: true });
    const dockerfilePath = join(context.contextDir, ...context.dockerfileName.split("/"));
    const dockerfile = await readFile(dockerfilePath, "utf-8");

    const contextRoot = join(
      context.contextDir,
      ...normalizeDockerRelativePath(context.rootDirectory).split("/").filter(Boolean),
    );

    return {
      kind: "local",
      contextRoot,
      dockerfile,
      cleanup: context.cleanup,
    };
  }

  private async resolveRemoteDockerfileBuildSource(
    config: BuildConfig,
    logger: BuildLogger,
  ): Promise<DockerfileBuildSource> {
    const candidates = resolveDockerfileCandidates(config.rootDirectory, config.dockerfilePath);
    const sourceLabel = config.commitSha
      ? `${config.branch}@${config.commitSha.slice(0, 7)}`
      : config.branch;
    const checkoutRef = config.commitSha ?? "FETCH_HEAD";
    const sourceDir = "/openship/dockerfile-source";
    let sourceWorkspaceId: string | undefined;

    try {
      logger.log(`Resolving Dockerfile source in cloud workspace (${sourceLabel})...\n`);
      const provisioned = await this.provisionWorkspace(
        {
          name: `${config.slug ?? config.projectId}-source`.slice(0, 60),
          image: DOCKERFILE_SOURCE_IMAGE,
          mode: "temporary",
          resources: config.resources,
          env: config.envVars,
          ttl: "10m",
        },
        logger,
      );
      sourceWorkspaceId = provisioned.workspaceId;
      this.trackActiveBuildWorkspace(config.sessionId, provisioned.workspaceId);

      await this.ensureWorkspaceGit(provisioned.runtime, logger, "Dockerfile source workspace");

      const executor = this.workspaceExecutor(provisioned.runtime);
      const cloneUrl = injectGitToken(config.repoUrl, config.gitToken);
      const fetchCommand = [
        "set -e",
        `rm -rf ${sq(sourceDir)}`,
        `mkdir -p ${sq(sourceDir)}`,
        `cd ${sq(sourceDir)}`,
        "git init -q",
        `git remote add origin ${sq(cloneUrl)}`,
        `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git -c credential.helper= fetch --depth ${config.commitSha ? "50" : "1"} origin ${sq(config.branch)}`,
        `git -c credential.helper= -c advice.detachedHead=false checkout -q ${sq(checkoutRef)}`,
        'echo "Dockerfile source fetch ready."',
      ].join("\n");
      const fetchResult = await executor.streamExec(fetchCommand, logger.callback);
      if (fetchResult.code !== 0) {
        throw new Error(
          summarizeCommandOutput(fetchResult.output) || "Failed to fetch Dockerfile source",
        );
      }

      for (const candidate of candidates) {
        logger.log(`Checking Dockerfile candidate: ${candidate}\n`);
        const dockerfile = await executor
          .exec(
            [
              `cd ${sq(sourceDir)}`,
              `test -f ${sq(candidate)}`,
              `cat ${sq(candidate)}`,
            ].join(" && "),
            { timeout: 30_000 },
          )
          .catch(() => null);
        if (dockerfile !== null) {
          logger.log(`Dockerfile source resolved: ${candidate}\n`);
          const workspaceId = sourceWorkspaceId;
          sourceWorkspaceId = undefined;
          return {
            kind: "remote",
            contextRelativePath: normalizeDockerRelativePath(config.rootDirectory),
            dockerfile,
            cleanup: async () => {
              await this.ws(workspaceId)
                .delete()
                .catch(() => {});
              this.untrackActiveBuildWorkspace(config.sessionId, workspaceId);
            },
          };
        }
      }

      const discovered = await executor
        .exec(
          `cd ${sq(sourceDir)} && find . -maxdepth 5 -type f -iname Dockerfile | sed 's#^./##' | head -20`,
          { timeout: 30_000 },
        )
        .then((value) => value.trim())
        .catch(() => "");
      throw new Error(
        `No Dockerfile found. Checked: ${candidates.join(", ")}${
          discovered ? `. Found: ${discovered.replace(/\n/g, ", ")}` : ""
        }`,
      );
    } finally {
      if (sourceWorkspaceId) {
        await this.ws(sourceWorkspaceId)
          .delete()
          .catch(() => {});
        this.untrackActiveBuildWorkspace(config.sessionId, sourceWorkspaceId);
      }
    }
  }

  private getUnsupportedDockerfilePlanFeatures(plan: WorkspaceBuildPlan): string[] {
    const errors: string[] = [];

    for (const stage of plan.stages) {
      if (stage.shell && stage.shell.join("\0") !== ["/bin/sh", "-c"].join("\0")) {
        errors.push(
          `Dockerfile stage "${stage.name ?? stage.index}" uses SHELL ${JSON.stringify(stage.shell)}, which is not supported by cloud Dockerfile builds yet.`,
        );
      }

      for (const run of stage.runs) {
        const flags = Object.keys(run.flags);
        if (flags.length > 0) {
          errors.push(
            `Dockerfile line ${run.line}: RUN flags (${flags.map((flag) => `--${flag}`).join(", ")}) are not supported by cloud Dockerfile builds yet.`,
          );
        }
      }

      for (const copy of stage.copies) {
        if (copy.kind === "add") {
          errors.push(
            `Dockerfile line ${copy.line}: ADD is not supported by cloud Dockerfile builds yet. Use COPY for local files.`,
          );
        }

        const flags = Object.keys(copy.flags).filter((flag) => flag !== "from");
        if (flags.length > 0) {
          errors.push(
            `Dockerfile line ${copy.line}: ${copy.kind.toUpperCase()} flags (${flags.map((flag) => `--${flag}`).join(", ")}) are not supported by cloud Dockerfile builds yet.`,
          );
        }
      }
    }

    return errors;
  }

  private async executeDockerfilePlan(opts: {
    config: BuildConfig;
    plan: WorkspaceBuildPlan;
    source: DockerfileBuildSource;
    logger: BuildLogger;
    onWorkspaceCreated(workspaceId: string): void;
  }): Promise<{ workspaceId: string; runtime: WorkspaceRuntimePlan }> {
    const { config, plan, source, logger, onWorkspaceCreated } = opts;
    const plannedStageRefs = new Map<string, WorkspaceBuildStagePlan>();
    const resolvedStageBaseImages = new Map<number, string>();
    const stageBaseLabels = new Map<number, string>();
    let workspaceBaseImage: string | undefined;
    let workspaceId: string | undefined;

    try {
      for (const stage of plan.stages) {
        const stageName = stage.name ?? String(stage.index);
        const allArgs = { ...plan.globalArgs, ...stage.args };
        const requestedBaseImage = substituteDockerArgs(stage.baseImage, allArgs);
        const baseStageRef = plannedStageRefs.get(requestedBaseImage);
        const baseImage = baseStageRef
          ? resolvedStageBaseImages.get(baseStageRef.index)
          : requestedBaseImage;
        if (!baseImage || baseImage.includes("$")) {
          throw new Error(
            `Dockerfile stage "${stageName}" has unresolved base image "${stage.baseImage}".`,
          );
        }

        const baseLabel = stageBaseLabel(baseImage, requestedBaseImage, baseStageRef?.name);
        if (workspaceBaseImage && workspaceBaseImage !== baseImage) {
          throw new Error(
            `Dockerfile stage "${stageName}" uses base image "${baseLabel}", but cloud Dockerfile builds run one workspace per service and only support one base image per Dockerfile. Use stage aliases that resolve to "${workspaceBaseImage}" or deploy this service with Docker support.`,
          );
        }

        workspaceBaseImage ??= baseImage;
        stageBaseLabels.set(stage.index, baseLabel);
        resolvedStageBaseImages.set(stage.index, baseImage);
        plannedStageRefs.set(String(stage.index), stage);
        if (stage.name) plannedStageRefs.set(stage.name, stage);
      }

      if (!workspaceBaseImage) {
        throw new Error("Dockerfile did not define a base image.");
      }

      const provisioned = await this.provisionWorkspace(
        {
          name: `${config.slug ?? config.projectId}-dockerfile`.slice(0, 60),
          image: workspaceBaseImage,
          mode: "temporary",
          resources: config.resources,
          env: config.envVars,
          ttl: "15m",
        },
        logger,
      );
      workspaceId = provisioned.workspaceId;
      onWorkspaceCreated(provisioned.workspaceId);

      if (
        plan.stages.some((stage) =>
          stage.steps.some((step) => step.type === "copy" && !step.copy.from),
        )
      ) {
        await this.transferDockerfileContext(config, source, provisioned.runtime, logger);
      }

      const completedStageRefs = new Map<string, WorkspaceBuildStagePlan>();

      for (const stage of plan.stages) {
        const stageName = stage.name ?? String(stage.index);
        const baseLabel = stageBaseLabels.get(stage.index) ?? workspaceBaseImage;
        logger.log(`Preparing Dockerfile stage "${stageName}" from ${baseLabel}...\n`);

        await this.execAndStream(
          provisioned.runtime,
          ["sh", "-c", `mkdir -p ${sq(stage.workdir || "/")}`],
          logger.callback,
        );

        for (const step of stage.steps) {
          if (step.type === "copy") {
            await this.applyDockerfileCopyStep({
              copy: step.copy,
              stageRefs: completedStageRefs,
              runtime: provisioned.runtime,
              logger,
            });
          } else {
            await this.applyDockerfileRunStep({
              run: step.run,
              runtime: provisioned.runtime,
              logger,
              env: {
                ...config.envVars,
                ...plan.globalArgs,
                ...stage.args,
                ...step.run.env,
              },
            });
          }
        }

        completedStageRefs.set(String(stage.index), stage);
        if (stage.name) completedStageRefs.set(stage.name, stage);
      }

      if (!plan.runtime) {
        throw new Error("Dockerfile final stage workspace was not created.");
      }

      return { workspaceId: provisioned.workspaceId, runtime: plan.runtime };
    } catch (err) {
      if (workspaceId) {
        await this.ws(workspaceId)
          .delete()
          .catch(() => {});
      }
      throw err;
    }
  }

  private async transferDockerfileContext(
    config: BuildConfig,
    source: DockerfileBuildSource,
    runtime: CloudWorkspaceRuntime,
    logger: BuildLogger,
  ): Promise<void> {
    if (source.kind === "local") {
      await transferLocalDirectory(
        source.contextRoot,
        { kind: "cloud-runtime", runtime, path: "/openship/context" },
        logger,
        { excludes: [...TRANSFER_EXCLUDES] },
      );
      return;
    }

    await this.cloneDockerfileContext(config, source, runtime, logger);
  }

  private async cloneDockerfileContext(
    config: BuildConfig,
    source: Extract<DockerfileBuildSource, { kind: "remote" }>,
    targetRuntime: CloudWorkspaceRuntime,
    logger: BuildLogger,
  ): Promise<void> {
    const repoRoot = "/openship/repo";
    const contextRoot = "/openship/context";
    const contextRelativePath = normalizeDockerRelativePath(source.contextRelativePath);

    if (contextRelativePath.startsWith("..")) {
      throw new Error("Dockerfile build context escapes the repository source.");
    }

    const cloneUrl = injectGitToken(config.repoUrl, config.gitToken);
    const depthArgs = config.commitSha ? "--depth 50 " : "--depth 1 ";
    const cloneTarget = contextRelativePath ? repoRoot : contextRoot;
    const contextSource = contextRelativePath
      ? joinWorkspacePath(repoRoot, contextRelativePath)
      : contextRoot;
    const prepareContextCommands = contextRelativePath
      ? [
          `echo "Copying Dockerfile context ${contextRelativePath}..."`,
          `mkdir -p ${sq(contextRoot)}`,
          `cp -a ${sq(`${contextSource}/.`)} ${sq(contextRoot)}/`,
        ]
      : ['echo "Using repository root as Dockerfile context."'];
    const excludedPaths = TRANSFER_EXCLUDES.map((path) =>
      `rm -rf ${sq(joinWorkspacePath(contextRoot, path))}`,
    );
    const cloneCommand = [
      "set -e",
      `rm -rf ${sq(repoRoot)} ${sq(contextRoot)}`,
      "mkdir -p /openship",
      `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git -c credential.helper= clone ${depthArgs}--branch ${sq(config.branch)} ${sq(cloneUrl)} ${sq(cloneTarget)}`,
    ].join("\n");
    const checkoutCommand = config.commitSha
      ? `cd ${sq(cloneTarget)} && git -c credential.helper= -c advice.detachedHead=false checkout ${sq(config.commitSha)}`
      : "";
    const prepareCommand = [
      "set -e",
      `rm -rf ${sq(joinWorkspacePath(cloneTarget, ".git"))}`,
      ...prepareContextCommands,
      'echo "Pruning Dockerfile context..."',
      ...excludedPaths,
      'echo "Dockerfile context prepared."',
    ].join("\n");

    logger.log(`Preparing Dockerfile build workspace for repository clone (branch: ${config.branch})...\n`);
    await this.ensureWorkspaceGit(targetRuntime, logger, "Dockerfile build workspace");
    logger.log(`Cloning Dockerfile context in build workspace (branch: ${config.branch})...\n`);
    await this.execAndStream(targetRuntime, ["sh", "-c", cloneCommand], logger.callback, 900);
    if (checkoutCommand) {
      await this.execAndStream(targetRuntime, ["sh", "-c", checkoutCommand], logger.callback, 300);
    }
    await this.execAndStream(targetRuntime, ["sh", "-c", prepareCommand], logger.callback, 300);
    logger.log("Dockerfile context ready.\n");
  }

  private async applyDockerfileRunStep(opts: {
    run: WorkspaceRunStep;
    runtime: Awaited<ReturnType<WorkspaceHandle["runtime"]>>;
    logger: BuildLogger;
    env: Record<string, string | null>;
  }): Promise<void> {
    const { run, runtime, logger, env } = opts;
    const command = `mkdir -p ${sq(run.workdir)} && cd ${sq(run.workdir)} && ${envExportPrefix(env)}${run.command}`;
    logger.log(`[Dockerfile] RUN ${run.command}\n`);
    await this.execAndStream(runtime, ["sh", "-c", command], logger.callback);
  }

  private async applyDockerfileCopyStep(opts: {
    copy: WorkspaceCopyStep;
    stageRefs: Map<string, WorkspaceBuildStagePlan>;
    runtime: Awaited<ReturnType<WorkspaceHandle["runtime"]>>;
    logger: BuildLogger;
  }): Promise<void> {
    const { copy, stageRefs, runtime, logger } = opts;
    let sourceBase = "/openship/context";
    let sourcePaths = copy.sources;
    let copyFromStage = false;

    if (copy.from) {
      const sourceStage = stageRefs.get(copy.from);
      if (!sourceStage) {
        throw new Error(
          `COPY --from=${copy.from} references an external image, current stage, later stage, or unknown stage. Cloud Dockerfile builds support --from only for previous stages in the same Dockerfile.`,
        );
      }

      if (copy.sources.some(hasGlob)) {
        throw new Error(
          `COPY --from=${copy.from} uses glob sources (${copy.sources.join(", ")}), which are not supported in cloud Dockerfile stage artifact copies yet.`,
        );
      }

      const downloadPaths = copy.sources.map(stageArtifactDownloadPath);
      const sourceLabel = downloadPaths.join(" ");
      logger.log(`[Dockerfile] COPY artifacts from stage "${copy.from}": ${sourceLabel}\n`);
      copyFromStage = true;
      sourceBase = "";
      sourcePaths = downloadPaths;
    }

    const destination = resolveVmPath(copy.workdir, copy.destination);
    const destinationIsDir =
      copy.sources.length > 1 ||
      copy.destination.endsWith("/") ||
      copy.destination === "." ||
      copy.destination.endsWith("/.");
    const destinationTarget = destinationIsDir ? destination : posix.dirname(destination);
    const sourceExprs = copyFromStage
      ? sourcePaths.map((source) => sq(source))
      : sourcePaths.map((source) => sourceExpression(sourceBase, source));

    if (copyFromStage) {
      const samePathCopies = sourcePaths.map((source) => ({
        source: posix.normalize(source),
        target: posix.normalize(
          resolveCopyDestinationPath(copy, source, destination, destinationIsDir),
        ),
      }));

      if (samePathCopies.every(({ source, target }) => source === target)) {
        const verifyCommand = samePathCopies
          .map(({ source }) => `test -e ${sq(source)}`)
          .join(" && ");
        await this.execAndStream(runtime, ["sh", "-c", verifyCommand], logger.callback);
        logger.log("[Dockerfile] COPY artifacts already available in current workspace.\n");
        return;
      }
    }

    const command = [
      "set -e",
      `mkdir -p ${sq(destinationTarget)}`,
      ...dockerCopyShellCommands({
        sources: sourceExprs,
        destination,
        destinationIsDir,
        destinationTarget,
      }),
    ].join("\n");

    logger.log(
      `[Dockerfile] ${copy.kind.toUpperCase()} ${copy.sources.join(" ")} ${copy.destination}\n`,
    );
    await this.execAndStream(runtime, ["sh", "-c", command], logger.callback);
  }

  /**
   * Provision a temporary cloud workspace for a build.
   *
   * This is the cloud-specific "prepare" phase:
   *   1. Create workspace (image + resources + env vars)
   *   2. Set TTL for auto-cleanup
   *   3. Acquire runtime token (enable API server + get JWT)
   *
   * Output streams to the terminal via logger so the user sees
   * progress before the numbered build steps begin.
   */
  private async provisionWorkspace(
    config: {
      name: string;
      image: string;
      mode: "temporary" | "permanent";
      resources: ResourceConfig;
      env?: Record<string, string>;
      ttl?: string;
    },
    logger: BuildLogger,
  ): Promise<{ workspaceId: string; runtime: Awaited<ReturnType<WorkspaceHandle["runtime"]>> }> {
    logger.log(`Creating workspace from image "${config.image}"...\n`);

    let wsData: { id: string };
    try {
      wsData = await this.client.workspaces.create({
        name: config.name,
        image: config.image,
        mode: config.mode,
        config: {
          cpus: config.resources.cpuCores,
          memory_mb: config.resources.memoryMb,
          disk_size_mb: config.resources.diskMb,
          env: toEnvArray(config.env ?? {}),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.log(`Failed to create workspace from image "${config.image}": ${message}\n`, "error");
      throw err;
    }

    const ws = this.ws(wsData.id);

    try {
      if (config.mode === "temporary" && config.ttl) {
        try {
          await ws.lifecycle.makeTemporary({
            ttl: config.ttl,
            ttl_action: "remove",
            remove_on_exit: true,
          });
        } catch {
          // TTL failure is non-fatal - workspace will be cleaned up eventually.
        }
      }

      logger.log("Connecting to build environment...\n");
      let rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rt = await ws.runtime();
          break;
        } catch (err) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            throw err;
          }
        }
      }
      if (!rt) throw new Error("Failed to connect to build environment");

      logger.log("Build environment ready\n");
      return { workspaceId: wsData.id, runtime: rt };
    } catch (err) {
      await ws.delete().catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      logger.log(`Failed to prepare workspace "${wsData.id}": ${message}\n`, "error");
      throw err;
    }
  }

  private async provisionBuildWorkspace(
    config: BuildConfig,
    logger: BuildLogger,
  ): Promise<{ workspaceId: string; runtime: Awaited<ReturnType<WorkspaceHandle["runtime"]>> }> {
    logger.log("Provisioning build environment...\n");

    // Create temporary workspace with build resources
    const envArray = Object.entries(config.envVars).map(([k, v]) => `${k}=${v}`);
    logger.log(`Creating build workspace from image "${config.buildImage}"...\n`);

    let wsData: { id: string };
    try {
      wsData = await this.client.workspaces.create({
        name: config.slug ?? `build-${config.projectId.slice(0, 20)}`,
        image: config.buildImage,
        mode: "temporary",
        config: {
          cpus: config.resources.cpuCores,
          memory_mb: config.resources.memoryMb,
          disk_size_mb: config.resources.diskMb,
          env: envArray,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.log(
        `Failed to create build workspace from image "${config.buildImage}": ${message}\n`,
        "error",
      );
      throw err;
    }

    const ws = this.ws(wsData.id);

    try {
      // Set TTL via dedicated lifecycle API (config.ttl during create is unreliable)
      try {
        await ws.lifecycle.makeTemporary({
          ttl: "15m",
          ttl_action: "remove",
          remove_on_exit: true,
        });
      } catch {
        // TTL failure is non-fatal - workspace will be cleaned up eventually
      }

      // Acquire runtime handle (enables API server + gets JWT)
      logger.log("Connecting to build environment...\n");
      let rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rt = await ws.runtime();
          break;
        } catch (err) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            throw err;
          }
        }
      }
      if (!rt) throw new Error("Failed to connect to build environment");

      logger.log("Build environment ready\n");

      return { workspaceId: wsData.id, runtime: rt };
    } catch (err) {
      // Workspace was created but setup failed - clean it up
      await ws.delete().catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      logger.log(`Failed to prepare build workspace "${wsData.id}": ${message}\n`, "error");
      throw err;
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    const activeBuild = this.activeBuilds.get(sessionId);
    if (!activeBuild) {
      return;
    }

    activeBuild.abort.abort();

    const workspaceIds = [...activeBuild.workspaceIds];
    await Promise.allSettled(
      workspaceIds.map(async (workspaceId) => {
        await this.destroy(workspaceId).catch(() => {});
        activeBuild.workspaceIds.delete(workspaceId);
      }),
    );
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    // Build logs are streamed in real-time via onLog callback
    // Historical logs are stored in the database by build.service.ts
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult> {
    const workspaceId = config.imageRef;
    if (!workspaceId) {
      return {
        deploymentId: config.deploymentId,
        status: "failed",
      };
    }

    const ws = this.ws(workspaceId);
    const log: LogCallback = onLog ?? (() => {});

    try {
      // 1. Make workspace permanent (it was temporary during build)
      await ws.lifecycle.makePermanent();
    } catch (err) {
      throw new Error(
        `Failed to make workspace permanent: ${err instanceof Error ? err.message : err}`,
      );
    }

    // TODO: temporarily disabled - testing without resource shrink
    // try {
    //   // 2. Resize CPU/memory to production levels
    //   //    Disk is NOT resized down - VMs don't support disk shrink.
    //   //    The build disk size carries over (harmless, just extra space).
    //   await ws.resources.update({
    //     cpus: config.resources.cpuCores,
    //     memory_mb: config.resources.memoryMb,
    //     apply: true,
    //   });
    // } catch (err) {
    //   throw new Error(`Failed to resize workspace: ${err instanceof Error ? err.message : err}`);
    // }

    // 2. Prepare production directory - copy only what's needed at runtime
    const builtArtifact = this.builtArtifacts.get(workspaceId);
    const prodPaths = config.productionPaths;
    const workDir =
      builtArtifact?.runtime.workdir ?? (prodPaths?.length ? "/app/production" : "/app");

    if (prodPaths?.length) {
      try {
        const rt = await ws.runtime();
        const logCb: LogCallback = onLog ?? (() => {});

        // Sanitize paths - reject anything that could escape /app/
        const safePaths = prodPaths.filter((p) => {
          const normalized = p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
          return (
            normalized.length > 0 &&
            normalized !== ".." &&
            !normalized.startsWith("../") &&
            !normalized.includes("/../") &&
            !normalized.includes("\\")
          );
        });

        if (safePaths.length === 0) {
          throw new Error("No valid production paths after sanitization");
        }

        // Shell-escape a string for use inside single quotes
        const sq = (s: string) => s.replace(/'/g, "'\\''");

        // Build an atomic shell script:
        //   1. Create staging dir
        //   2. Move each path (skip missing with warning)
        //   3. Rename staging → production (atomic on same filesystem)
        //   4. On any error, clean up staging dir
        const moveLines = safePaths
          .map((p) => {
            const e = sq(p);
            return `if [ -e '/app/${e}' ]; then
  d=$(dirname '${e}')
  mkdir -p "/app/.staging/$d"
  mv '/app/${e}' '/app/.staging/${e}'
  echo "  moved ${e}"
else
  echo "  skip ${e} (not found)"
fi`;
          })
          .join("\n");

        const script = `set -e
cleanup() { echo "Cleaning up staging dir"; rm -rf /app/.staging; }
echo "Preparing production directory..."
rm -rf /app/.staging
mkdir -p /app/.staging
${moveLines}
if [ "$(ls -A /app/.staging)" ]; then
  rm -rf /app/production
  mv /app/.staging /app/production
  echo "Production directory ready"
else
  cleanup
  echo "ERROR: no files were moved - check production paths"
  exit 1
fi`;

        await this.execAndStream(rt, ["sh", "-c", script], logCb);
      } catch (err) {
        throw new Error(
          `Failed to prepare production directory: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // 3. Create a workload for the application process
    const startCommand = builtArtifact?.runtime.startCommand || config.startCommand || "npm start";
    const envArray = toEnvArray({
      ...(builtArtifact?.runtime.env ?? {}),
      ...config.envVars,
    });

    const restartPolicy =
      config.restartPolicy === "no"
        ? ("never" as const)
        : ((config.restartPolicy ?? "always") as "always" | "on-failure" | "never");

    try {
      await ws.workloads.create({
        name: "app",
        cmd: ["sh", "-c", `cd ${workDir} && ${startCommand}`],
        working_dir: workDir,
        env: [...envArray, `PORT=${config.port}`],
        restart_policy: restartPolicy,
        max_restarts: 10,
      });
    } catch (err) {
      throw new Error(`Failed to create workload: ${err instanceof Error ? err.message : err}`);
    }

    // 4. Expose the primary configured public endpoint, if any.
    let url: string | undefined;
    const primaryEndpoint = primaryPublicEndpoint(config);
    const primarySlug = endpointSlug(primaryEndpoint);
    const primaryCustomDomain = endpointCustomDomain(primaryEndpoint);
    const primaryPort = primaryEndpoint?.port ?? config.port;

    if (primaryCustomDomain) {
      try {
        // publicAccess.expose() opens the firewall implicitly, but with a
        // custom domain we allow the target port explicitly instead.
        await ws.network.update({ ingress_ports: [primaryPort] });

        await ws.domains.connect({
          domain: primaryCustomDomain,
          port: primaryPort,
        });
        url = `https://${primaryCustomDomain}`;
      } catch (err) {
        throw new Error(
          `Failed to connect custom domain ${primaryCustomDomain}: ${errorMessage(err)}`,
        );
      }
    } else if (primarySlug) {
      try {
        log({
          timestamp: now(),
          level: "info",
          message: `Exposing ${exposeTarget(primaryPort, primarySlug)}...\n`,
        });
        const exposeResult = await ws.publicAccess.expose({
          port: primaryPort,
          domain: "opsh.io",
          slug: primarySlug,
        });
        url = exposeResult.url as string | undefined;
      } catch (err) {
        throw new Error(
          `Failed to expose ${exposeTarget(primaryPort, primarySlug)}: ${errorMessage(err)}`,
        );
      }
    } else {
      log({
        timestamp: now(),
        level: "info",
        message: "No public endpoint configured; skipping cloud public exposure.\n",
      });
    }

    return {
      deploymentId: config.deploymentId,
      containerId: workspaceId,
      url: url ?? undefined,
      status: "running",
    };
  }

  /**
   * Deploy a static site via Oblien Pages.
   *
   * Flow:
   *   1. Create a page from the workspace build output → files copied to edge
   *   2. Page goes live immediately on CDN
   *   3. Delete the workspace - page is independent, no VM needed
   *
   * The "containerId" in the result is the page ID (for future updates/teardown).
   */
  async deployStatic(
    config: DeployConfig & { outputDirectory: string; projectName?: string },
  ): Promise<DeploymentResult> {
    const workspaceId = config.imageRef;
    if (!workspaceId) {
      return { deploymentId: config.deploymentId, status: "failed" };
    }

    // 1. Create page via Pages API - export build output from workspace
    const outputPath = config.outputDirectory.startsWith("/")
      ? config.outputDirectory
      : `/app/${config.outputDirectory}`;

    console.log(
      `Deploying static site from workspace ${workspaceId}, output path ${outputPath}...`,
    );

    const primaryEndpoint = primaryPublicEndpoint(config);
    const primarySlug = endpointSlug(primaryEndpoint);
    const primaryCustomDomain = endpointCustomDomain(primaryEndpoint);
    const pageSlug = primarySlug ?? fallbackRuntimeName(config);

    let page: { slug: string; url?: string | null };

    if (primaryCustomDomain) {
      // Deploy with custom domain only - no free subdomain
      let pg: { slug: string; url?: string | null };
      try {
        const result = await this.client.pages.create({
          workspace_id: workspaceId,
          path: outputPath,
          name: config.projectName ?? pageSlug,
          slug: pageSlug,
        });
        pg = result.page;
      } catch (err) {
        throw new Error(
          `Failed to create static page for slug "${pageSlug}" with custom domain "${primaryCustomDomain}": ${errorMessage(err)}`,
        );
      }

      await this.client.pages
        .connectDomain(pg.slug, {
          domain: primaryCustomDomain,
        })
        .catch(() => {
          // Non-fatal: page can still be accessed via slug if domain isn't verified yet
        });

      page = { ...pg, url: pg.url ?? `https://${primaryCustomDomain}` };
    } else if (primarySlug) {
      // Deploy with free subdomain (slug.opsh.io). Creating a page on
      // the shared `.opsh.io` zone is an account-level (admin) op —
      // namespace tokens can't do it. When this runtime was given an
      // adminProxy (i.e. we're running on a local/desktop instance),
      // hand off to the SaaS; otherwise use the direct client (SaaS
      // master creds path).
      const createOnSharedZone = this.adminProxy?.createPage ??
        ((input) => this.client.pages.create(input));
      let pg: { slug: string; url?: string | null };
      try {
        const result = await createOnSharedZone({
          workspace_id: workspaceId,
          path: outputPath,
          name: config.projectName ?? pageSlug,
          slug: pageSlug,
          domain: "opsh.io",
        });
        pg = result.page;
      } catch (err) {
        throw new Error(
          `Failed to create static page for slug "${pageSlug}" (${pageSlug}.opsh.io): ${errorMessage(err)}`,
        );
      }

      page = pg;
    } else {
      let pg: { slug: string; url?: string | null };
      try {
        const result = await this.client.pages.create({
          workspace_id: workspaceId,
          path: outputPath,
          name: config.projectName ?? pageSlug,
          slug: pageSlug,
        });
        pg = result.page;
      } catch (err) {
        throw new Error(
          `Failed to create static page for slug "${pageSlug}": ${errorMessage(err)}`,
        );
      }

      page = { ...pg, url: undefined };
    }

    // // 3. Delete the workspace - page lives independently on the edge
    await this.ws(workspaceId)
      .delete()
      .catch(() => {
        // Non-fatal: workspace has TTL and will auto-cleanup
      });

    return {
      deploymentId: config.deploymentId,
      containerId: `page:${page.slug}`,
      url: page.url ?? undefined,
      status: "running",
    };
  }

  async stop(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      await this.client.pages.disable(containerId.slice(5));
    } else {
      await this.ws(containerId).stop();
    }
  }

  async start(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      await this.client.pages.enable(containerId.slice(5));
    } else {
      await this.ws(containerId).start();
    }
  }

  async restart(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      // Pages are static - no process to restart
      return;
    }
    await this.ws(containerId).restart();
  }

  async destroy(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      await this.client.pages.delete(containerId.slice(5));
    } else {
      await this.ws(containerId).delete();
      this.builtArtifacts.delete(containerId);
    }
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const data = await this.ws(containerId).get();

    const statusMap: Record<string, ContainerStatus> = {
      running: "running",
      stopped: "stopped",
      starting: "deploying",
      stopping: "stopped",
      creating: "building",
      error: "failed",
    };

    return {
      containerId,
      status: statusMap[data.status] ?? "stopped",
      ip: (data as Record<string, unknown>).ip as string | undefined,
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    try {
      const result = await this.ws(containerId).workloads.logs("app");
      const raw = result as Record<string, unknown>;

      // Oblien returns { logs: "<big string with newlines>" }
      // Each line: [timestamp] stream: message
      if (typeof raw.logs === "string") {
        const logStr = raw.logs as string;
        return applyTail(
          logStr
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              // Parse "[2026-03-14T06:09:25Z] stdout: actual message"
              const match = line.match(/^\[([^\]]+)\]\s+(stdout|stderr):\s?(.*)/);
              if (match) {
                return {
                  timestamp: match[1],
                  message: match[3],
                  level: match[2] === "stderr" ? ("warn" as const) : ("info" as const),
                };
              }
              return { timestamp: now(), message: line, level: "info" as const };
            }),
          tail,
        );
      }

      // Fallback: array shapes
      const lines = Array.isArray(raw.logs)
        ? raw.logs
        : Array.isArray(raw.entries)
          ? raw.entries
          : Array.isArray(result)
            ? (result as unknown[])
            : [];
      if (lines.length === 0) return [];

      return applyTail(
        lines
          .map((line: unknown) => {
            if (typeof line === "string") {
              return { timestamp: now(), message: line, level: "info" as const };
            }
            const entry = line as Record<string, unknown>;
            const message = (entry.message as string) ?? (entry.data as string) ?? String(line);
            return {
              timestamp: (entry.timestamp as string) ?? now(),
              message,
              level: entry.stream === "stderr" ? ("warn" as const) : ("info" as const),
            };
          })
          .filter((e) => e.message),
        tail,
      );
    } catch {
      // Workload may not exist yet - fall back to workspace cmd logs
      const result = await this.ws(containerId).logs.get({
        source: "cmd",
        tail_lines: tail ?? 100,
      });

      const lines = (result as Record<string, unknown>).logs;
      if (!Array.isArray(lines)) return [];

      return applyTail(
        lines.map((line: unknown) => {
          if (typeof line === "string") {
            return { timestamp: now(), message: line, level: "info" as const };
          }
          const entry = line as Record<string, unknown>;
          return {
            timestamp: (entry.timestamp as string) ?? now(),
            message: (entry.message as string) ?? String(line),
            level: "info" as const,
          };
        }),
        tail,
      );
    }
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    let cancelled = false;

    const emitText = (text: string, level: LogEntry["level"], timestamp?: string) => {
      if (!text) return; // skip empty entries
      const rawData = Buffer.from(text).toString("base64");
      onLog({ timestamp: timestamp ?? now(), message: text, level, rawData });
    };

    const run = async () => {
      try {
        // 1. Replay existing logs so the terminal isn't blank
        const replayTail = opts?.tail ?? 100;
        if (replayTail > 0) {
          try {
            const history = await this.getRuntimeLogs(containerId, replayTail);
            for (const entry of history) {
              if (cancelled) return;
              if (!entry.message) continue;
              const rawData = entry.rawData ?? Buffer.from(entry.message).toString("base64");
              onLog({ ...entry, rawData });
            }
          } catch {
            // Historical fetch failed - non-fatal, continue to live stream
          }
        }

        if (cancelled) return;

        // 2. Follow new output from the workload process
        try {
          const stream = this.ws(containerId).workloads.logsStream("app");

          for await (const event of stream) {
            if (cancelled) break;
            const ev = event as Record<string, unknown>;
            const text = (ev.message as string) ?? event.data ?? "";
            emitText(text, event.stream === "stderr" ? "warn" : "info", event.timestamp);
          }
        } catch {
          // Workload stream unavailable - fall back to workspace cmd logs
          if (cancelled) return;
          try {
            const stream = this.ws(containerId).logs.streamCmd({
              tail_lines: opts?.tail ?? 100,
            });

            for await (const event of stream) {
              if (cancelled) break;
              emitText(event.message, "info", event.timestamp);
            }
          } catch {
            // Stream ended or was cancelled
          }
        }
      } catch {
        // Stream ended or was cancelled
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    const result = await this.ws(containerId).metrics.stats();
    const stats = result as Record<string, unknown>;
    return {
      cpuPercent: (stats.cpu_usage as number) ?? 0,
      memoryMb: (stats.memory_usage as number) ?? 0,
      diskMb: (stats.disk_usage as number) ?? 0,
      networkRxBytes: ((stats.network as Record<string, unknown>)?.rx as number) ?? 0,
      networkTxBytes: ((stats.network as Record<string, unknown>)?.tx as number) ?? 0,
    };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(containerId: string): Promise<string | null> {
    const data = await this.ws(containerId).get();
    return ((data as Record<string, unknown>).ip as string) ?? null;
  }

  // ── Compose / multi-service ────────────────────────────────────────────

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
    resources?: ResourceConfig;
  }): Promise<MultiServiceGroupHandle> {
    return this.compose.ensureServiceGroup(config);
  }

  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    return this.compose.deployServiceWorkload(group, config, onLog);
  }

  // ── Account ────────────────────────────────────────────────────────────

  /** Check cloud credentials and account status. Throws on failure. */
  async getQuota(): Promise<unknown> {
    return this.client.workspaces.getQuota();
  }

  // ── Domain / Slug checks ───────────────────────────────────────────────

  /**
   * Check whether a subdomain slug is available on opsh.io.
   * Uses Oblien's standalone `domain.checkSlug()` - no workspace needed.
   */
  async checkSlug(slug: string, domain = "opsh.io"): Promise<{ available: boolean; url: string }> {
    const result = await this.client.domain.checkSlug({ slug, domain });
    console.log("Slug check result:", result);
    return { available: result.available, url: result.url };
  }

  /**
   * Verify DNS records for a custom domain.
   * Uses Oblien's standalone `domain.verify()` - no workspace needed.
   */
  async verifyDomain(
    domain: string,
    resourceId?: string,
  ): Promise<{
    verified: boolean;
    cname: boolean;
    ownership: boolean | null;
    errors: string[];
    requiredRecords: {
      cname: { host: string; target: string };
      txt?: { host: string; value: string };
    };
  }> {
    const result = await this.client.domain.verify({ domain, resource_id: resourceId });
    return {
      verified: result.verified,
      cname: result.cname,
      ownership: result.ownership,
      errors: result.errors,
      requiredRecords: {
        cname: result.required_records.cname,
        txt: result.required_records.txt,
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private workspaceExecutor(rt: CloudWorkspaceRuntime): CommandExecutor {
    const run = async (
      command: string,
      onLog?: LogCallback,
      timeoutMs?: number,
    ): Promise<{ code: number; output: string }> => {
      let output = "";
      const collect: LogCallback = (entry) => {
        output += entry.message;
        onLog?.(entry);
      };

      try {
        await this.execAndStream(
          rt,
          ["sh", "-c", command],
          collect,
          timeoutMs ? Math.ceil(timeoutMs / 1000) : undefined,
        );
        return { code: 0, output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { code: 1, output: output || message };
      }
    };

    return {
      exec: async (command, opts) => {
        const result = await run(command, undefined, opts?.timeout);
        if (result.code !== 0) {
          throw new Error(result.output);
        }
        return result.output;
      },
      streamExec: async (command, onLog) => run(command, onLog, WORKSPACE_STREAM_EXEC_TIMEOUT_MS),
      writeFile: async () => {
        throw new Error("Workspace file writes are not supported by this executor");
      },
      readFile: async () => {
        throw new Error("Workspace file reads are not supported by this executor");
      },
      exists: async () => {
        throw new Error("Workspace file checks are not supported by this executor");
      },
      mkdir: async () => {
        throw new Error("Workspace mkdir is not supported by this executor");
      },
      rm: async () => {
        throw new Error("Workspace rm is not supported by this executor");
      },
      transferIn: async () => {
        throw new Error("Workspace transferIn is not supported by this executor");
      },
      dispose: async () => {},
    };
  }

  private async ensureWorkspaceGit(
    rt: CloudWorkspaceRuntime,
    logger: BuildLogger,
    label = "workspace",
  ): Promise<void> {
    const executor = this.workspaceExecutor(rt);
    const git = await checkGit(executor);
    if (git.healthy) {
      logger.log(`Git ready in ${label}.\n`);
      return;
    }

    const result = await installGit(executor, logger.callback, { label });
    if (!result.success) {
      const rechecked = await checkGit(executor);
      if (rechecked.healthy) {
        logger.log(`Git ready in ${label}.\n`);
        return;
      }
      throw new Error(result.error ?? rechecked.message ?? "Git installation failed");
    }
  }

  /**
   * Execute a command via the runtime exec API and stream output to the log callback.
   * Oblien returns stdout/stderr as native base64 - we pass it through directly
   * via rawData so session-manager forwards it to the frontend without re-encoding.
   * message is set to decoded text for DB storage / display.
   * Throws on non-zero exit code.
   */
  private async execAndStream(
    rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>>,
    cmd: string[],
    onLog: LogCallback,
    timeoutSeconds?: number,
  ): Promise<void> {
    const params = timeoutSeconds ? { timeoutSeconds } : undefined;
    const stream: AsyncGenerator<ExecStreamEvent> = rt.exec.stream(cmd, params);

    /** Collect recent output for error diagnostics */
    const recentOutput: string[] = [];
    const MAX_OUTPUT_LINES = 50;

    /** Emit a chunk - raw base64 passes straight through to SSE/terminal. */
    const emit = (b64: string, level: LogEntry["level"]) => {
      const message = Buffer.from(b64, "base64").toString("utf-8");
      onLog({ timestamp: now(), message, level, rawData: b64 });
      // Keep tail of output for error messages
      recentOutput.push(message);
      if (recentOutput.length > MAX_OUTPUT_LINES) recentOutput.shift();
    };

    let exitCode: number | undefined;

    for await (const event of stream) {
      switch (event.event) {
        case "stdout":
          emit(event.data, "info");
          break;
        case "stderr":
          emit(event.data, "warn");
          break;
        case "exit":
          exitCode = event.exit_code;
          break;
        case "output":
          if (event.stdout) emit(event.stdout, "info");
          if (event.stderr) emit(event.stderr, "warn");
          break;
      }
    }

    if (exitCode !== undefined && exitCode !== 0) {
      const output = recentOutput.join("").trim();
      const summary = summarizeCommandOutput(output);
      const detail = summary ? `: ${summary}` : "";
      throw new Error(`Command failed with exit code ${exitCode}${detail}`);
    }
  }
}
