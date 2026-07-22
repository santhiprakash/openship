import { repos } from "@repo/db";
import type { BuildLogger } from "@repo/adapters";
import { resolveDeploymentRuntime, type PortCheckResult } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { resolveProjectRouteState } from "../domains/project-route.service";
import { auditPorts } from "../deployments/port-audit.service";

// auditPorts only ever calls logger.log — a silent sink is enough for an
// on-demand check (nothing is streaming build output here).
const silentLogger = { log() {} } as unknown as BuildLogger;

/**
 * On-demand port-reachability audit for a project's LIVE deployment. Reuses the
 * exact `auditPorts` probe the deploy pipeline runs so the Domains tab can show
 * a FRESH "nothing responded on port X" hint instead of a stale deploy-time
 * snapshot. Advisory only: returns [] (no signal → no hint) whenever there's
 * nothing to probe (no active deployment, no container, runtime can't exec).
 */
export async function checkProjectPorts(
  ctx: RequestContext,
  projectId: string,
): Promise<PortCheckResult[]> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (!project.activeDeploymentId) return [];

  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment) return [];

  // resolveDeploymentRuntime + the probes can throw (target server removed from
  // the org, invalid SSH config, cloud deployment missing an org id). This is an
  // ADVISORY check, so degrade to [] (no hint) rather than surfacing an error.
  try {
    const { runtime } = await resolveDeploymentRuntime(deployment);

    // Compose / multi-service: probe each exposed service inside its OWN live
    // container — the service_deployment rows carry the per-service containerId.
    const serviceDeployments = await repos.serviceDeployment.listByDeployment(deployment.id);
    if (serviceDeployments.length > 0) {
      const services = await repos.service.listByProject(projectId);
      const serviceById = new Map(services.map((s) => [s.id, s]));
      const results: PortCheckResult[] = [];
      for (const sd of serviceDeployments) {
        if (!sd.containerId || !sd.serviceId) continue;
        const svc = serviceById.get(sd.serviceId);
        if (!svc || !svc.exposed) continue;
        const port = Number(svc.exposedPort);
        if (!Number.isFinite(port) || port <= 0) continue;
        const checks = await auditPorts(runtime, sd.containerId, [port], silentLogger);
        for (const check of checks) {
          results.push({ ...check, serviceId: svc.id, serviceName: svc.name });
        }
      }
      return results;
    }

    // Single-app: probe the deployment's container on its public-endpoint ports
    // (the same set the firewall + deploy-time audit use), falling back to port.
    if (!deployment.containerId) return [];
    const routeState = await resolveProjectRouteState(project);
    const ports = Array.from(
      new Set(
        routeState.publicEndpoints
          .map((endpoint) => endpoint.port ?? project.port ?? undefined)
          .filter((port): port is number => Number.isFinite(port as number) && (port as number) > 0),
      ),
    );
    if (ports.length === 0 && project.port) ports.push(project.port);
    if (ports.length === 0) return [];
    return await auditPorts(runtime, deployment.containerId, ports, silentLogger);
  } catch {
    return [];
  }
}
