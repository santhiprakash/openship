/**
 * Compose deploy service — deploys multi-service projects.
 *
 * Instead of building a single image and running one container,
 * compose deployments:
 *   1. Ensure a shared Docker network for the project
 *   2. Deploy each enabled service as a separate container on that network
 *   3. Track per-service container state in serviceDeployment rows
 *   4. Services discover each other by name (hostname = service name)
 */

import { repos, type Deployment, type Domain, type Project, type Service } from "@repo/db";
import { SYSTEM, getProjectType, resolveServiceHostnameLabel, type StackId } from "@repo/core";
import {
  BuildLogger,
  DEFAULT_RESOURCE_CONFIG,
  DockerRuntime,
  runDeployPipeline,
  type DeployConfig,
  type DeployEnvironment,
  type LogEntry,
  type MultiServiceDeployConfig,
  type MultiServiceDeployResult,
  type MultiServiceRuntimeAdapter,
  type ResourceConfig,
  type RouteRegistrationOptions,
  type RoutingProvider,
  type SslProvider,
} from "@repo/adapters";
import { decryptEnvMap } from "../../../lib/encryption";
import {
  buildServiceRouteDomain,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
  type PlannedRouteDomain,
} from "../../../lib/routing-domains";
import { ensureManagedEdgeProxy } from "../../../lib/managed-edge-proxy";
import * as sessionManager from "../session-manager";
import { parseServicePort } from "./domain-helpers";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposeDeployResult {
  status: "ready" | "failed";
  summary: {
    total: number;
    successful: number;
    failed: number;
    failedServices: string[];
  };
  services: Array<{
    serviceId: string;
    serviceName: string;
    containerId?: string;
    status: string;
    ip?: string;
    hostPort?: number;
    error?: string;
  }>;
  warning?: string;
  error?: string;
  publicUrl?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a project is a compose / multi-service project */
export function isComposeProject(project: Project): boolean {
  const framework = project.framework as StackId | undefined;
  if (!framework) return false;
  try {
    return getProjectType(framework) === "services";
  } catch {
    return framework === "docker-compose";
  }
}

/** Topological sort of services by dependsOn — respects dependency order. */
function topoSort(services: Service[]): Service[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const sorted: Service[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(svc: Service) {
    if (visited.has(svc.name)) return;
    if (visiting.has(svc.name)) {
      // Circular dependency — break cycle
      sorted.push(svc);
      visited.add(svc.name);
      return;
    }
    visiting.add(svc.name);
    const deps = (svc.dependsOn as string[]) ?? [];
    for (const depName of deps) {
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }
    visiting.delete(svc.name);
    visited.add(svc.name);
    sorted.push(svc);
  }

  for (const svc of services) {
    visit(svc);
  }
  return sorted;
}

function resolveServicePublicPort(service: Service): number | undefined {
  if (!service.exposed) return undefined;
  return (
    parseServicePort(service.exposedPort ?? undefined) ??
    parseServicePort(((service.ports as string[]) ?? [])[0]) ??
    undefined
  );
}

function resolveServicePublicSlug(project: Project, service: Service): string | undefined {
  if (!service.exposed || service.domainType === "custom") return undefined;
  return resolveServiceHostnameLabel(
    project.slug ?? project.name,
    service.name,
    service.domain ?? undefined,
  );
}

function resolveServiceCustomDomain(service: Service): string | undefined {
  if (!service.exposed || service.domainType !== "custom") return undefined;
  return service.customDomain ?? undefined;
}

function resolveServicePublicUrl(project: Project, service: Service): string | undefined {
  const customDomain = resolveServiceCustomDomain(service);
  if (customDomain) return `https://${customDomain}`;

  const publicSlug = resolveServicePublicSlug(project, service);
  return publicSlug ? `https://${publicSlug}.${SYSTEM.DOMAINS.CLOUD_DOMAIN}` : undefined;
}

function toDeployRestartPolicy(restart?: string): DeployConfig["restartPolicy"] {
  if (restart === "always" || restart === "on-failure" || restart === "no") {
    return restart;
  }
  return "always";
}

function createServicePipelineLogger(parent: BuildLogger, serviceName: string): BuildLogger {
  return new BuildLogger((entry) => {
    // Compose owns the global deploy step. Per-service pipeline step events are
    // intentionally kept out of the shared progress bar.
    if (entry.step && entry.stepStatus) return;
    if (entry.message === "No domains configured — skipping routing for this deployment.\n") {
      return;
    }
    parent.callback({
      ...entry,
      serviceName: entry.serviceName ?? serviceName,
    });
  });
}

function createServiceRuntimeConfig(opts: {
  project: Project;
  dep: Deployment;
  service: Service;
  image: string;
  environment: Record<string, string>;
  resources?: ResourceConfig;
}): MultiServiceDeployConfig {
  const { project, dep, service, image, environment, resources } = opts;
  return {
    deploymentId: dep.id,
    projectId: project.id,
    slug: project.slug,
    serviceName: service.name,
    image,
    ports: (service.ports as string[]) ?? [],
    environment,
    volumes: (service.volumes as string[]) ?? [],
    command: service.command ?? undefined,
    restart: service.restart ?? "unless-stopped",
    resources,
    expose: service.exposed,
    publicPort: resolveServicePublicPort(service),
    publicSlug: resolveServicePublicSlug(project, service),
    customDomain: resolveServiceCustomDomain(service),
  };
}

function createServiceDeployConfig(opts: {
  project: Project;
  dep: Deployment;
  service: Service;
  image: string;
  environment: Record<string, string>;
  resources?: ResourceConfig;
  buildSessionId?: string;
}): DeployConfig {
  const { project, dep, service, image, environment, resources, buildSessionId } = opts;
  return {
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId: buildSessionId ?? dep.id,
    imageRef: image,
    environment: dep.environment,
    port: resolveServicePublicPort(service) ?? 0,
    startCommand: service.command ?? undefined,
    stack: project.framework ?? undefined,
    envVars: environment,
    resources: resources ?? DEFAULT_RESOURCE_CONFIG,
    restartPolicy: toDeployRestartPolicy(service.restart ?? undefined),
    slug: resolveServicePublicSlug(project, service) ?? `${project.slug}-${service.name}`,
    customDomain: resolveServiceCustomDomain(service),
  };
}

interface ServiceRouteContext {
  routing: RoutingProvider;
  trackedSsl: SslProvider;
  usesManagedRouting: boolean;
  userId: string;
  serverId?: string;
  routeOptions?: RouteRegistrationOptions;
  domainByHostname: Map<string, Domain>;
}

async function prepareServiceRoute(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  routeContext?: ServiceRouteContext;
  logger: BuildLogger;
}): Promise<PlannedRouteDomain | null> {
  const { project, service, runtimeName, routeContext, logger } = opts;
  if (!routeContext) return null;

  const route = buildServiceRouteDomain({
    project,
    service,
    runtimeName,
    usesManagedRouting: routeContext.usesManagedRouting,
  });
  if (!route) return null;

  const domainKey = route.hostname.toLowerCase();
  const beforeRecord = routeContext.domainByHostname.get(domainKey);
  const domainRecord = await ensureRouteDomainRecord({
    projectId: project.id,
    route,
    domainByHostname: routeContext.domainByHostname,
  });
  if (!beforeRecord && domainRecord) {
    logger.log(`Created domain record for "${route.hostname}".\n`, "info", {
      serviceName: service.name,
    });
  }

  return route;
}

// ─── Main compose deploy function ────────────────────────────────────────────

/**
 * Deploy all services for a compose project.
 * Called from the compose pipeline after the build phase.
 */
export async function deployComposeServices(
  project: Project,
  dep: Deployment,
  runtime: MultiServiceRuntimeAdapter,
  logger: BuildLogger,
  opts?: {
    builtImages?: Map<string, string>;
    buildFailures?: Map<string, string>;
    resources?: ResourceConfig;
    buildSessionId?: string;
    routing?: RoutingProvider;
    ssl?: SslProvider;
    usesManagedRouting?: boolean;
    userId?: string;
    serverId?: string;
    routeOptions?: RouteRegistrationOptions;
  },
): Promise<ComposeDeployResult> {
  const services = await repos.service.listByProject(project.id);
  const enabled = services.filter((s) => s.enabled);

  if (enabled.length === 0) {
    const hasServices = services.length > 0;
    return {
      status: "failed",
      summary: {
        total: 0,
        successful: 0,
        failed: 0,
        failedServices: [],
      },
      services: [],
      error: hasServices
        ? "All compose services are currently disabled. Re-syncing the compose file should re-enable them."
        : "No compose services were found for this project. Sync the compose file before deploying.",
    };
  }

  // Sort by dependency order
  const ordered = topoSort(enabled);

  logger.step("deploy", "running", `Deploying ${ordered.length} services...`);
  logger.log("Preparing shared service group for compose deployment...\n");

  // 1. Ensure shared runtime group (Docker network or cloud service group)
  const group = await runtime.ensureServiceGroup({
    deploymentId: dep.id,
    projectId: project.id,
    slug: project.slug,
    resources: opts?.resources,
  });
  logger.log(`Service group ready for ${project.slug}.\n`);

  // 2. Load project-level env vars (shared across services)
  const projectEnvMap = await repos.project.getEnvMap(project.id, dep.environment);
  const decryptedProjectEnv = decryptEnvMap(projectEnvMap, (key) => {
    logger.log(`Warning: failed to decrypt project env var "${key}", skipping.\n`, "warn");
  });

  // 3. Decrypt deployment-level env var overrides
  const depEnvVars = dep.envVars as Record<string, string> | null;
  const depEnv = depEnvVars
    ? decryptEnvMap(depEnvVars, (key) => {
        logger.log(`Warning: failed to decrypt deployment env var "${key}", skipping.\n`, "warn");
      })
    : {};

  // 4. Load previous service containers so each service is replaced in-place
  //    instead of tearing down the whole app before the first deploy attempt.
  const previousServiceDeps = project.activeDeploymentId
    ? await repos.service.listByDeployment(project.activeDeploymentId)
    : [];
  const previousByServiceId = new Map(previousServiceDeps.map((row) => [row.serviceId, row]));
  const enabledServiceIds = new Set(enabled.map((svc) => svc.id));
  let routeContext: ServiceRouteContext | undefined;
  if (opts?.routing && opts.ssl && typeof opts.usesManagedRouting === "boolean") {
    const projectDomains = await repos.domain.listByProject(project.id);
    const domainByHostname = new Map(
      projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
    );
    routeContext = {
      routing: opts.routing,
      trackedSsl: createTrackedSslProvider(opts.ssl, domainByHostname),
      usesManagedRouting: opts.usesManagedRouting,
      userId: opts.userId ?? dep.userId,
      serverId: opts.serverId,
      routeOptions: opts.routeOptions,
      domainByHostname,
    };
  }

  // 5. Deploy each service
  const results: ComposeDeployResult["services"] = [];
  let successful = 0;
  let firstPublicUrl: string | undefined;
  const seenRouteDomains = new Set<string>();
  const unavailableServiceNames = new Set<string>();

  for (const svc of ordered) {
    // Ownership guard — ensure this service actually belongs to the project
    if (svc.projectId !== project.id) continue;

    const blockedDependencies = ((svc.dependsOn as string[]) ?? []).filter((dependency) =>
      unavailableServiceNames.has(dependency),
    );
    if (blockedDependencies.length > 0) {
      const message = `Skipped because required service${blockedDependencies.length === 1 ? "" : "s"} ${blockedDependencies.join(", ")} did not deploy.`;
      logger.log(`Service "${svc.name}" skipped: ${message}\n`, "warn", {
        serviceName: svc.name,
      });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
        imageRef: opts?.builtImages?.get(svc.id) ?? svc.image ?? null,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
      unavailableServiceNames.add(svc.name);
      continue;
    }

    // Load service-specific env vars
    const serviceEnvMap = await repos.project.getEnvMap(project.id, dep.environment, svc.id);
    const decryptedServiceEnv = decryptEnvMap(serviceEnvMap, (key) => {
      logger.log(
        `Warning: failed to decrypt env var "${key}" for service "${svc.name}", skipping.\n`,
        "warn",
        {
          serviceName: svc.name,
        },
      );
    });

    // Merge: shared project env → current deploy shared env → service env.
    // Service values intentionally win so the compose UI can override globals per service.
    const mergedEnv: Record<string, string> = {
      ...decryptedProjectEnv,
      ...depEnv,
      ...((svc.environment as Record<string, string>) ?? {}),
      ...decryptedServiceEnv,
    };

    const buildFailure = opts?.buildFailures?.get(svc.id);
    if (buildFailure) {
      logger.log(`Service "${svc.name}" build failed: ${buildFailure}\n`, "error", {
        serviceName: svc.name,
      });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: buildFailure,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
        imageRef: svc.image ?? null,
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: buildFailure,
      });
      unavailableServiceNames.add(svc.name);
      continue;
    }

    const image = opts?.builtImages?.get(svc.id) ?? svc.image ?? "";
    if (!image) {
      const message = `No image available for service "${svc.name}"`;
      logger.log(`${message}\n`, "error", { serviceName: svc.name });
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
      });
      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
      unavailableServiceNames.add(svc.name);
      continue;
    }

    logger.log(`Deploying service "${svc.name}" (${image})...\n`, "info", {
      serviceName: svc.name,
    });

    // Broadcast per-service "deploying" status to SSE subscribers
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: svc.name,
      serviceId: svc.id,
      status: "deploying",
    });

    const serviceRuntimeConfig = createServiceRuntimeConfig({
      project,
      dep,
      service: svc,
      image,
      environment: mergedEnv,
      resources: opts?.resources,
    });
    const serviceDeployConfig = createServiceDeployConfig({
      project,
      dep,
      service: svc,
      image,
      environment: mergedEnv,
      resources: opts?.resources,
      buildSessionId: opts?.buildSessionId,
    });
    let route = await prepareServiceRoute({
      project,
      service: svc,
      runtimeName: runtime.name,
      routeContext,
      logger,
    });
    if (route) {
      const routeKey = route.hostname.toLowerCase();
      if (seenRouteDomains.has(routeKey)) {
        logger.log(
          `Skipping route for service "${svc.name}" — ${route.hostname} is already assigned in this deployment.\n`,
          "warn",
          { serviceName: svc.name },
        );
        route = null;
      } else {
        seenRouteDomains.add(routeKey);
      }
    }
    const routePort = resolveServicePublicPort(svc);
    const proxyRoute = route && runtime.name !== "cloud" && routePort ? route : null;
    if (route && runtime.name !== "cloud" && !routePort) {
      logger.log(
        `Skipping route for service "${svc.name}" — no routable port configured.\n`,
        "warn",
        { serviceName: svc.name },
      );
    }

    let deployedContainerId: string | undefined;
    let deployedContainerCleaned = false;
    try {
      const previous = previousByServiceId.get(svc.id);
      let serviceResult: MultiServiceDeployResult | undefined;
      const serviceLogger = createServicePipelineLogger(logger, svc.name);
      const routeDomains = proxyRoute ? toRoutedDomainInputs([proxyRoute]) : [];
      const deployEnv: DeployEnvironment = {
        activate: async (_cfg, onLog) => {
          const result = await runtime.deployServiceWorkload(
            group,
            serviceRuntimeConfig,
            (entry: LogEntry) =>
              onLog({
                ...entry,
                serviceName: entry.serviceName ?? svc.name,
              }),
          );
          deployedContainerId = result.containerId;
          serviceResult = result;
          return { containerId: result.containerId };
        },
        deactivate: (containerId) => runtime.destroy(containerId),
        resolveTargetUrl:
          proxyRoute && routePort && runtime.supports("containerIp")
            ? async (containerId, port) => {
                const ip =
                  serviceResult?.containerId === containerId
                    ? serviceResult.ip
                    : await runtime.getContainerIp(containerId);
                return ip ? `http://${ip}:${port}` : null;
              }
            : undefined,
      };

      const deployResult = await runDeployPipeline(
        deployEnv,
        {
          config: serviceDeployConfig,
          previousContainerId: previous?.containerId ?? undefined,
          domains: routeDomains,
          routing: routeDomains.length ? routeContext?.routing : undefined,
          ssl: routeDomains.length ? routeContext?.trackedSsl : undefined,
          routeOptions: routeDomains.length ? routeContext?.routeOptions : undefined,
        },
        serviceLogger,
      );

      if (deployResult.status === "failed") {
        if (deployedContainerId) {
          try {
            await runtime.destroy(deployedContainerId);
            deployedContainerCleaned = true;
          } catch (destroyErr) {
            const destroyMessage =
              destroyErr instanceof Error ? destroyErr.message : "Unknown error";
            logger.log(
              `Warning: failed to clean up "${svc.name}" after deploy failure: ${destroyMessage}\n`,
              "warn",
              {
                serviceName: svc.name,
              },
            );
          }
        }
        throw new Error(deployResult.error ?? `Failed to deploy service "${svc.name}"`);
      }

      const result = serviceResult ?? {
        containerId: deployResult.containerId!,
        status: "running",
      };

      // Record service deployment
      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        containerId: result.containerId,
        status: result.status,
        imageRef: image,
        hostPort: result.hostPort ?? null,
        ip: result.ip ?? null,
      });

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        containerId: result.containerId,
        status: result.status,
        ip: result.ip,
        hostPort: result.hostPort,
      });
      successful += 1;

      // Broadcast per-service "running" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "running",
        containerId: result.containerId,
        hostPort: result.hostPort,
      });

      logger.log(`Service "${svc.name}" deployed successfully.\n`, "info", {
        serviceName: svc.name,
      });

      if (
        previous?.imageRef &&
        previous.imageRef !== image &&
        runtime instanceof DockerRuntime
      ) {
        await runtime.removeImage(previous.imageRef).catch((err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          logger.log(
            `Warning: failed to remove previous image for "${svc.name}": ${message}\n`,
            "warn",
            {
              serviceName: svc.name,
            },
          );
        });
      }

      if (
        proxyRoute &&
        routeContext?.usesManagedRouting &&
        proxyRoute.isCloud &&
        proxyRoute.managedSubdomain
      ) {
        logger.log(`Syncing managed edge proxy for ${proxyRoute.hostname}...\n`, "info", {
          serviceName: svc.name,
        });
        await ensureManagedEdgeProxy(routeContext.userId, proxyRoute.managedSubdomain, {
          serverId: routeContext.serverId,
        });
      }

      firstPublicUrl ??= proxyRoute
        ? `https://${proxyRoute.hostname}`
        : runtime.name === "cloud"
          ? resolveServicePublicUrl(project, svc)
          : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (deployedContainerId && !deployedContainerCleaned) {
        await runtime.destroy(deployedContainerId).catch((destroyErr) => {
          const destroyMessage =
            destroyErr instanceof Error ? destroyErr.message : "Unknown error";
          logger.log(
            `Warning: failed to clean up "${svc.name}" after deploy failure: ${destroyMessage}\n`,
            "warn",
            {
              serviceName: svc.name,
            },
          );
        });
      }
      logger.log(`Service "${svc.name}" failed: ${message}\n`, "error", {
        serviceName: svc.name,
      });

      // Broadcast per-service "failed" status to SSE subscribers
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: message,
      });

      await repos.service.createServiceDeployment({
        deploymentId: dep.id,
        serviceId: svc.id,
        status: "failed",
        imageRef: image,
      });

      results.push({
        serviceId: svc.id,
        serviceName: svc.name,
        status: "failed",
        error: message,
      });
      unavailableServiceNames.add(svc.name);
    }
  }

  for (const previous of previousServiceDeps) {
    if (!previous.containerId || enabledServiceIds.has(previous.serviceId)) continue;
    try {
      await runtime.destroy(previous.containerId);
      logger.log(`Stopped disabled service container (${previous.containerId.slice(0, 12)}).\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.log(`Warning: failed to stop disabled service container: ${message}\n`, "warn");
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  const failedNames = failed.map((r) => r.serviceName);
  const warning =
    failed.length > 0
      ? `${failed.length}/${ordered.length} services failed: ${failedNames.join(", ")}`
      : undefined;
  const firstFailure = failed.find((service) => service.error?.trim())?.error;

  if (successful === ordered.length) {
    logger.step("deploy", "completed", `All ${ordered.length} services deployed.`);
  } else if (successful > 0) {
    logger.step(
      "deploy",
      "completed",
      `Deployed ${successful}/${ordered.length} services. ${failed.length} service${failed.length === 1 ? "" : "s"} still need attention.`,
    );
    logger.log(`Deployment completed with warnings: ${warning}\n`, "warn");
  } else {
    logger.step(
      "deploy",
      "failed",
      `${failed.length}/${ordered.length} services failed to deploy.`,
    );
  }

  return {
    status: successful > 0 ? "ready" : "failed",
    summary: {
      total: ordered.length,
      successful,
      failed: failed.length,
      failedServices: failedNames,
    },
    services: results,
    warning,
    error: successful > 0 ? undefined : (firstFailure ?? "No services deployed successfully"),
    publicUrl: firstPublicUrl,
  };
}
