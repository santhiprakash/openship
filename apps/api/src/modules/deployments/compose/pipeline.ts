/**
 * Project service pipeline - orchestrates the full build/deploy lifecycle for
 * projects with child services. Compose is one importer for those services.
 *
 * This is the service equivalent of the single-app pipeline that lives
 * in build.service.ts. It coordinates:
 *   1. Per-service image builds  (compose/build.service)
 *   2. Multi-container deployment (compose/deploy.service)
 *   3. Lifecycle hooks            (shared deployment-lifecycle)
 *
 * Called from build.service.ts when the project has saved services or a deploy
 * request includes parsed compose services.
 */

import { repos } from "@repo/db";
import type { Deployment, Project } from "@repo/db";
import type {
  ResourceConfig,
  MultiServiceRuntimeAdapter,
  RoutingProvider,
  SslProvider,
} from "@repo/adapters";
import { BuildLogger } from "@repo/adapters";

import type { BuildConfigSnapshotLike } from "../build-config";
import {
  cleanupBuildArtifact,
  onFailure,
  onSuccess,
  type LifecycleContext,
} from "../deployment-lifecycle";
import * as sessionManager from "../session-manager";
import type { DeployableService } from "../../../lib/deployable-service";
import { internalApiUrl } from "../../../config";

import { buildComposeImages } from "./build.service";
import { deployComposeServices } from "./deploy.service";
import { safeErrorMessage } from "@repo/core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposePipelineOpts {
  project: Project;
  dep: Deployment;
  runtime: MultiServiceRuntimeAdapter;
  routing: RoutingProvider;
  ssl: SslProvider;
  usesManagedRouting: boolean;
  logger: BuildLogger;
  ctx: LifecycleContext;
  snapshot: BuildConfigSnapshotLike & { composeServices?: DeployableService[]; serverId?: string };
  buildSessionId: string;
  buildEnvVars: Record<string, string>;
  buildResources: ResourceConfig;
  runtimeResources: ResourceConfig;
  gitToken?: string;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Run the full service pipeline: build service images, then deploy containers.
 *
 * Handles its own success/failure lifecycle - callers should return immediately
 * after this function completes.
 */
export async function executeComposePipeline(opts: ComposePipelineOpts): Promise<void> {
  const {
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
    buildEnvVars,
    buildResources,
    runtimeResources,
    gitToken,
  } = opts;

  // ── Build phase: produce an image for each buildable service ───────
  const composeBuild = await buildComposeImages({
    project,
    dep,
    runtime,
    logger,
    snapshot,
    buildSessionId,
    buildEnvVars,
    buildResources,
    gitToken,
  });

  // ── Transition to deploy phase ─────────────────────────────────────
  if (composeBuild.buildFailures.size > 0) {
    logger.log(
      `Build phase completed with ${composeBuild.buildFailures.size} failed service image${composeBuild.buildFailures.size === 1 ? "" : "s"}. Deploying available services...\n`,
      "warn",
    );
  } else {
    logger.log("Build phase complete. Starting project service deployment...\n");
  }
  await repos.deployment.updateStatus(dep.id, "deploying", {
    buildDurationMs: composeBuild.durationMs,
  });
  sessionManager.updateStatus(dep.id, "deploying");

  // ── Deploy phase: spin up containers on the shared network ─────────
  const composeResult = await deployComposeServices(project, dep, runtime, logger, {
    builtImages: composeBuild.imageRefs,
    buildFailures: composeBuild.buildFailures,
    resources: runtimeResources,
    buildSessionId,
    routing,
    ssl,
    usesManagedRouting,
    serverId: snapshot.serverId,
    routeOptions: project.webhookDomain
      ? {
          webhookDomain: project.webhookDomain,
          webhookProxy: `${internalApiUrl}/api/webhooks/`,
        }
      : undefined,
  });

  // ── Lifecycle: success or failure ──────────────────────────────────
  if (composeResult.status === "failed") {
    for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
      await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
        const detail = safeErrorMessage(err);
        logger.log(`Warning: failed to clean up built service image ${serviceId}: ${detail}\n`, "warn");
      });
    }
    await onFailure(ctx, composeResult.error ?? "Compose deploy failed", composeBuild.durationMs);
    return;
  }

  const deployedServiceIds = new Set(
    composeResult.services
      .filter((service) => service.containerId)
      .map((service) => service.serviceId),
  );
  for (const [serviceId, imageRef] of composeBuild.builtImageRefs) {
    if (deployedServiceIds.has(serviceId)) continue;
    await cleanupBuildArtifact(runtime, imageRef).catch((err) => {
      const detail = safeErrorMessage(err);
      logger.log(`Warning: failed to clean up unused service image ${serviceId}: ${detail}\n`, "warn");
    });
  }

  const primary = composeResult.services.find((s) => s.containerId);
  await onSuccess(ctx, {
    containerId: primary?.containerId ?? "compose",
    url: composeResult.publicUrl,
    durationMs: composeBuild.durationMs,
    warningMessage: composeResult.warning,
    metaPatch: {
      composeDeployment: {
        totalServices: composeResult.summary.total,
        successfulServices: composeResult.summary.successful,
        failedServices: composeResult.summary.failed,
        failedServiceNames: composeResult.summary.failedServices,
        warningMessage: composeResult.warning,
      },
    },
  });
}


