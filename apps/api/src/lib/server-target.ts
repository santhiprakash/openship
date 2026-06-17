import { repos, type Project } from "@repo/db";
import { env } from "../config/env";

interface DeploymentSnapshotLike {
  serverId?: string;
}

/**
 * Resolve a server's host (IP/hostname) for an org. Refuses to read
 * server rows that belong to a different organization than the caller —
 * defense against a caller smuggling a foreign org's serverId through
 * a request body to route their managed subdomain at another tenant's
 * host.
 *
 * Falls back to env.SERVER_IP when no serverId is supplied.
 */
async function resolveSnapshotServerHost(
  organizationId: string,
  snapshot?: DeploymentSnapshotLike | null,
): Promise<string | null> {
  if (snapshot?.serverId) {
    const server = await repos.server.getInOrganization(
      snapshot.serverId,
      organizationId,
    );
    if (server?.sshHost) return server.sshHost;
    return null;
  }

  return env.SERVER_IP ?? null;
}

export async function resolveServerHost(
  organizationId: string,
  serverId?: string,
): Promise<string | null> {
  return resolveSnapshotServerHost(
    organizationId,
    serverId ? { serverId } : null,
  );
}

export async function resolveProjectServerHost(project?: Project): Promise<string | null> {
  if (!project) return env.SERVER_IP ?? null;

  const deployment = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : await repos.deployment.findLatestByProject(project.id);

  const snapshot = (deployment?.meta ?? null) as DeploymentSnapshotLike | null;
  return resolveSnapshotServerHost(project.organizationId, snapshot);
}
