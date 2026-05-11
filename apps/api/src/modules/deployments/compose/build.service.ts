/**
 * Compose build service — builds individual service images for a compose project.
 *
 * Each enabled service with a `build` context gets its own Docker image built
 * via the runtime adapter. Services using pre-built images (image-only) are
 * resolved directly without a build step.
 */

import type { MultiServiceRuntimeAdapter, ResourceConfig } from "@repo/adapters";
import { BuildLogger, resolveDockerfileCandidates } from "@repo/adapters";
import { repos, type Deployment, type Project } from "@repo/db";

import { createDockerfileBuildConfig, type BuildConfigSnapshotLike } from "../build-config";
import * as sessionManager from "../session-manager";
import * as githubService from "../../github/github.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeComposeImageName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
}

async function readComposeDockerfileContent(opts: {
  project: Project;
  dep: Deployment;
  context: string;
  dockerfilePath?: string | null;
  serviceName: string;
  logger: BuildLogger;
}): Promise<string | undefined> {
  const { project, dep, context, dockerfilePath, serviceName, logger } = opts;
  if (project.localPath || !project.gitOwner || !project.gitRepo) return undefined;

  const candidates = resolveDockerfileCandidates(context, dockerfilePath);
  const ref = dep.commitSha || dep.branch || project.gitBranch || undefined;
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      logger.log(`Reading Dockerfile "${candidate}" from GitHub.\n`, "info", {
        serviceName,
      });
      const file = await githubService.getFileContent(
        dep.userId,
        project.gitOwner,
        project.gitRepo,
        candidate,
        { branch: ref },
      );
      return file.content;
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `No Dockerfile found for service "${serviceName}". Checked: ${candidates.join(", ")}. ${errors.join("; ")}`,
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposeBuildImagesResult {
  imageRefs: Map<string, string>;
  /** Image/workspace refs created during this build phase, excluding image-only services. */
  builtImageRefs: Map<string, string>;
  buildFailures: Map<string, string>;
  /** Count of image-only (external) services included in imageRefs */
  externalCount: number;
  durationMs: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function buildComposeImages(opts: {
  project: Project;
  dep: Deployment;
  runtime: Pick<MultiServiceRuntimeAdapter, "name" | "build">;
  logger: BuildLogger;
  snapshot: BuildConfigSnapshotLike;
  buildSessionId: string;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  gitToken?: string;
}): Promise<ComposeBuildImagesResult> {
  const services = await repos.service.listByProject(opts.project.id);
  const enabled = services.filter((service) => service.enabled);
  const imageRefs = new Map<string, string>();
  const builtImageRefs = new Map<string, string>();
  const buildFailures = new Map<string, string>();
  const startedAt = Date.now();

  const buildable = enabled.filter((service) => !!service.build);
  const external = enabled.filter((service) => !service.build && !!service.image);

  // ── Broadcast initial per-service status for ALL services ──────────
  // This seeds the UI check-list immediately so users see every service.
  for (const service of enabled) {
    sessionManager.broadcastServiceStatus(opts.dep.id, {
      serviceName: service.name,
      serviceId: service.id,
      status: "pending",
    });
  }

  for (const service of external) {
    if (service.image) {
      imageRefs.set(service.id, service.image);
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "built",
      });
    }
  }

  if (buildable.length > 0) {
    opts.logger.step(
      "build",
      "running",
      `Building ${buildable.length} compose service image${buildable.length === 1 ? "" : "s"}...`,
    );
  } else {
    opts.logger.step(
      "build",
      "completed",
      "Compose services use pre-built images — skipping build phase",
    );
  }

  // ── Build all services in parallel ──────────────────────────────────
  await Promise.all(
    buildable.map(async (service) => {
      const context = service.build ?? opts.snapshot.rootDirectory;
      const dockerfileLabel = service.dockerfile ? ` using ${service.dockerfile}` : "";
      opts.logger.log(
        `Building compose service "${service.name}" from ${context || "."}${dockerfileLabel}...\n`,
        "info",
        {
          serviceName: service.name,
        },
      );

      // Broadcast "building" so the UI shows a spinner for this service
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "building",
      });

      // Per-service logger keeps native terminal bytes intact and routes by
      // serviceName. Inner step events are forwarded as plain service logs;
      // the outer orchestrator owns the top-level step lifecycle.
      const serviceLogger = new BuildLogger((entry) => {
        opts.logger.callback({
          timestamp: entry.timestamp,
          message: entry.message,
          level: entry.level,
          serviceName: service.name,
          rawData: entry.rawData,
        });
      });

      let dockerfileContent: string | undefined;
      if (opts.runtime.name === "cloud") {
        try {
          dockerfileContent = await readComposeDockerfileContent({
            project: opts.project,
            dep: opts.dep,
            context,
            dockerfilePath: service.dockerfile ?? undefined,
            serviceName: service.name,
            logger: opts.logger,
          });
        } catch (err) {
          const failureMessage = err instanceof Error ? err.message : String(err);
          buildFailures.set(service.id, failureMessage);
          opts.logger.log(`Compose service "${service.name}" build failed: ${failureMessage}\n`, "error", {
            serviceName: service.name,
          });
          sessionManager.broadcastServiceStatus(opts.dep.id, {
            serviceName: service.name,
            serviceId: service.id,
            status: "failed",
            error: failureMessage,
          });
          return;
        }
      }

      const buildResult = await opts.runtime.build(
        createDockerfileBuildConfig({
          project: opts.project,
          dep: opts.dep,
          snapshot: opts.snapshot,
          sessionId: `${opts.buildSessionId}-${service.id}`,
          envVars: opts.buildEnvVars,
          resources: opts.buildResources,
          gitToken: opts.gitToken,
          overrides: {
            slug: `${sanitizeComposeImageName(opts.project.slug ?? opts.project.name)}-${sanitizeComposeImageName(service.name)}`,
            rootDirectory: context,
            dockerfilePath: service.dockerfile ?? undefined,
            dockerfileContent,
            hasServer: true,
          },
        }),
        serviceLogger,
      );

      if (buildResult.status === "failed" || !buildResult.imageRef) {
        const failureMessage =
          buildResult.errorMessage ?? `Failed to build service "${service.name}"`;
        buildFailures.set(service.id, failureMessage);
        opts.logger.log(
          `Compose service "${service.name}" build failed: ${failureMessage}\n`,
          "error",
          {
            serviceName: service.name,
          },
        );
        sessionManager.broadcastServiceStatus(opts.dep.id, {
          serviceName: service.name,
          serviceId: service.id,
          status: "failed",
          error: failureMessage,
        });
        return;
      }

      imageRefs.set(service.id, buildResult.imageRef);
      builtImageRefs.set(service.id, buildResult.imageRef);
      opts.logger.log(
        `Compose service "${service.name}" image ready: ${buildResult.imageRef}\n`,
        "info",
        {
          serviceName: service.name,
        },
      );
      sessionManager.broadcastServiceStatus(opts.dep.id, {
        serviceName: service.name,
        serviceId: service.id,
        status: "built",
      });
    }),
  );

  if (buildable.length > 0) {
    const succeeded = imageRefs.size - external.length;
    if (buildFailures.size === 0) {
      opts.logger.step(
        "build",
        "completed",
        `All ${succeeded} service image${succeeded === 1 ? "" : "s"} built successfully`,
      );
      opts.logger.log("Compose image build phase complete. Preparing deployment phase...\n");
    } else if (succeeded > 0) {
      opts.logger.step(
        "build",
        "failed",
        `Built ${succeeded}/${buildable.length} images, but ${buildFailures.size} failed`,
      );
      opts.logger.log(
        "Compose image build phase failed. Deployment will not continue.\n",
        "error",
      );
    } else {
      opts.logger.step(
        "build",
        "failed",
        `All ${buildFailures.size} service image builds failed`,
      );
      opts.logger.log("Compose image build phase failed. Deployment will not continue.\n", "error");
    }
  }

  return {
    imageRefs,
    builtImageRefs,
    buildFailures,
    externalCount: external.length,
    durationMs: Date.now() - startedAt,
  };
}
