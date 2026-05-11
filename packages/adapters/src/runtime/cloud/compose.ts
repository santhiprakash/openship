import type { Oblien, WorkspaceHandle } from "oblien";

import { DEFAULT_RESOURCE_CONFIG, type LogCallback, type ResourceConfig } from "../../types";
import type { WorkspaceRuntimePlan } from "../../dockerfile";
import { sq, type BuildLogger } from "../build-pipeline";
import type {
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  MultiServiceGroupHandle,
} from "../types";

type CloudWorkspaceRuntime = Awaited<ReturnType<WorkspaceHandle["runtime"]>>;

export interface CloudBuiltArtifact {
  workspaceId: string;
  runtime: WorkspaceRuntimePlan;
}

interface CloudComposeServiceState {
  serviceName: string;
  workspaceId: string;
  ip?: string;
  ports: number[];
}

interface CloudComposeGroupState {
  id: string;
  resources?: ResourceConfig;
  services: Map<string, CloudComposeServiceState>;
}

interface CloudComposeSupportDeps {
  client: Oblien;
  builtArtifacts: Map<string, CloudBuiltArtifact>;
  workspace(workspaceId: string): WorkspaceHandle;
  provisionWorkspace(
    config: {
      name: string;
      image: string;
      mode: "temporary" | "permanent";
      resources: ResourceConfig;
      env?: Record<string, string>;
      ttl?: string;
    },
    logger: BuildLogger,
  ): Promise<{ workspaceId: string; runtime: CloudWorkspaceRuntime }>;
  execAndStream(
    runtime: CloudWorkspaceRuntime,
    command: string[],
    onLog: LogCallback,
    timeoutSeconds?: number,
  ): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function toEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function firstContainerPort(portSpecs: string[]): number | undefined {
  for (const spec of portSpecs) {
    const clean = spec.trim();
    if (!clean) continue;
    const parts = clean.split(":");
    const raw = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
    const match = raw?.match(/^(\d+)(?:\/(?:tcp|udp))?$/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function restartPolicyForWorkload(policy?: string): "always" | "on-failure" | "never" {
  if (policy === "no" || policy === "never") return "never";
  if (policy === "on-failure") return "on-failure";
  return "always";
}

function exposeTarget(port: number, serviceName: string, slug?: string, domain = "opsh.io") {
  const service = `service "${serviceName}" on port ${port}`;
  return slug ? `${service} for slug "${slug}" (${slug}.${domain})` : service;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

async function withCloudOperationTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 300_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CloudComposeSupport {
  private readonly groups = new Map<string, CloudComposeGroupState>();

  constructor(private readonly deps: CloudComposeSupportDeps) {}

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
    resources?: ResourceConfig;
  }): Promise<MultiServiceGroupHandle> {
    const id = `cloud-compose:${config.deploymentId}`;
    if (!this.groups.has(id)) {
      this.groups.set(id, {
        id,
        resources: config.resources,
        services: new Map(),
      });
    }
    return { id };
  }

  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    const log = onLog ?? (() => {});
    const groupState = this.groups.get(group.id) ?? {
      id: group.id,
      services: new Map<string, CloudComposeServiceState>(),
    };
    this.groups.set(group.id, groupState);

    const builtArtifact = this.deps.builtArtifacts.get(config.image);
    let workspaceId: string | undefined;

    try {
      workspaceId =
        builtArtifact?.workspaceId ?? (await this.createImageServiceWorkspace(config, log));
      const ws = this.deps.workspace(workspaceId);

      await withCloudOperationTimeout(
        ws.lifecycle.makePermanent(),
        `Making cloud service "${config.serviceName}" permanent`,
      ).catch((err) => {
        throw new Error(`Failed to make service workspace permanent: ${errorMessage(err)}`);
      });
      const runtimeEnv = {
        ...(builtArtifact?.runtime.env ?? {}),
        ...config.environment,
      };
      const port =
        config.publicPort ?? firstContainerPort(config.ports) ?? builtArtifact?.runtime.exposedPort;
      const workdir = builtArtifact?.runtime.workdir ?? "/";
      const startCommand = config.command ?? builtArtifact?.runtime.startCommand;

      log({
        timestamp: now(),
        message: `Deploying cloud service "${config.serviceName}" in workspace ${workspaceId}...\n`,
        level: "info",
      });

      if (startCommand) {
        log({
          timestamp: now(),
          message: `Creating workload for service "${config.serviceName}"...\n`,
          level: "info",
        });
        await withCloudOperationTimeout(
          ws.workloads.delete("app").catch(() => {}),
          `Replacing workload for service "${config.serviceName}"`,
        );
        await withCloudOperationTimeout(
          ws.workloads.create({
            id: "app",
            name: "app",
            cmd: ["sh", "-c", `cd ${sq(workdir)} && ${startCommand}`],
            working_dir: workdir,
            env: [...toEnvArray(runtimeEnv), ...(port ? [`PORT=${port}`] : [])],
            restart_policy: restartPolicyForWorkload(config.restart),
            max_restarts: 10,
          }),
          `Creating workload for service "${config.serviceName}"`,
        );
        log({
          timestamp: now(),
          message: `Workload for service "${config.serviceName}" is ready.\n`,
          level: "info",
        });
      } else {
        log({
          timestamp: now(),
          message: `No command configured for "${config.serviceName}". Using the workspace image default process.\n`,
          level: "warn",
        });
      }

      if (config.expose && port) {
        if (config.customDomain) {
          log({
            timestamp: now(),
            message: `Opening ${exposeTarget(port, config.serviceName, config.publicSlug)}...\n`,
            level: "info",
          });
          await withCloudOperationTimeout(
            ws.network.update({ ingress_ports: [port] }),
            `Opening network port for service "${config.serviceName}"`,
          ).catch((err) => {
            throw new Error(
              `Failed to open ${exposeTarget(port, config.serviceName, config.publicSlug)}: ${errorMessage(err)}`,
            );
          });
          log({
            timestamp: now(),
            message: `Opened ${exposeTarget(port, config.serviceName, config.publicSlug)}.\n`,
            level: "info",
          });
          log({
            timestamp: now(),
            message: `Connecting custom domain "${config.customDomain}" for service "${config.serviceName}"...\n`,
            level: "info",
          });
          await withCloudOperationTimeout(
            ws.domains.connect({ domain: config.customDomain, port }),
            `Connecting custom domain for service "${config.serviceName}"`,
          ).catch((err) => {
            throw new Error(
              `Failed to connect custom domain "${config.customDomain}" for service "${config.serviceName}" on port ${port}: ${errorMessage(err)}`,
            );
          });
          log({
            timestamp: now(),
            message: `Custom domain "${config.customDomain}" connected for service "${config.serviceName}".\n`,
            level: "info",
          });
        } else if (config.publicSlug) {
          log({
            timestamp: now(),
            message: `Exposing ${exposeTarget(port, config.serviceName, config.publicSlug)}...\n`,
            level: "info",
          });
          await withCloudOperationTimeout(
            ws.publicAccess.expose({
              port,
              domain: "opsh.io",
              slug: config.publicSlug,
            }),
            `Exposing public access for service "${config.serviceName}"`,
          ).catch((err) => {
            throw new Error(
              `Failed to expose ${exposeTarget(port, config.serviceName, config.publicSlug)}: ${errorMessage(err)}`,
            );
          });
          log({
            timestamp: now(),
            message: `Exposed ${exposeTarget(port, config.serviceName, config.publicSlug)}.\n`,
            level: "info",
          });
        }
      }

      const ip = await this.resolveWorkspaceIp(ws);
      const ports = [
        ...new Set([
          ...config.ports
            .map((item) => firstContainerPort([item]))
            .filter((item): item is number => typeof item === "number"),
          ...(port ? [port] : []),
        ]),
      ];

      groupState.services.set(config.serviceName, {
        serviceName: config.serviceName,
        workspaceId,
        ip: ip ?? undefined,
        ports,
      });

      await this.syncServiceDiscovery(groupState, log);

      log({
        timestamp: now(),
        message: `Cloud service "${config.serviceName}" started${ip ? ` at ${ip}` : ""}.\n`,
        level: "info",
      });

      return {
        containerId: workspaceId,
        status: "running",
        ip: ip ?? undefined,
        hostPort: port,
      };
    } catch (err) {
      if (workspaceId) {
        groupState.services.delete(config.serviceName);
        await this.deps
          .workspace(workspaceId)
          .delete()
          .catch(() => {});
      }
      throw err;
    }
  }

  private async createImageServiceWorkspace(
    config: MultiServiceDeployConfig,
    onLog: LogCallback,
  ): Promise<string> {
    const resources: ResourceConfig = {
      cpuCores: config.resources?.cpuCores ?? DEFAULT_RESOURCE_CONFIG.cpuCores,
      memoryMb: config.resources?.memoryMb ?? DEFAULT_RESOURCE_CONFIG.memoryMb,
      diskMb: DEFAULT_RESOURCE_CONFIG.diskMb,
    };

    onLog({
      timestamp: now(),
      message: `Creating cloud service "${config.serviceName}" from image "${config.image}"...\n`,
      level: "info",
    });

    let wsData: { id: string };
    try {
      wsData = await this.deps.client.workspaces.create({
        name: `${config.slug}-${config.serviceName}`.slice(0, 60),
        image: config.image,
        mode: "permanent",
        config: {
          cpus: resources.cpuCores,
          memory_mb: resources.memoryMb,
          disk_size_mb: resources.diskMb,
          env: toEnvArray(config.environment),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLog({
        timestamp: now(),
        message: `Failed to create cloud service "${config.serviceName}" from image "${config.image}": ${message}\n`,
        level: "error",
      });
      throw err;
    }

    return wsData.id;
  }

  private async resolveWorkspaceIp(ws: WorkspaceHandle): Promise<string | null> {
    try {
      const network = await ws.network.get();
      if (network.ip) return network.ip;
    } catch {
      // Fall through to workspace metadata.
    }

    const data = await ws.get();
    return ((data as Record<string, unknown>).ip as string | undefined) ?? null;
  }

  private async syncServiceDiscovery(
    group: CloudComposeGroupState,
    onLog: LogCallback,
  ): Promise<void> {
    const services = [...group.services.values()].filter((service) => service.ip);
    if (services.length === 0) return;

    const workspaceIds = [...new Set(services.map((service) => service.workspaceId))];
    const hostsLines = services.map(
      (service) => `${service.ip} ${service.serviceName} # openship-compose:${group.id}`,
    );
    const hostsBlock = hostsLines.join("\n");

    for (const service of services) {
      const ws = this.deps.workspace(service.workspaceId);
      const privateLinks = workspaceIds.filter(
        (workspaceId) => workspaceId !== service.workspaceId,
      );
      if (privateLinks.length > 0) {
        const currentNetwork = await ws.network.get().catch(() => null);
        const currentIngress = Array.isArray(
          (currentNetwork as Record<string, unknown> | null)?.ingress_ports,
        )
          ? ((currentNetwork as Record<string, unknown>).ingress_ports as number[])
          : undefined;
        await ws.network
          .update({
            private_link_ids: privateLinks,
            ...(currentIngress ? { ingress_ports: currentIngress } : {}),
          })
          .catch((err) => {
            onLog({
              timestamp: now(),
              message: `Warning: failed to link private network for "${service.serviceName}": ${err instanceof Error ? err.message : err}\n`,
              level: "warn",
            });
          });
      }

      try {
        const rt = await ws.runtime();
        const script = `set -e
tmp=$(mktemp)
grep -v ' # openship-compose:${group.id}' /etc/hosts > "$tmp" || true
cat >> "$tmp" <<'EOF'
${hostsBlock}
EOF
cat "$tmp" > /etc/hosts
rm -f "$tmp"`;
        await this.deps.execAndStream(rt, ["sh", "-c", script], onLog);
      } catch (err) {
        onLog({
          timestamp: now(),
          message: `Warning: failed to update service discovery for "${service.serviceName}": ${err instanceof Error ? err.message : err}\n`,
          level: "warn",
        });
      }
    }
  }
}
