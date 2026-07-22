/**
 * Pure reconciliation for Docker discovery — NO IO (no SSH, no config, no
 * runtime). Merges inspected containers with declared compose services into a
 * normalized `DiscoveredStack`:
 *
 *   - compose is authoritative for build/source + declared dependsOn
 *   - `docker inspect` is authoritative for runtime truth (resolved named-volume
 *     names, actual published ports, live env, restart policy, health)
 *
 * Kept import-light so it's unit-testable with fixtures (see the IO shell in
 * docker-inspect.service.ts for the SSH/daemon side).
 */

import type {
  DockerContainerDetail,
  DockerMount,
  DockerNetworkInfo,
  DockerPortBinding,
  DockerVolumeInfo,
  ProxyKind,
} from "@repo/adapters";
import { classifyProxy } from "@repo/adapters";
import type { ComposeHealthcheck } from "@repo/core";
import type { ComposeService } from "../../lib/compose-parser";

export interface DiscoveredVolumeMount {
  /** "volume" reuses a named volume in place; "bind" is a host path. */
  type: "volume" | "bind";
  /** Named-volume name (type=volume) or host path (type=bind). */
  source?: string;
  /** Path inside the container. */
  target: string;
  rw: boolean;
}

export interface DiscoveredService {
  /** compose service name, or the container name for a standalone container. */
  name: string;
  /** Where it was discovered — informs how much Openship can reconstruct. */
  source: "compose" | "container";
  containerId?: string;
  containerName?: string;
  running: boolean;
  image?: string;
  /** compose build context (set → adoption builds this Dockerfile). */
  build?: string;
  dockerfile?: string;
  /** compose-style "host:container[/proto]" strings, from actual bindings. */
  ports: string[];
  env: Record<string, string>;
  volumes: DiscoveredVolumeMount[];
  networks: string[];
  dependsOn: string[];
  command?: string;
  restart?: string;
  healthcheck?: ComposeHealthcheck;
  /** Reverse-proxy kind when this container IS the edge proxy (image/command
   *  matches AND it binds a host edge port). Openship's OpenResty replaces it,
   *  so it's dropped from import — importing it is the 80/443 conflict. */
  proxyKind?: ProxyKind;
  /** Host edge ports (80/443) this service publishes. Reserved for OpenResty:
   *  stripped from an imported non-proxy service; the signal that a proxy owns
   *  the edge. */
  edgePorts?: number[];
  warnings: string[];
}

/** Services grouped by origin — a compose project, or standalone (`project: null`). */
export interface DiscoveredGroup {
  /** compose project name, or null for hand-run containers. */
  project: string | null;
  services: DiscoveredService[];
}

export interface DiscoveredStack {
  serverId: string;
  /** compose "project" groupings found (com.docker.compose.project). */
  composeProjects: string[];
  /** Services grouped for display: each compose stack, then standalone last. */
  groups: DiscoveredGroup[];
  /** Flat view of every discovered service (same objects as in `groups`). */
  services: DiscoveredService[];
  volumes: Array<{ name: string; driver: string; inUseBy: string[] }>;
  networks: Array<{ name: string; driver: string }>;
  /** Stack-level notes for things Openship can't carry over 1:1. */
  warnings: string[];
  adoptable: boolean;
  /** Containers skipped because Openship already manages them. */
  alreadyManaged: number;
}

// Docker-injected / shell env that should never be imported as app config.
const ENV_DENYLIST = new Set([
  "PATH",
  "HOSTNAME",
  "HOME",
  "TERM",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "container",
]);

/** Networks Docker/compose create implicitly — never a "custom topology". */
export function isDefaultNetwork(name: string, composeProjects: string[]): boolean {
  if (name === "bridge" || name === "host" || name === "none") return true;
  return composeProjects.some((p) => name === `${p}_default`) || name === "default";
}

function envArrayToRecord(env: string[], imageDefaults?: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (ENV_DENYLIST.has(key)) continue;
    // Drop entries identical to the image's baked-in default (exact KEY=VALUE),
    // so an overridden var survives but the base image's dozen defaults don't
    // masquerade as user config. Without image data, nothing is dropped.
    if (imageDefaults?.has(entry)) continue;
    out[key] = entry.slice(eq + 1);
  }
  return out;
}

function portsToComposeStrings(ports: DockerPortBinding[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of ports) {
    const proto = p.type && p.type !== "tcp" ? `/${p.type}` : "";
    // Preserve a non-wildcard host IP (e.g. a 127.0.0.1-only publish) so the
    // redeploy doesn't silently widen a loopback binding to all interfaces.
    const hostIp = p.ip && p.ip !== "0.0.0.0" && p.ip !== "::" ? `${p.ip}:` : "";
    const spec = p.publicPort
      ? `${hostIp}${p.publicPort}:${p.privatePort}${proto}`
      : `${p.privatePort}${proto}`;
    if (!seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/** The host ports Openship's OpenResty edge owns — never re-published by an
 *  imported workload. */
export const EDGE_PORTS = new Set([80, 443]);

/** Parse a compose "host:container[/proto]" (or bare "container") port spec.
 *  `host` is the published host port (null for a bare container port — no host
 *  publish). Single source of truth for both edge detection and stripping;
 *  tolerates an optional host IP ("127.0.0.1:80:80"). */
export function parseComposePort(spec: string): {
  host: number | null;
  container: string;
  proto?: string;
} {
  const [hostAndPorts, proto] = spec.split("/");
  const parts = hostAndPorts.split(":");
  const container = parts[parts.length - 1];
  const host = parts.length >= 2 ? Number(parts[parts.length - 2]) : NaN;
  return { host: Number.isFinite(host) ? host : null, container, proto };
}

/** Host edge ports (80/443) a service publishes — the conflict signal. */
function edgePortsFromCompose(ports: string[]): number[] {
  const found = new Set<number>();
  for (const spec of ports) {
    const { host } = parseComposePort(spec);
    if (host != null && EDGE_PORTS.has(host)) found.add(host);
  }
  return [...found];
}

function toDiscoveredMounts(mounts: DockerMount[]): DiscoveredVolumeMount[] {
  return mounts
    .filter((m) => m.type === "volume" || m.type === "bind")
    .map((m) => ({
      type: m.type === "bind" ? "bind" : "volume",
      source: m.name ?? m.source,
      target: m.destination,
      rw: m.rw,
    }));
}

/** Docker healthcheck (durations in ns) → compose healthcheck (duration strings). */
function inspectHealthcheckToCompose(
  hc: NonNullable<DockerContainerDetail["healthcheck"]>,
): ComposeHealthcheck | undefined {
  if (!hc.test || hc.test.length === 0) return undefined;
  const [kind, ...rest] = hc.test;
  if (kind === "NONE") return { disable: true };
  const ns = (v?: number): string | undefined =>
    typeof v === "number" && v > 0 ? `${Math.round(v / 1_000_000_000)}s` : undefined;
  return {
    // CMD-SHELL → single shell string; CMD → argv; bare → treat as argv.
    test: kind === "CMD-SHELL" ? rest[0] : kind === "CMD" ? rest : hc.test,
    interval: ns(hc.interval),
    timeout: ns(hc.timeout),
    retries: hc.retries,
    startPeriod: ns(hc.startPeriod),
  };
}

/** Merge one container's inspect truth with its (optional) declared compose
 *  service. `imageDefaults` = the image's baked-in "KEY=VALUE" env, subtracted
 *  so only user-set vars are imported. */
export function toDiscoveredService(
  detail: DockerContainerDetail,
  declared: ComposeService | undefined,
  imageDefaults?: Set<string>,
  imageCmd?: string[],
): DiscoveredService {
  const mounts = toDiscoveredMounts(detail.mounts);
  const warnings: string[] = [];
  for (const m of mounts) {
    if (m.type === "bind") {
      warnings.push(
        `Bind mount ${m.source ?? "?"} → ${m.target}: data stays on the host, not migrated as a volume.`,
      );
    }
  }

  // Drop the container's command when it merely restates the image's default
  // CMD (and compose didn't declare one). Re-specifying it means the deploy
  // re-runs it wrapped as `sh -c "<cmd>"`, which defeats entrypoints that drop
  // privileges by argv — postgres then runs as root and refuses to start. A
  // genuine override (e.g. `redis-server --appendonly yes`) differs → kept.
  const containerCmd = detail.command && detail.command.length > 0 ? detail.command : undefined;
  const isImageDefaultCmd =
    !declared?.command &&
    !!containerCmd &&
    !!imageCmd &&
    containerCmd.length === imageCmd.length &&
    containerCmd.every((tok, i) => tok === imageCmd[i]);
  const command =
    declared?.command ?? (isImageDefaultCmd ? undefined : containerCmd?.join(" "));

  const healthcheck =
    declared?.advanced?.healthcheck ??
    (detail.healthcheck ? inspectHealthcheckToCompose(detail.healthcheck) : undefined);

  const name = declared?.name ?? detail.composeService ?? detail.name;
  const image = detail.image || declared?.image;
  const ports = portsToComposeStrings(detail.ports);

  // A container is the EDGE proxy only when it both publishes a host edge port
  // AND classifies as a proxy — so an internal `nginx` sidecar (no 80/443) is
  // left alone and only the thing actually holding the edge is dropped.
  const edgePorts = edgePortsFromCompose(ports);
  const proxyKind =
    edgePorts.length > 0
      ? classifyProxy([image, command, name].filter(Boolean).join(" "))
      : undefined;

  return {
    name,
    source: declared ? "compose" : "container",
    containerId: detail.id,
    containerName: detail.name,
    running: detail.state === "running",
    image,
    build: declared?.build,
    dockerfile: declared?.dockerfile,
    ports,
    env: envArrayToRecord(detail.env, imageDefaults),
    volumes: mounts,
    networks: detail.networks,
    dependsOn: declared?.dependsOn ?? [],
    command,
    restart: detail.restart?.name || declared?.restart,
    healthcheck,
    proxyKind,
    edgePorts: edgePorts.length > 0 ? edgePorts : undefined,
    warnings,
  };
}

/**
 * Pure reconciliation: merge inspected containers with declared compose
 * services into a DiscoveredStack. No IO — unit-testable with fixtures.
 */
export function reconcileStack(opts: {
  serverId: string;
  details: DockerContainerDetail[];
  volumes: DockerVolumeInfo[];
  networks: DockerNetworkInfo[];
  declared: Map<string, ComposeService>;
  alreadyManaged: number;
  /** image ref → its baked-in "KEY=VALUE" env, subtracted from container env. */
  imageDefaults?: Map<string, Set<string>>;
  /** image ref → its baked-in default CMD tokens, dropped when the container
   *  only restates it (see toDiscoveredService). */
  imageCmds?: Map<string, string[]>;
}): DiscoveredStack {
  const { serverId, details, volumes, networks, declared, alreadyManaged, imageDefaults, imageCmds } = opts;

  const composeProjects = [
    ...new Set(details.map((d) => d.composeProject).filter((p): p is string => Boolean(p))),
  ];

  // Build each service alongside the compose project it belongs to, then group.
  const built = details.map((d) => ({
    project: d.composeProject ?? null,
    service: toDiscoveredService(
      d,
      d.composeService ? declared.get(d.composeService) : undefined,
      imageDefaults?.get(d.image),
      imageCmds?.get(d.image),
    ),
  }));
  const services = built.map((b) => b.service);

  const byProject = new Map<string | null, DiscoveredService[]>();
  for (const b of built) {
    const arr = byProject.get(b.project) ?? [];
    arr.push(b.service);
    byProject.set(b.project, arr);
  }
  const groups: DiscoveredGroup[] = [...byProject.entries()]
    .map(([project, svcs]) => ({ project, services: svcs }))
    // Compose stacks first (named), standalone containers last.
    .sort((a, b) => (a.project === null ? 1 : 0) - (b.project === null ? 1 : 0));

  // Volumes actually mounted by adoptable services → what adoption must reuse.
  const inUse = new Map<string, Set<string>>();
  for (const svc of services) {
    for (const mount of svc.volumes) {
      if (mount.type !== "volume" || !mount.source) continue;
      const set = inUse.get(mount.source) ?? new Set<string>();
      set.add(svc.name);
      inUse.set(mount.source, set);
    }
  }
  const volumesOut = volumes
    .filter((v) => inUse.has(v.name))
    .map((v) => ({ name: v.name, driver: v.driver, inUseBy: [...(inUse.get(v.name) ?? [])] }));

  // Stack-level warnings for topology Openship flattens or can't model.
  const warnings: string[] = [];
  const customNetworks = networks
    .map((n) => n.name)
    .filter((name) => !isDefaultNetwork(name, composeProjects))
    .filter((name) => services.some((s) => s.networks.includes(name)));
  if (customNetworks.length > 0) {
    warnings.push(
      `Openship runs all services on one project network; custom networks (${customNetworks.join(", ")}) will be flattened. Services still reach each other by name.`,
    );
  }
  if (composeProjects.length > 0 || declared.size > 0) {
    warnings.push(
      "Compose `configs`, `secrets`, `expose`, and `depends_on` conditions are not modeled by Openship and won't carry over.",
    );
  }
  if (services.some((s) => Object.keys(s.env).length > 0)) {
    warnings.push(
      "Imported environment is read from the running containers and may include image defaults — review before adopting.",
    );
  }

  return {
    serverId,
    composeProjects,
    groups,
    services,
    volumes: volumesOut,
    networks: networks.map((n) => ({ name: n.name, driver: n.driver })),
    warnings,
    adoptable: services.length > 0,
    alreadyManaged,
  };
}
