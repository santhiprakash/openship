/**
 * Docker runtime - manages containers via the Docker Engine API (dockerode).
 *
 * Supports three connection modes:
 *   - Local socket (default, zero config)
 *   - Remote via SSH tunnel (ssh2 streamlocal forwarding to Docker socket)
 *   - Remote via TCP + mutual TLS
 *
 * This is ONLY the runtime. Routing (Nginx) and SSL (certbot) are separate
 * infrastructure providers - see `infra/`.
 *
 * Build strategy:
 *   Builds from a staged source context sent to the Docker daemon. If the
 *   repository already provides a Dockerfile, that becomes the source of
 *   truth. Otherwise Openship generates a minimal builder Dockerfile.
 *   Deploy creates a container from the resulting image.
 *
 * SECURITY MODEL:
 *   - SSH: uses the same configured credentials as the standard SSH executor
 *     (password, private key, or SSH agent).
 *   - SSH keys should be encrypted at rest and decrypted in memory only.
 *   - Host fingerprints can be pinned via `hostVerifier` (TOFU or strict).
 *   - TCP: mutual TLS (client cert + CA) - no plaintext TCP.
 */

import Dockerode from "dockerode";

import type {
  BuildConfig,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
  ShellOptions,
  ShellSession,
} from "../types";
import { PassThrough, Writable } from "node:stream";

/** Clamp a terminal window dimension to a sane min/max with default. */
function clampShellWindow(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.isFinite(value) ? Number(value) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
import type { Feature, SystemLog } from "../system/types";

import type {
  RuntimeAdapter,
  RuntimeCapability,
  MultiServiceGroupHandle,
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  DeploymentRef,
  RollbackInput,
  MakeActiveResult,
} from "./types";
import { BuildLogger, parseLogLevel, sq } from "./build-pipeline";
import { createDockerBuildContext } from "./docker-build-context";
import { transferLocalDirectory } from "./transfer";
import { safeErrorMessage } from "@repo/core";
import {
  type DockerConnectionOptions,
  type DockerTransport,
  resolveDockerTransport,
} from "./docker-transport";

// ─── Connection config ───────────────────────────────────────────────────────
export type { DockerConnectionOptions } from "./docker-transport";

interface DockerSystemManager {
  ensureFeature(feature: Feature, onLog?: (log: SystemLog) => void): Promise<void>;
}

// ─── Shared Docker helpers ───────────────────────────────────────────────────

const RESTART_POLICIES: Record<string, { Name: string; MaximumRetryCount: number }> = {
  always: { Name: "always", MaximumRetryCount: 0 },
  "on-failure": { Name: "on-failure", MaximumRetryCount: 5 },
  "unless-stopped": { Name: "unless-stopped", MaximumRetryCount: 0 },
  no: { Name: "no", MaximumRetryCount: 0 },
};

const DOCKER_BUILD_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function resolveRestartPolicy(policy?: string) {
  return RESTART_POLICIES[policy ?? "always"] ?? RESTART_POLICIES.always;
}

/** Parse port specs ("8080:3000", "3000") into Docker ExposedPorts + PortBindings */
function parsePortBindings(portSpecs: string[]): {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, { HostPort: string }[]>;
} {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};
  for (const spec of portSpecs) {
    const parts = spec.split(":");
    if (parts.length === 2) {
      const [hostPort, containerPort] = parts;
      exposedPorts[`${containerPort}/tcp`] = {};
      portBindings[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
    } else if (parts.length === 1) {
      exposedPorts[`${parts[0]}/tcp`] = {};
      portBindings[`${parts[0]}/tcp`] = [{ HostPort: "" }]; // random host port
    }
  }
  return { exposedPorts, portBindings };
}

/**
 * Detect whether a buffer chunk starts with Docker's 8-byte multiplexed
 * stream header (stream_type | 0 | 0 | 0 | size_be32).
 */
function hasDockerFrameHeader(buf: Buffer, offset = 0): boolean {
  return (
    buf.length >= offset + 8 &&
    (buf[offset] === 1 || buf[offset] === 2) &&
    buf[offset + 1] === 0 &&
    buf[offset + 2] === 0 &&
    buf[offset + 3] === 0
  );
}

/** Strip Docker multiplexed frame headers from a complete log buffer. */
function stripDockerHeaders(buf: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (hasDockerFrameHeader(buf, offset)) {
      const size = buf.readUInt32BE(offset + 4);
      lines.push(buf.subarray(offset + 8, offset + 8 + size).toString("utf-8"));
      offset += 8 + size;
    } else {
      lines.push(buf.subarray(offset).toString("utf-8"));
      break;
    }
  }
  return lines.join("");
}

/** Strip a single Docker frame header from one streaming chunk. */
function stripDockerChunkHeader(chunk: Buffer): Buffer {
  return hasDockerFrameHeader(chunk) ? chunk.subarray(8) : chunk;
}

/** Parse a Docker timestamp-prefixed log line into timestamp + message. */
function parseTimestampedLine(line: string): { timestamp: string; message: string } {
  const spaceIdx = line.indexOf(" ");
  return {
    timestamp: spaceIdx > 0 ? line.slice(0, spaceIdx) : new Date().toISOString(),
    message: spaceIdx > 0 ? line.slice(spaceIdx + 1) : line,
  };
}

/** Extract first host port and first container IP from an inspected container */
function extractNetworkInfo(data: { NetworkSettings: any }): {
  ip?: string;
  hostPort?: number;
} {
  let ip: string | undefined;
  for (const net of Object.values(data.NetworkSettings.Networks ?? {}) as any[]) {
    if (net.IPAddress) { ip = net.IPAddress; break; }
  }
  let hostPort: number | undefined;
  for (const bindings of Object.values(data.NetworkSettings.Ports ?? {}) as any[]) {
    if (bindings?.[0]?.HostPort) {
      hostPort = parseInt(bindings[0].HostPort, 10);
      break;
    }
  }
  return { ip, hostPort };
}

// ─── Docker runtime ──────────────────────────────────────────────────────────

export class DockerRuntime implements RuntimeAdapter {
  readonly name = "docker";
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
    "rollback",
    "serviceShell",
  ]);

  /** Underlying dockerode instance - exposed for advanced usage */
  readonly docker: Dockerode;
  /** Connection config this runtime was created with */
  readonly connectionOptions?: DockerConnectionOptions;
  /** Resolved transport - single switch point for socket / ssh / tcp */
  readonly transport: DockerTransport;
  private readonly systemManager: DockerSystemManager | null;

  constructor(opts?: DockerConnectionOptions, systemManager?: DockerSystemManager | null) {
    this.connectionOptions = opts;
    this.transport = resolveDockerTransport(opts);
    this.docker = new Dockerode(this.transport.dockerodeOptions);
    this.systemManager = systemManager ?? null;
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // dockerode handles connection cleanup internally via ssh2 / modem
  }

  // ─── Health check ──────────────────────────────────────────────────

  /** Ping the Docker daemon - useful for connection testing */
  async ping(): Promise<boolean> {
    try {
      await this.ensureDockerFeature();
      await this.transport.preflight();
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureDockerFeature(logger?: BuildLogger): Promise<void> {
    if (!this.systemManager) {
      return;
    }

    await this.systemManager.ensureFeature("deploy", (entry) => {
      logger?.log(entry.message, entry.level);
    });
  }

  /** Get Docker daemon info (version, platform, etc.) */
  async info(): Promise<Record<string, unknown>> {
    return this.docker.info();
  }

  // ── Image naming ────────────────────────────────────────────────────────

  /** Canonical image tag for a build session. */
  private imageTag(slug: string | undefined, sessionId: string): string {
    const name = slug ? `openship/${slug}` : `openship/build`;
    return `${name}:${sessionId}`;
  }

  /** Labels applied to both build images and deploy containers. */
  private labels(config: { deploymentId?: string; projectId: string; sessionId?: string }) {
    const l: Record<string, string> = {
      "openship.project": config.projectId,
    };
    if (config.deploymentId) l["openship.deployment"] = config.deploymentId;
    if (config.sessionId) l["openship.build"] = config.sessionId;
    return l;
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  /**
   * Sum the byte size of a directory tree. Best-effort - used only for a
   * human-readable "X MB context streamed" log line. Returns 0 if the
   * walk hits an error rather than failing the build.
   */
  private async estimateContextSize(dir: string): Promise<number> {
    const { stat, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            const s = await stat(full);
            total += s.size;
          } catch { /* ignore */ }
        }
      }
    }
    return total;
  }

  private emitDockerStep(
    logger: BuildLogger,
    step: "clone" | "install" | "build",
    status: "running" | "completed" | "skipped",
    message: string,
  ): void {
    // Mirror the step event to the terminal so users can follow the
    // phases in the build log too - otherwise the terminal stays blank
    // between text logs while the stepper bar quietly advances.
    const label = status === "running" ? "→" : status === "completed" ? "✓" : "↷";
    logger.log(`[${step}] ${label} ${message}`);
    logger.step(step, status, message);
  }

  private handleBuildEvent(
    event: {
      stream?: string;
      error?: string;
      errorDetail?: { message?: string };
      status?: string;
      id?: string;
      progress?: string;
      aux?: unknown;
    },
    logger: BuildLogger,
  ): string | null {
    const errorMessage = event.errorDetail?.message ?? event.error;
    if (errorMessage) {
      logger.log(errorMessage, "error");
      return errorMessage;
    }

    if (event.stream) {
      const line = event.stream.trim();
      if (!line) return null;

      const marker = line.match(
        /^\[openship-build\]\s+step=(clone|install|build)\s+status=(running|completed|skipped)$/,
      );
      if (marker) {
        const [, step, status] = marker;
        this.emitDockerStep(
          logger,
          step as "clone" | "install" | "build",
          status as "running" | "completed" | "skipped",
          line,
        );

        // After install completes inside the RUN, Docker still needs to
        // commit layers, run the runtime stage (COPY, etc.), and tag the
        // image. Tell the user we're past the slow part - the rest is
        // fast and not progress-streamed.
        if (status === "completed" && step === "install") {
          logger.log("Finalizing image (layer commit + tag)...");
        }

        return null;
      }

      if (this.isLowSignalDockerLine(line)) {
        return null;
      }

      logger.log(line, parseLogLevel(line));
      return this.extractBuildFailureHint(line);
    }

    if (event.status) {
      const parts = [event.id, event.status, event.progress]
        .filter((p): p is string => Boolean(p?.trim()))
        .map((p) => p.trim());
      if (parts.length) logger.log(parts.join(" "));
    }

    return null;
  }

  // Only the truly-redundant lines get filtered. We KEEP "Step N/M : ..."
  // because that's the user's best progress signal during a long build -
  // it shows which Dockerfile instruction is currently executing.
  //
  // Removed (= now passes through to terminal):
  //   - "Step N/M : ..."  → high-signal, shows progress
  //   - "Successfully built / tagged" → confirms success
  //
  // Still filtered (= noise):
  //   - "---> hash"       → opaque layer hash, no signal for users
  //   - "Running in ..."  → intermediate container id, no signal
  //   - "Removing intermediate container ..." → cleanup chatter
  private static readonly DOCKER_BUILDER_NOISE: RegExp[] = [
    /^--->/i,                     // ---> abc123def
    /^Running in\s+[a-f0-9]{6,}$/i,
    /^Removing intermediate container\s+[a-f0-9]{6,}$/i,
  ];

  private isLowSignalDockerLine(line: string): boolean {
    return DockerRuntime.DOCKER_BUILDER_NOISE.some((p) => p.test(line));
  }

  private extractBuildFailureHint(line: string): string | null {
    if (/returned a non-zero code:\s*\d+/i.test(line)) {
      return line;
    }

    if (/\/workspace\/package\.json/i.test(line) && /ENOENT/i.test(line)) {
      return "Docker build ran from /workspace but package.json was not found there. The configured rootDirectory is likely empty or incorrect.";
    }

    if (/failed to solve|executor failed running|error: build/i.test(line)) {
      return line;
    }

    return null;
  }

  private formatDockerConnectivityError(error: unknown): string {
    const message = safeErrorMessage(error);

    if (/^Cannot reach Docker daemon:/i.test(message)) {
      return message;
    }

    return `Cannot reach Docker daemon: ${message}. ${this.transport.unreachableHint}`;
  }

  /**
   * SSH transport build path. Bypasses dockerode's HTTP-over-SSH upload
   * (which is ~1-2 MB/s and silent) in favor of two well-trodden pieces:
   *
   *   1. `transferLocalDirectory(...)` - defaults to rsync over the
   *      SYSTEM `ssh` binary (NOT the Node `ssh2` library), with native
   *      `--progress` output streamed straight from rsync. ~10-30 MB/s
   *      typical. Lands the context at `/tmp/openship-build-<sessionId>`
   *      on remote. Falls back to tar through the ssh2 channel only if
   *      rsync isn't installed on either side.
   *
   *   2. `executor.streamExec("docker build ...")` - runs native docker
   *      CLI on the remote. Its raw stdout/stderr streams back unfiltered
   *      so the user sees real "Step N/M : ...", layer hashes, install
   *      output, etc. Same logs you'd see SSHing in and running it by hand.
   *
   * Container lifecycle (deploy, stop, logs, etc.) still uses dockerode -
   * only the slow build upload moves to this path.
   */
  private async buildViaSshTarPipe(
    config: BuildConfig,
    buildContext: Awaited<ReturnType<typeof createDockerBuildContext>>,
    tag: string,
    log: BuildLogger,
  ): Promise<void> {
    const executor = this.connectionOptions?.executor;
    if (!executor) throw new Error("SSH build path requires an executor on connectionOptions");

    const remoteContextDir = `/tmp/openship-build-${config.sessionId}`;
    log.log(`Streaming build context to ${remoteContextDir}...`);

    try {
      // Wipe stale dir from a previous failed deploy, if any. -rf is
      // safe - the path is namespaced by sessionId and only ever holds
      // the context we just transferred.
      await executor.exec(`rm -rf ${sq(remoteContextDir)} && mkdir -p ${sq(remoteContextDir)}`);

      // Ship the context. transferLocalDirectory's default "auto" mode
      // tries rsync first (system ssh + native --progress), tar/ssh2
      // fallback only if rsync is missing.
      await transferLocalDirectory(
        buildContext.contextDir,
        { kind: "executor", executor, path: remoteContextDir },
        log,
      );

      // Compose the docker build command. Quoting matters - buildargs
      // and labels can contain `=` and spaces.
      const buildArgs = Object.entries({
        ...config.envVars,
        NODE_ENV: "production",
      })
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `--build-arg ${sq(`${k}=${v}`)}`)
        .join(" ");
      const labelArgs = Object.entries(
        this.labels({ projectId: config.projectId, sessionId: config.sessionId }),
      )
        .map(([k, v]) => `--label ${sq(`${k}=${v}`)}`)
        .join(" ");
      const dockerfileFlag =
        buildContext.dockerfileName && buildContext.dockerfileName !== "Dockerfile"
          ? ` -f ${sq(buildContext.dockerfileName)}`
          : "";

      // `cd` into the context dir FIRST so docker resolves `-f` and the
      // context `.` from the same place. Without this prefix, BuildKit
      // resolves `-f Dockerfile.openship` against the shell's cwd (the
      // SSH user's home, typically /root), not the context - and we hit
      // "no such file or directory: Dockerfile.openship" even though the
      // file is right there in the context dir on disk.
      //
      // Using `cd && docker build .` keeps the context an absolute path
      // for clarity in the log AND ensures the dockerfile lookup is
      // relative to the right directory.
      const buildCmd =
        `cd ${sq(remoteContextDir)} && ` +
        `docker build -t ${sq(tag)}${dockerfileFlag} ` +
        `${labelArgs} ${buildArgs} --force-rm .`;

      log.log(`Running on remote: ${buildCmd}`);
      log.log("─── docker build output ───");

      this.emitDockerStep(log, "install", "running", "Running install inside container (docker build)");

      const { code } = await executor.streamExec(buildCmd, (entry) => {
        // Pass docker's real output straight through. No filtering -
        // the user wants to see what docker says, not our interpretation
        // of it.
        log.log(entry.message, parseLogLevel(entry.message));
      });

      log.log("─── end docker build output ───");

      if (code !== 0) {
        throw new Error(`docker build exited with code ${code}`);
      }

      this.emitDockerStep(log, "install", "completed", "Image build finished");
    } finally {
      // Always clean up the remote context - even on failure. Don't
      // await - if cleanup fails we still want the build result.
      executor
        .exec(`rm -rf ${sq(remoteContextDir)}`)
        .catch(() => { /* best effort */ });
      await buildContext.cleanup();
    }
  }

  /**
   * Dockerode build path. Used for local socket and TCP transports, plus
   * SSH transports that didn't get an executor wired in (shouldn't happen
   * in normal operation but kept as a safety net).
   *
   * This path is slower for SSH (HTTP-over-SSH upload has no streaming),
   * but it's correct for local/TCP where there's no separate SSH
   * connection to piggyback on.
   */
  private async buildViaDockerode(
    config: BuildConfig,
    buildContext: Awaited<ReturnType<typeof createDockerBuildContext>>,
    tag: string,
    log: BuildLogger,
  ): Promise<void> {
    log.log(`Streaming build context to Docker daemon - image tag: ${tag}`);

    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.buildImage(
        { context: buildContext.contextDir, src: buildContext.contextEntries },
        {
          t: tag,
          dockerfile: buildContext.dockerfileName,
          labels: this.labels({ projectId: config.projectId, sessionId: config.sessionId }),
          buildargs: {
            ...config.envVars,
            NODE_ENV: "production",
          },
          forcerm: true,
        },
      );
    } finally {
      await buildContext.cleanup();
    }

    log.log("Connected to Docker daemon. Build output follows:");
    let fatalBuildError: string | null = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let keepaliveTimer: NodeJS.Timeout | null = null;
      let idleMinutes = 0;

      const clearTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
        idleMinutes = 0;
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        (stream as any).destroy?.(error);
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve();
      };

      const resetIdleTimer = () => {
        clearTimers();
        keepaliveTimer = setInterval(() => {
          idleMinutes += 1;
          log.log(`Still building... (no output for ${idleMinutes}m)`);
        }, 60_000);
        if ((keepaliveTimer as any).unref) (keepaliveTimer as any).unref();

        idleTimer = setTimeout(() => {
          fail(new Error(
            "Docker build produced no output for 15 minutes. This usually means the remote server cannot reach the package registry, has broken DNS, or the Docker daemon stalled during the build.",
          ));
        }, DOCKER_BUILD_IDLE_TIMEOUT_MS);
        if ((idleTimer as any).unref) (idleTimer as any).unref();
      };

      resetIdleTimer();

      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) { fail(err); return; }
          succeed();
        },
        (event) => {
          resetIdleTimer();
          fatalBuildError ??= this.handleBuildEvent(event, log);
        },
      );
    });

    log.log("Docker daemon finished streaming build output. Finalizing image...\n");

    if (fatalBuildError) {
      throw new Error(fatalBuildError);
    }
  }

  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();
    const startTime = Date.now();
    const tag = this.imageTag(config.slug, config.sessionId);

    try {
      log.log(`Build strategy: docker (${this.transport.description})\n`);

      // Ensure the host is provisioned for Docker, but avoid doing a second
      // SSH bridge handshake before the real build request. The build call
      // itself is the connectivity check and saves one full round-trip.
      try {
        await this.ensureDockerFeature(log);
      } catch (featureErr) {
        throw new Error(this.formatDockerConnectivityError(featureErr));
      }

      this.emitDockerStep(log, "clone", "running", "Preparing Docker build context...");

      const buildContext = await createDockerBuildContext(config, {
        requireRepositoryDockerfile: config.stack === "docker",
      });

      // Report the size of the context so users know what they're paying
      // for over the SSH wire. Failure here is non-fatal - the build can
      // still proceed if we couldn't `du`.
      try {
        const sizeBytes = await this.estimateContextSize(buildContext.contextDir);
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
        this.emitDockerStep(
          log,
          "clone",
          "completed",
          `Docker build context ready (${sizeMB} MB)`,
        );
      } catch {
        this.emitDockerStep(log, "clone", "completed", "Docker build context ready");
      }

      if (buildContext.rootDirectory) {
        log.log(`Using Docker build root: ${buildContext.rootDirectory}`);
      }

      if (buildContext.usesRepositoryDockerfile) {
        this.emitDockerStep(
          log,
          "install",
          "skipped",
          "Repository Dockerfile owns dependency installation",
        );
        this.emitDockerStep(
          log,
          "build",
          "running",
          "Building image from repository Dockerfile...",
        );
      }

      if (!buildContext.usesRepositoryDockerfile && !config.installCommand) {
        this.emitDockerStep(log, "install", "skipped", "No install command configured");
      }
      if (!buildContext.usesRepositoryDockerfile && !config.buildCommand) {
        this.emitDockerStep(log, "build", "skipped", "No build command configured");
      }

      const sshExecutor =
        this.transport.kind === "ssh" ? this.connectionOptions?.executor : null;

      if (sshExecutor) {
        // ── Fast SSH path ──────────────────────────────────────────────
        // Bypass dockerode for the upload - it tars and POSTs the context
        // as one HTTP body through SSH-tunneled-HTTP, which is ~1-2 MB/s.
        // Instead: use the same tar-over-SSH pipe bare deploys use (with
        // per-3s `~X% · Y MB sent · Z MB/s` progress), then run native
        // `docker build` on the remote so its real stdout/stderr streams
        // back uninterpreted.
        await this.buildViaSshTarPipe(config, buildContext, tag, log);
      } else {
        // ── Dockerode path (local socket, TCP, or SSH without executor) ─
        await this.buildViaDockerode(config, buildContext, tag, log);
      }

      try {
        await this.docker.getImage(tag).inspect();
      } catch {
        throw new Error(`Docker build finished but the image ${tag} was not created`);
      }

      log.log(`Image ${tag} is ready.\n`);
      log.log(`[build] ✓ Image ${tag} ready`);
      log.step("build", "completed", `Finalizing image ${tag}`);
      const durationMs = Date.now() - startTime;
      return { sessionId: config.sessionId, status: "deploying", imageRef: tag, durationMs };
    } catch (err) {
      const msg = safeErrorMessage(err);
      log.step("build", "failed", `Docker build failed: ${msg}`);
      return { sessionId: config.sessionId, status: "failed", durationMs: Date.now() - startTime, errorMessage: `Docker build failed: ${msg}` };
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    // Attempt to find and kill the build container by label
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`openship.build=${sessionId}`] },
    });
    for (const c of containers) {
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
      } catch { /* already removed */ }
    }
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult> {
    const log = onLog ?? (() => {});
    const imageRef = config.imageRef;
    if (!imageRef) {
      throw new Error("Docker deploy requires an imageRef (built image tag)");
    }

    const containerName = `openship-${config.runtimeName || config.projectId}-${config.deploymentId}`;

    // Environment variables
    const env = [
      `PORT=${config.port}`,
      `NODE_ENV=${config.environment === "production" ? "production" : "development"}`,
      ...Object.entries(config.envVars).map(([k, v]) => `${k}=${v}`),
    ];

    // Start command - if provided, split into Cmd array
    const cmd = config.startCommand
      ? ["sh", "-c", config.startCommand]
      : undefined;

    const restartPolicy = resolveRestartPolicy(config.restartPolicy);

    log({
      timestamp: new Date().toISOString(),
      message: `Creating container ${containerName} from ${imageRef}...\n`,
      level: "info",
    });

    const container = await this.docker.createContainer({
      name: containerName,
      Image: imageRef,
      Cmd: cmd,
      Env: env,
      Labels: this.labels({
        deploymentId: config.deploymentId,
        projectId: config.projectId,
      }),
      ExposedPorts: { [`${config.port}/tcp`]: {} },
      HostConfig: {
        RestartPolicy: restartPolicy,
        Memory: config.resources.memoryMb * 1024 * 1024,
        CpuShares: Math.round(config.resources.cpuCores * 1024),
        // Expose port for Nginx upstream routing or direct access
        PortBindings: {
          [`${config.port}/tcp`]: [{ HostPort: "" }], // random host port
        },
      },
    });

    await container.start();

    log({
      timestamp: new Date().toISOString(),
      message: `Container ${container.id.slice(0, 12)} started.\n`,
      level: "info",
    });

    return {
      deploymentId: config.deploymentId,
      containerId: container.id,
      status: "running",
    };
  }

  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.stop();
  }

  async start(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async restart(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.restart();
  }

  async removeImage(imageRef: string): Promise<void> {
    const image = this.docker.getImage(imageRef);
    await image.remove({ force: true });
  }

  async destroy(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force: true });
  }

  // ── Rollback primitives ──────────────────────────────────────────────
  //
  // Docker semantics:
  //   makeActive — prefer `start` of the retained container (fast,
  //     preserves PID/state). If the container was GC'd but the image
  //     is still tagged, `run` from imageRef to provision a fresh
  //     container. Stop the previous active as part of the swap.
  //   archive   — `docker stop`. Image stays tagged. Container kept
  //     for fast restart on later makeActive.
  //   purge     — `docker rm` (force) + `docker rmi`. Past this point
  //     rollback to this deployment is impossible.

  async makeActive(input: RollbackInput): Promise<MakeActiveResult> {
    // 1) Stop the currently-active deployment (if any) so we don't have
    //    two containers serving the same port. Errors here are non-fatal
    //    — if the previous container is already gone the swap continues.
    if (input.from?.containerId) {
      try {
        await this.stop(input.from.containerId);
      } catch {
        // already stopped / gone — ignore
      }
    }

    // 2) Try fast-start the target's existing container.
    if (input.to.containerId) {
      try {
        await this.start(input.to.containerId);
        return { containerId: input.to.containerId };
      } catch {
        // container missing — fall through to run-from-image
      }
    }

    // 3) Container is gone but image is still tagged: provision a fresh
    //    container from the retained image. Same parameters the original
    //    deploy used — but we don't have the full DeployConfig here, so
    //    we use minimal defaults. If the orchestrator needs richer
    //    re-provisioning it can call `deploy()` instead.
    if (!input.to.imageRef) {
      throw new Error(
        `Cannot make deployment ${input.to.id} active: container is gone and no imageRef is stored. Artifact has been purged.`,
      );
    }
    const container = await this.docker.createContainer({
      Image: input.to.imageRef,
      name: `dep-${input.to.id}`,
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    });
    await container.start();
    return { containerId: container.id };
  }

  async archive(deployment: DeploymentRef): Promise<void> {
    // Docker archive = stop the container. Image + stopped container
    // are preserved on the host until purge.
    if (!deployment.containerId) return; // already archived (no container) or never deployed
    try {
      await this.stop(deployment.containerId);
    } catch {
      // already stopped — ignore
    }
  }

  async purge(deployment: DeploymentRef): Promise<void> {
    // Purge order: remove container first (best-effort), then image.
    // Container removal silently no-ops if already gone — keeps purge
    // idempotent across replays.
    if (deployment.containerId) {
      try {
        await this.destroy(deployment.containerId);
      } catch {
        // already removed
      }
    }
    if (deployment.imageRef) {
      try {
        await this.removeImage(deployment.imageRef);
      } catch {
        // image already removed / not present locally
      }
    }
  }

  /**
   * Inspect a container and return the names of its **named** volumes -
   * the ones that survive `container.remove()` and would otherwise leak.
   * Anonymous volumes are auto-removed with `{ v: true }` and don't need to
   * be enumerated. Bind mounts and tmpfs are skipped (the user manages them
   * outside our control). Returns [] if the container is already gone.
   */
  async inspectNamedVolumes(containerId: string): Promise<string[]> {
    try {
      const container = this.docker.getContainer(containerId);
      const data = await container.inspect();
      const mounts = (data.Mounts ?? []) as Array<{ Type?: string; Name?: string }>;
      return mounts
        .filter((m) => m.Type === "volume" && typeof m.Name === "string" && m.Name.length > 0)
        .map((m) => m.Name as string);
    } catch {
      return [];
    }
  }

  /** Remove a named volume by name. Best-effort - already-gone is fine. */
  async removeVolume(name: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(name);
      await volume.remove({ force: true });
    } catch {
      // Already removed, in-use elsewhere, or doesn't exist.
    }
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();

    const statusMap: Record<string, ContainerInfo["status"]> = {
      running: "running",
      exited: "stopped",
      paused: "stopped",
      restarting: "running",
      dead: "failed",
      created: "stopped",
    };

    const startedAt = data.State.StartedAt;
    const uptimeSeconds = startedAt && data.State.Running
      ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
      : undefined;

    const { ip, hostPort } = extractNetworkInfo(data);

    return {
      containerId,
      status: statusMap[data.State.Status] ?? "stopped",
      ip,
      hostPort,
      uptimeSeconds: uptimeSeconds && uptimeSeconds > 0 ? uptimeSeconds : undefined,
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    const container = this.docker.getContainer(containerId);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: tail ?? 200,
    });

    const raw = stripDockerHeaders(buffer);

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const { timestamp, message } = parseTimestampedLine(line);
        return { timestamp, message, level: parseLogLevel(message) };
      });
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    const container = this.docker.getContainer(containerId);
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      follow: true,
      tail: opts?.tail ?? 100,
    }) as unknown as NodeJS.ReadableStream;

    let destroyed = false;

    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      if (destroyed) return;
      buffer += stripDockerChunkHeader(chunk).toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const { timestamp, message } = parseTimestampedLine(line);
        onLog({ timestamp, message, level: parseLogLevel(message) });
      }
    });

    stream.on("end", () => {
      if (buffer && !destroyed) {
        onLog({ timestamp: new Date().toISOString(), message: buffer, level: parseLogLevel(buffer) });
        buffer = "";
      }
    });

    return () => {
      if (!destroyed) {
        destroyed = true;
        (stream as any).destroy?.();
      }
    };
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    const container = this.docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numCpus = stats.cpu_stats.online_cpus || 1;
    const cpuPercent =
      systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    const memoryMb = (stats.memory_stats.usage ?? 0) / (1024 * 1024);

    let networkRxBytes = 0;
    let networkTxBytes = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        networkRxBytes += iface.rx_bytes ?? 0;
        networkTxBytes += iface.tx_bytes ?? 0;
      }
    }

    let diskBytes = 0;
    if (stats.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        diskBytes += entry.value ?? 0;
      }
    }
    const diskMb = diskBytes / (1024 * 1024);

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryMb: Math.round(memoryMb * 100) / 100,
      diskMb: Math.round(diskMb * 100) / 100,
      networkRxBytes,
      networkTxBytes,
    };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(containerId: string): Promise<string | null> {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();

    for (const net of Object.values(data.NetworkSettings.Networks ?? {})) {
      if (net.IPAddress) return net.IPAddress;
    }
    return null;
  }

  /**
   * Open an interactive PTY shell inside a deployed container. Powers
   * the in-dashboard service terminal — see apps/api/src/modules/service-terminal/.
   *
   * Wire-up: dockerode's `container.exec({Tty: true, AttachStdin: true,
   * AttachStdout: true, AttachStderr: true})` returns an Exec handle.
   * Starting it with `{hijack: true, stdin: true}` gives a single bi-
   * directional Duplex carrying TTY bytes in both directions (when Tty
   * is true, stderr is merged into stdout — exactly what xterm expects).
   *
   * The returned ShellSession matches SshExecutor.openShell so the
   * websocket bridge in service-terminal.controller.ts is identical
   * across Docker + Cloud + SSH callers.
   */
  async openServiceShell(
    containerId: string,
    opts?: ShellOptions,
  ): Promise<ShellSession> {
    const container = this.docker.getContainer(containerId);
    const cols = clampShellWindow(opts?.cols, 80, 1, 1000);
    const rows = clampShellWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    // Probe shell availability: prefer bash, fall back to sh. Both
    // are safe to invoke as `cmd -c env-prefix exec target-shell` so
    // the chosen shell ends up as PID 1 of the exec (clean exit
    // semantics — closing stdin from the WS terminates the shell).
    const inspect = await container.inspect().catch(() => null);
    if (!inspect?.State.Running) {
      throw new Error(
        `Container ${containerId} is not running (status: ${inspect?.State.Status ?? "unknown"})`,
      );
    }

    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ["/bin/sh", "-lc", "exec $(command -v bash || echo /bin/sh)"],
      Env: [`TERM=${term}`],
    });

    // `hijack: true` lifts the underlying TCP connection out of HTTP
    // and gives us a raw Duplex. With Tty:true the stream carries the
    // PTY bytes without dockerode's multiplexing frame header.
    const duplex = (await exec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    })) as import("node:stream").Duplex;

    // Set the initial window. Dockerode's resize() POSTs
    // /exec/{id}/resize?h={rows}&w={cols}. Safe to call before any
    // data flows.
    try {
      await exec.resize({ h: rows, w: cols });
    } catch {
      // ignore — the shell will still work at its default size
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    duplex.on("data", (chunk: Buffer) => stdout.write(chunk));
    duplex.on("end", () => {
      stdout.end();
      stderr.end();
    });
    duplex.on("error", () => {
      stdout.end();
      stderr.end();
    });

    const stdin = new Writable({
      write(chunk, _enc, cb) {
        duplex.write(chunk, (err) => cb(err ?? undefined));
      },
      final(cb) {
        try {
          duplex.end();
        } catch {
          // already ended
        }
        cb();
      },
    });

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try {
          cb(code, signal);
        } catch {
          /* listener bug shouldn't kill cleanup */
        }
      }
    };

    duplex.on("close", () => {
      // Best-effort exit-code lookup. exec.inspect() returns the code
      // for a finished exec; null/undefined means we couldn't reach
      // dockerd in time (network blip, container gone) — surface as -1.
      exec
        .inspect()
        .then((info) => fireClose(info.ExitCode ?? null))
        .catch(() => fireClose(null));
    });

    return {
      stdin,
      stdout,
      stderr,
      setWindow: (c, r) => {
        const sc = clampShellWindow(c, 80, 1, 1000);
        const sr = clampShellWindow(r, 24, 1, 500);
        // resize() returns a promise we deliberately ignore — the WS
        // bridge calls this on every resize event, swallowing the
        // promise prevents an unhandled rejection if the exec has
        // already exited.
        void exec.resize({ h: sr, w: sc }).catch(() => undefined);
      },
      close: (_signal?: string) => {
        try {
          duplex.end();
        } catch {
          /* already ended */
        }
        try {
          duplex.destroy();
        } catch {
          /* already destroyed */
        }
      },
      onClose: (cb) => {
        closeListeners.push(cb);
      },
    };
  }

  // ── Compose / multi-service ────────────────────────────────────────────

  /**
   * Ensure a project-level Docker network exists.
   * All services in a compose project share this network and can
   * reach each other by service name as hostname.
   */
  async ensureNetwork(slug: string): Promise<string> {
    const networkName = `openship-${slug}`;
    const networks = await this.docker.listNetworks({
      filters: { name: [networkName] },
    });

    // listNetworks does substring matching, verify exact name
    const existing = networks.find((n) => n.Name === networkName);
    if (existing) return existing.Id;

    const network = await this.docker.createNetwork({
      Name: networkName,
      Driver: "bridge",
      Labels: { "openship.network": slug },
    });
    return network.id;
  }

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
  }): Promise<MultiServiceGroupHandle> {
    void config.deploymentId;
    void config.projectId;
    return { id: await this.ensureNetwork(config.slug) };
  }

  /** Remove a project network (best-effort). */
  async removeNetwork(slug: string): Promise<void> {
    const networkName = `openship-${slug}`;
    try {
      const network = this.docker.getNetwork(networkName);
      await network.remove();
    } catch {
      // Already removed or doesn't exist - fine
    }
  }

  /**
   * Deploy a single service container on a project network.
   * Unlike `deploy()` which binds to a random host port,
   * service containers join the project network with their service name as hostname.
   * External port bindings are only created for services that explicitly expose ports.
   */
  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    const log = onLog ?? (() => {});
    const containerName = `openship-${config.slug}-${config.serviceName}`;

    // Stop and remove any existing container with the same name
    try {
      const existing = this.docker.getContainer(containerName);
      await existing.remove({ force: true });
    } catch {
      // Does not exist - fine
    }

    // Environment variables
    const env = Object.entries(config.environment).map(([k, v]) => `${k}=${v}`);

    // Command
    const cmd = config.command
      ? ["sh", "-c", config.command]
      : undefined;

    // Port bindings
    const { exposedPorts, portBindings } = parsePortBindings(config.ports);

    // Parse volumes: pass through directly - Docker handles named volumes and bind mounts
    const binds = config.volumes.length > 0 ? config.volumes : undefined;

    const restartPolicy = resolveRestartPolicy(config.restart);

    log({
      timestamp: new Date().toISOString(),
      message: `Creating service container ${containerName} from ${config.image}...\n`,
      level: "info",
    });

    // Pull image if not local
    if (!config.image.startsWith("openship/")) {
      try {
        log({
          timestamp: new Date().toISOString(),
          message: `Pulling image ${config.image}...\n`,
          level: "info",
        });
        const stream = await this.docker.pull(config.image);
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (err) {
        log({
          timestamp: new Date().toISOString(),
          message: `Failed to pull ${config.image}: ${err}\n`,
          level: "error",
        });
        throw err;
      }
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: config.image,
      Cmd: cmd,
      Env: env,
      Hostname: config.serviceName,
      Labels: {
        ...this.labels({
          deploymentId: config.deploymentId,
          projectId: config.projectId,
        }),
        "openship.service": config.serviceName,
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        RestartPolicy: restartPolicy,
        ...(config.resources?.memoryMb && {
          Memory: config.resources.memoryMb * 1024 * 1024,
        }),
        ...(config.resources?.cpuCores && {
          CpuShares: Math.round(config.resources.cpuCores * 1024),
        }),
        PortBindings: portBindings,
        Binds: binds,
        NetworkMode: group.id,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [group.id]: {
            Aliases: [config.serviceName],
          },
        },
      },
    });

    try {
      await container.start();
    } catch (startErr) {
      // Clean up the created container so it doesn't become orphaned
      try { await container.remove({ force: true }); } catch { /* best effort */ }
      throw startErr;
    }

    // Get container IP on the project network
    const data = await container.inspect();
    const { ip, hostPort } = extractNetworkInfo(data);

    log({
      timestamp: new Date().toISOString(),
      message: `Service ${config.serviceName} started (${container.id.slice(0, 12)})${ip ? ` at ${ip}` : ""}.\n`,
      level: "info",
    });

    return {
      containerId: container.id,
      status: "running",
      ip,
      hostPort,
    };
  }

  async deployService(
    config: MultiServiceDeployConfig & { networkId: string },
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    return this.deployServiceWorkload({ id: config.networkId }, config, onLog);
  }
}
