/**
 * Migration preflight — a read-only preview of what migrating the selected
 * services from a source server onto a target server will do. Classifies each
 * service (registry vs build), lists the named volumes that will move, and
 * surfaces the bind-mount / custom-network / downtime caveats BEFORE anything
 * changes. Reuses discoverServerStack (server truth). No mutation.
 *
 * v1: built-from-source services (compose `build:`, no registry image) are
 * BLOCKED — the adopted project has no linked source to rebuild on the target.
 */

import { discoverServerStack } from "./docker-inspect.service";

/**
 * Which bind-mount host paths are worth (and safe to) copy across servers.
 * App data dirs move; sockets, devices, and system paths never do — copying
 * `/var/run/docker.sock` or `/etc/localtime` onto the target is meaningless or
 * harmful. Shared by the orchestrator's move step and the preview.
 */
export function isMovableBind(hostPath: string | undefined): boolean {
  const p = (hostPath ?? "").trim();
  if (!p || p === "/" || !p.startsWith("/")) return false;
  if (p.endsWith(".sock")) return false;
  const denyPrefixes = ["/proc", "/sys", "/dev", "/run", "/var/run"];
  if (denyPrefixes.some((d) => p === d || p.startsWith(`${d}/`))) return false;
  const denyExact = new Set([
    "/etc/localtime",
    "/etc/timezone",
    "/etc/hosts",
    "/etc/hostname",
    "/etc/resolv.conf",
    "/var/lib/docker",
  ]);
  return !denyExact.has(p);
}

export interface MigrationPreviewService {
  name: string;
  source: "compose" | "container";
  image?: string;
  classification: "registry" | "build";
  /** Built-from-source → can't migrate in v1. */
  blocked: boolean;
  reason?: string;
  /** This service IS the edge proxy (80/443) → dropped from import; Openship's
   *  OpenResty replaces it and reclaims the port. */
  edgeProxy?: boolean;
  /** Non-proxy service that published 80/443 → those host bindings are stripped
   *  (reserved for Openship's edge); the app is routed through OpenResty. */
  edgePortsReserved?: number[];
  /** Named volumes that will be copied (cross-server) / reused (same-server). */
  volumes: Array<{ name: string; target: string }>;
  /** App-data bind-mount host paths that WILL be copied to the target. */
  bindMounts: string[];
  /** System/socket bind paths left on the source host (never copied). */
  bindMountsSkipped: string[];
  warnings: string[];
}

export interface MigrationPreview {
  sameServer: boolean;
  services: MigrationPreviewService[];
  /** Distinct named volumes to move (empty for same-server). */
  volumesToMove: string[];
  /** Any selected service is build-only → the migration can't run as-is. */
  hasBlocked: boolean;
  /** A stop-copy-start window applies (originals are stopped during the move). */
  downtimeWarning: boolean;
  /** Reverse-proxy services that will NOT be imported (Openship's edge replaces
   *  them). They're left running and untouched by the migration; add a domain to
   *  a migrated service to move onto Openship's edge (its consent modal reclaims
   *  80/443 then). */
  droppedProxies: string[];
  /** Stack-level notes (custom networks flattened, etc.). */
  warnings: string[];
}

export async function buildMigrationPreview(opts: {
  sourceServerId: string;
  targetServerId: string;
  serviceNames: string[];
  organizationId: string;
}): Promise<MigrationPreview> {
  const { sourceServerId, targetServerId, serviceNames, organizationId } = opts;

  const stack = await discoverServerStack(sourceServerId, organizationId);
  const selected = new Set(serviceNames);
  const chosen = stack.services.filter((s) => selected.has(s.name));
  const sameServer = sourceServerId === targetServerId;

  const services: MigrationPreviewService[] = chosen.map((s) => {
    // Build-only = has a build context and no runnable registry image.
    const isBuild = Boolean(s.build) && !s.image;
    const isProxy = Boolean(s.proxyKind);
    const volumes = s.volumes
      .filter((v) => v.type === "volume" && v.source)
      .map((v) => ({ name: v.source as string, target: v.target }));
    const bindAll = s.volumes
      .filter((v) => v.type === "bind" && v.source)
      .map((v) => v.source as string);
    return {
      name: s.name,
      source: s.source,
      image: s.image,
      classification: isBuild ? "build" : "registry",
      blocked: isBuild,
      reason: isBuild
        ? "Built-from-source services can't be migrated yet — publish an image or link a repo first."
        : isProxy
          ? `Reverse proxy (${s.proxyKind}) on ${(s.edgePorts ?? []).map((p) => `:${p}`).join("/")} — Openship's edge replaces it; not imported.`
          : undefined,
      edgeProxy: isProxy || undefined,
      edgePortsReserved: !isProxy && s.edgePorts?.length ? s.edgePorts : undefined,
      volumes,
      bindMounts: bindAll.filter(isMovableBind),
      bindMountsSkipped: bindAll.filter((p) => !isMovableBind(p)),
      warnings: s.warnings,
    };
  });

  // Proxies are dropped, not migrated — exclude them from the moved-volume set.
  const workloads = services.filter((s) => !s.edgeProxy);
  const droppedProxies = services.filter((s) => s.edgeProxy).map((s) => s.name);
  const volumesToMove = sameServer
    ? []
    : Array.from(new Set(workloads.flatMap((s) => s.volumes.map((v) => v.name))));

  return {
    sameServer,
    services,
    volumesToMove,
    hasBlocked: workloads.some((s) => s.blocked),
    downtimeWarning: workloads.length > 0,
    droppedProxies,
    warnings: stack.warnings,
  };
}
