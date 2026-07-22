/**
 * Adopt a discovered Docker stack as an Openship project.
 *
 * Re-discovers the server (server truth, not client-sent config), filters to the
 * services the user selected, and creates a `services` project whose service
 * rows mirror the running containers. Same-server adoption reuses the EXISTING
 * named volumes in place by default (`namespaceVolumes=false`, original bare
 * names) so data survives — Openship would otherwise re-scope them to
 * `openship-<slug>-<name>` and mount empty volumes. A service the user marks
 * "copy" instead keeps the scoped name; its data is duplicated into that new
 * volume during moving_data, leaving the original volume untouched.
 *
 * This creates records only; deploy + cutover (stop old → start Openship's) is a
 * separate step so the user reviews before anything on the server changes.
 */

import { repos } from "@repo/db";
import { ensureProject } from "../projects/project-crud.service";
import { discoverServerStack } from "./docker-inspect.service";
import { EDGE_PORTS, parseComposePort, type DiscoveredVolumeMount } from "./docker-reconcile";

type EnsureBody = Parameters<typeof ensureProject>[0];
type ParsedComposeList = Parameters<typeof repos.service.syncFromCompose>[1];

export interface AdoptResult {
  projectId: string;
  slug: string;
  created: boolean;
  adopted: string[];
}

/** A discovered mount → compose volume string. Anonymous (no source) is dropped
 *  (its data isn't reusable in place). Named volumes keep their original bare
 *  name; bind mounts keep their host path. */
function volumeToComposeString(v: DiscoveredVolumeMount): string | null {
  if (!v.source) return null;
  const mode = v.rw ? "" : ":ro";
  return `${v.source}:${v.target}${mode}`;
}

/** Ports 80/443 belong to Openship's OpenResty edge. For an imported service
 *  that published one, drop the host side (and any host IP) but KEEP the
 *  container port so OpenResty can still route to it — e.g. "80:3000" → "3000",
 *  "443:443" → "443". Non-edge host ports (e.g. "8080:80") are untouched. */
function stripEdgeHostPorts(ports: string[]): string[] {
  return ports.map((spec) => {
    const { host, container, proto } = parseComposePort(spec);
    if (host == null || !EDGE_PORTS.has(host)) return spec;
    return proto ? `${container}/${proto}` : container;
  });
}


export async function adoptServerStack(opts: {
  serverId: string;
  organizationId: string;
  projectName: string;
  serviceNames: string[];
  /** True when target == source. Only then is "copy" (below) meaningful. */
  sameServer?: boolean;
  /** serviceName → "reuse" | "copy" (same-server volume ownership). */
  volumeStrategies?: Record<string, "reuse" | "copy">;
}): Promise<AdoptResult> {
  const { serverId, organizationId, projectName, serviceNames, sameServer, volumeStrategies } = opts;

  const stack = await discoverServerStack(serverId, organizationId);
  const selected = new Set(serviceNames);
  // Drop the edge proxy (traefik/nginx/… on 80/443): OpenResty replaces it, so
  // adopting it would just replay the 80/443 conflict. Defense-in-depth — the
  // wizard already marks it non-importable and the orchestrator filters it too.
  const chosen = stack.services.filter((s) => selected.has(s.name) && !s.proxyKind);
  if (chosen.length === 0) {
    throw new Error("None of the selected services were found on the server.");
  }

  // Cross-server can't move a LOCALLY-BUILT image: it isn't in a registry, so a
  // different target host has nothing to pull. Registry-image stacks migrate
  // across servers fine (the target pulls them); built ones must be taken over
  // IN PLACE (same server, where the built image already exists). Moving built
  // images across hosts (docker save|load stream) is coming soon.
  if (!sameServer) {
    const built = chosen.filter((s) => Boolean(s.build)).map((s) => s.name);
    if (built.length > 0) {
      throw new Error(
        `Cross-server migration can't move locally-built images yet (${built.join(", ")}). ` +
          `Take these over in place (migrate to the same server), or rebuild them from a registry image. Cross-server for built images is coming soon.`,
      );
    }
  }

  // Only a container with NO resolvable image genuinely needs a build source.
  // A container that was originally built from source still RUNS an image on the
  // host, so we adopt that image rather than rebuild — see the mapping below.
  const anyBuild = chosen.some((s) => !s.image && Boolean(s.build));
  const ensureBody: EnsureBody = {
    name: projectName,
    projectType: "services",
    hasServer: true,
    hasBuild: anyBuild,
  };
  const { project_id, created } = await ensureProject(ensureBody, organizationId);

  // Service names must be unique within a project, but two adopted containers
  // can share a name (a standalone `postgres` + a compose `postgres`). Uniquify
  // with a numeric suffix so neither silently overwrites the other on sync, and
  // remap dependsOn to the first service that carried each original name.
  const nameCounts = new Map<string, number>();
  const firstUnique = new Map<string, string>();
  const uniqueNames = chosen.map((s) => {
    const n = (nameCounts.get(s.name) ?? 0) + 1;
    nameCounts.set(s.name, n);
    const unique = n === 1 ? s.name : `${s.name}-${n}`;
    if (!firstUnique.has(s.name)) firstUnique.set(s.name, unique);
    return unique;
  });

  const parsed: ParsedComposeList = chosen.map((s, i) => ({
    name: uniqueNames[i],
    kind: "compose" as const,
    // Adoption takes the running container AS-IS via its current image — we
    // don't have its original build source, so we never carry a build context
    // (which would make the deploy try to rebuild-from-source and fail preflight
    // with "repository URL or local path"). Only an image-less container (rare)
    // falls back to its build context.
    image: s.image,
    build: s.image ? undefined : s.build,
    dockerfile: s.image ? undefined : s.dockerfile,
    ports: stripEdgeHostPorts(s.ports),
    // Left UNEXPOSED on purpose: an exposed free service would synthesize a
    // subdomain route (usesManagedRouting is true for a self-hosted server
    // deploy), which fires the routing/OpenResty ensure DURING migration — and
    // self-hosted free domains need the cloud edge, so it'd fail preflight (or,
    // with a foreign proxy present, raise the takeover prompt the wizard can't
    // surface → timeout). The user routes each service from the project's
    // Domains tab (Add route → exposes it) afterwards; that redeploy ensures
    // OpenResty and reclaims 80/443 via the consent modal.
    // Only keep dependencies on services we're also adopting.
    dependsOn: s.dependsOn.filter((d) => selected.has(d)).map((d) => firstUnique.get(d) ?? d),
    environment: s.env,
    volumes: s.volumes
      .map(volumeToComposeString)
      .filter((v): v is string => v !== null),
    command: s.command,
    restart: s.restart,
    advanced: s.healthcheck ? { healthcheck: s.healthcheck } : undefined,
  }));

  const createdServices = await repos.service.syncFromCompose(project_id, parsed);

  // Volume ownership: reuse the original bare-named volumes in place
  // (namespaceVolumes=false) — EXCEPT same-server services the user marked
  // "copy", which keep the scoped openship-<slug>-<name> name so the deploy
  // mounts the fresh copy (populated in moving_data) and the original volume is
  // left untouched. Cross-server always reuses bare names (the A→B stream trick).
  for (const svc of createdServices) {
    const copy = Boolean(sameServer) && volumeStrategies?.[svc.name] === "copy";
    if (svc.namespaceVolumes !== copy) {
      await repos.service.update(svc.id, { namespaceVolumes: copy });
    }
  }

  const project = await repos.project.findById(project_id);
  return {
    projectId: project_id,
    slug: project?.slug ?? "",
    created,
    adopted: chosen.map((s) => s.name),
  };
}
