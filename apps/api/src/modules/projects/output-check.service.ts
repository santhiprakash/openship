import { posix as pathPosix } from "node:path";
import { repos } from "@repo/db";
import { BareRuntime, type BuildLogger } from "@repo/adapters";
import { resolveDeploymentRuntime, type OutputCheckResult } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { resolveProjectRouteState } from "../domains/project-route.service";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import { auditStaticOutput } from "../deployments/output-audit.service";

const silentLogger = { log() {} } as unknown as BuildLogger;

/**
 * On-demand static-output audit for a project's LIVE deployment — the file-side
 * twin of checkProjectPorts. Confirms each routed path actually serves output
 * (catches a wrong Output Directory or a per-domain path with no matching
 * subdir → a silent 404). Advisory: returns [] (no hint) whenever there's
 * nothing to probe.
 *
 * Scope: STATIC apps only (`!hasServer`) — server apps have a listening port,
 * which the port check covers. Live signal is bare self-hosted only; cloud
 * Pages deletes its build workspace post-deploy (no exec surface), so it
 * returns [] and relies on the deploy-time output validation instead.
 */
export async function checkProjectOutput(
  ctx: RequestContext,
  projectId: string,
): Promise<OutputCheckResult[]> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  if (project.hasServer) return [];
  if (!project.activeDeploymentId) return [];

  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  if (!deployment || !deployment.containerId) return [];

  try {
    const { runtime } = await resolveDeploymentRuntime(deployment);
    // Only bare self-hosted static exposes a post-deploy file surface. Cloud
    // Pages' workspace is gone (containerId = page:<slug>), so there's nothing
    // to probe — deploy-time validation already guarantees the Page root.
    if (!(runtime instanceof BareRuntime)) return [];

    // Served root mirrors bare.ts deployStatic + route-registration exactly:
    //   staticRoot = resolveStaticRoot(workDir, outputDirectory)
    //   servedPath = targetPath === "/" ? staticRoot : join(staticRoot, targetPath.slice(1))
    const staticRoot = runtime.resolveStaticRoot(deployment.containerId, project.outputDirectory ?? "");
    const routeState = await resolveProjectRouteState(project);
    const seen = new Set<string>();
    const targets: Array<{ path: string; servedPath: string }> = [];
    for (const endpoint of routeState.publicEndpoints) {
      const path = normalizeTargetPath(endpoint.targetPath) ?? "/";
      if (seen.has(path)) continue;
      seen.add(path);
      const servedPath = path === "/" ? staticRoot : pathPosix.join(staticRoot, path.slice(1));
      targets.push({ path, servedPath });
    }
    if (targets.length === 0) targets.push({ path: "/", servedPath: staticRoot });

    return await auditStaticOutput(runtime, deployment.containerId, targets, silentLogger);
  } catch {
    return [];
  }
}
