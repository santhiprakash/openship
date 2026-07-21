/**
 * MigrationOrchestrator — drives a full Docker migration:
 *
 *   adopt  → create the Openship `services` project from the selected stack
 *   moving_data → quiesce (stop) the originals on the source; for a
 *                 cross-server move, stream each named volume AND app-data bind
 *                 mount A→B directly
 *                 (executor.streamPath → executor.receiveStream; same sourceId
 *                 both sides, so the target volume — bare-named because adopt
 *                 keeps namespaceVolumes=false — is populated with no remap)
 *   deploying → deploy the adopted project on the target server
 *   verifying → wait for the target deployment to reach `ready`
 *   awaiting_cutover → success; wait for the user to confirm the destructive
 *                 teardown of the originals (opt-in)
 *   cutover → stop + remove the originals on the source (by scanned container
 *             id — they carry no openship.* labels). Never removes A volumes.
 *   rolled_back → any pre-cutover failure: tear down the target deployment and
 *                 restart the originals on the source. Never destroys A.
 *
 * A dedicated FSM (not the backup/restore orchestrators) because the source has
 * no Openship deployment to resolve an executor from, the target is
 * container-less pre-deploy, and we require no configured backup destination.
 */

import crypto from "node:crypto";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import {
  resolveExecutor,
  transferVolume,
  type ServiceHandle,
  type TransferEndpoint,
  type TransferMode,
  type TransferCompression,
} from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import { createServerDockerRuntime } from "../../lib/deployment-runtime";
import { requestBuildAccess } from "../deployments/build.service";
import { discoverServerStack } from "./docker-inspect.service";
import { adoptServerStack } from "./migrate.service";
import { isMovableBind } from "./migration-preflight";
import { migrationRunBus } from "./migration.sse";

/** Per-service volume ownership for a same-server migration.
 *  "reuse" (default) = seize the original volume in place (zero copy).
 *  "copy" = duplicate data into a new openship-<slug>-<name> volume, leaving the
 *  original untouched. Cross-server ignores this (it always copies A→B, keeps A). */
export type VolumeStrategy = "reuse" | "copy";

export interface StartMigrationInput {
  organizationId: string;
  sourceServerId: string;
  targetServerId: string;
  serviceNames: string[];
  projectName: string;
  killOriginals: boolean;
  /** serviceName → strategy. Same-server only; absent/"reuse" = current behavior. */
  volumeStrategies?: Record<string, VolumeStrategy>;
  /** Volume-transfer mechanism/compression (settings default or per-run override).
   *  Absent = "auto" (topology-aware) in the transfer core. */
  transferMode?: TransferMode;
  transferCompression?: TransferCompression;
}

const VERIFY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min for the target deploy
const VERIFY_POLL_MS = 5000;
const TERMINAL_DEPLOY = new Set(["ready", "partial_failure", "failed", "cancelled"]);
/** How many volumes move concurrently — a few in flight without saturating one SSH link. */
const TRANSFER_CONCURRENCY = 3;

/** Minimal bounded-concurrency runner (no dep): keeps ≤`limit` tasks in flight,
 *  preserves order, propagates the first rejection. */
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

class MigrationOrchestratorImpl {
  /** Create the run row and kick the async pipeline. Returns immediately. */
  async begin(
    ctx: RequestContext,
    input: StartMigrationInput,
  ): Promise<{ migrationId: string; confirmationToken: string }> {
    const confirmationToken = crypto.randomBytes(8).toString("hex");
    const mode =
      input.sourceServerId === input.targetServerId ? "same_server" : "cross_server";
    const run = await repos.dockerMigrationRun.create({
      id: `dmr_${crypto.randomUUID()}`,
      organizationId: input.organizationId,
      sourceServerId: input.sourceServerId,
      targetServerId: input.targetServerId,
      projectName: input.projectName,
      serviceNames: input.serviceNames,
      status: "queued",
      mode,
      killOriginals: input.killOriginals,
      confirmationToken,
    });
    setImmediate(() => {
      void this.run(ctx, run.id, input).catch((err) =>
        console.error(`[migration] ${run.id} crashed:`, safeErrorMessage(err)),
      );
    });
    return { migrationId: run.id, confirmationToken };
  }

  private async transition(
    id: string,
    status: Parameters<typeof repos.dockerMigrationRun.transition>[1],
    patch?: Parameters<typeof repos.dockerMigrationRun.transition>[2],
  ): Promise<void> {
    await repos.dockerMigrationRun.transition(id, status, patch);
    migrationRunBus.publish(id, {
      type: "transition",
      status,
      bytesMoved: (patch as { bytesMoved?: number })?.bytesMoved ?? null,
      deploymentId: (patch as { deploymentId?: string })?.deploymentId ?? null,
    });
    if (status === "succeeded" || status === "failed" || status === "rolled_back") {
      migrationRunBus.publish(id, {
        type: "complete",
        status,
        errorMessage: (patch as { errorMessage?: string })?.errorMessage ?? null,
      });
    }
  }

  private async run(
    ctx: RequestContext,
    id: string,
    input: StartMigrationInput,
  ): Promise<void> {
    const { organizationId, sourceServerId, targetServerId, serviceNames } = input;
    const sameServer = sourceServerId === targetServerId;
    let scannedContainerIds: Record<string, string> = {};
    let deploymentId: string | undefined;

    try {
      // ── adopt ──
      await this.transition(id, "adopting");
      const stack = await discoverServerStack(sourceServerId, organizationId);
      const chosen = stack.services.filter((s) => serviceNames.includes(s.name));
      if (chosen.length === 0) {
        throw new Error("None of the selected services were found on the server.");
      }
      const blocked = chosen.filter((s) => Boolean(s.build) && !s.image);
      if (blocked.length > 0) {
        throw new Error(
          `Cannot migrate built-from-source services: ${blocked
            .map((s) => s.name)
            .join(", ")}. Publish an image or link a repo first.`,
        );
      }
      scannedContainerIds = Object.fromEntries(
        chosen.filter((s) => s.containerId).map((s) => [s.name, s.containerId as string]),
      );

      const adopt = await adoptServerStack({
        serverId: sourceServerId,
        organizationId,
        projectName: input.projectName,
        serviceNames,
        sameServer,
        volumeStrategies: input.volumeStrategies,
      });
      const projectId = adopt.projectId;
      await this.transition(id, "adopting", { projectId, scannedContainerIds });

      // ── moving_data: quiesce originals (both) + copy volumes (cross-server) ──
      await this.transition(id, "moving_data");
      const bytesMoved = await this.moveData(
        projectId,
        sourceServerId,
        targetServerId,
        organizationId,
        scannedContainerIds,
        sameServer,
        input.volumeStrategies ?? {},
        { mode: input.transferMode, compression: input.transferCompression },
        (m) => console.log(`[migration] ${id}: ${m}`),
      );
      await this.transition(id, "moving_data", { bytesMoved });

      // ── deploying ──
      await this.transition(id, "deploying");
      const dep = await requestBuildAccess(ctx, {
        projectId,
        deployTarget: "server",
        serverId: targetServerId,
        runtimeMode: "docker",
        serviceDeploymentMode: "services",
      });
      deploymentId = dep.deployment_id;
      await this.transition(id, "deploying", { deploymentId });

      // ── verifying ──
      await this.transition(id, "verifying");
      const ok = await this.waitForDeployment(deploymentId);
      if (!ok) {
        throw new Error("Deployment on the target server did not become ready.");
      }

      // ── cutover (opt-in) / awaiting_cutover ──
      const run = await repos.dockerMigrationRun.findById(id);
      if (run?.killOriginals) {
        await this.transition(id, "cutover");
        await this.cutover(sourceServerId, organizationId, scannedContainerIds);
        await this.transition(id, "succeeded");
      } else {
        await this.transition(id, "awaiting_cutover");
      }
    } catch (err) {
      await this.rollback(
        id,
        { sourceServerId, targetServerId, organizationId, sameServer },
        scannedContainerIds,
        deploymentId,
        safeErrorMessage(err),
      );
    }
  }

  /** Stop originals on the source; then move volume data:
   *   - cross-server: stream every named/app-data source A→B (bare ids match).
   *   - same-server "copy" services: stream each NAMED volume from its original
   *     bare name into the scoped openship-<slug>-<name> volume on the SAME
   *     daemon, so the deploy mounts the copy and the original is left intact.
   *   - same-server "reuse" services: nothing — the deploy reuses the volume in place.
   *  Returns total bytes written. */
  private async moveData(
    projectId: string,
    sourceServerId: string,
    targetServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
    sameServer: boolean,
    volumeStrategies: Record<string, VolumeStrategy>,
    transfer: { mode?: TransferMode; compression?: TransferCompression },
    log: (message: string) => void,
  ): Promise<number> {
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    const rtB = sameServer
      ? null
      : await createServerDockerRuntime(targetServerId, organizationId);
    try {
      // Quiesce originals for a consistent copy (and to free ports/volumes on
      // a same-server redeploy). Best-effort — a missing container is fine.
      for (const cid of Object.values(scannedContainerIds)) {
        await rtA.stop(cid).catch(() => {});
      }

      const services = await repos.service.listByProject(projectId);
      const project = await repos.project.findById(projectId);
      const projectSlug = project?.slug ?? "";
      const execA = resolveExecutor("docker", rtA);

      // Collect (src → dst) transfer tasks for BOTH topologies, then run them
      // through the ONE transfer core. No per-topology pipe duplication — same
      // vs cross only differ in which executor/handle each end uses.
      const tasks: Array<{ label: string; src: TransferEndpoint; dst: TransferEndpoint }> = [];

      if (sameServer || !rtB) {
        // Same daemon: copy the volumes of "copy"-marked services bare→scoped.
        for (const svc of services) {
          if (volumeStrategies[svc.name] !== "copy") continue;
          const base = {
            id: svc.id,
            projectId,
            name: svc.name,
            image: svc.image ?? null,
            env: {},
            volumes: svc.volumes ?? [],
            containerId: null, // DB-fallback branch → resolvable ids both ways
            projectSlug,
          } as const;
          const bareHandle: ServiceHandle = { ...base, namespaceVolumes: false };
          const scopedHandle: ServiceHandle = { ...base, namespaceVolumes: true };
          const bareSrcs = await execA.listSources(bareHandle);
          const scopedSrcs = await execA.listSources(scopedHandle);
          for (const src of bareSrcs) {
            // Named volumes only — a bind mount can't be copied onto its own
            // host path on the same daemon, so it stays in place.
            if (src.type !== "volume") continue;
            const dst = scopedSrcs.find((d) => d.type === "volume" && d.target === src.target);
            if (!dst) continue;
            tasks.push({
              label: svc.name,
              src: { exec: execA, handle: bareHandle, sourceId: src.id },
              dst: { exec: execA, handle: scopedHandle, sourceId: dst.id },
            });
          }
        }
      } else {
        // Cross daemon: stream every movable source A→B (bare id = same name on
        // both, so data lands with no remap).
        const execB = resolveExecutor("docker", rtB);
        for (const svc of services) {
          const handle: ServiceHandle = {
            id: svc.id,
            projectId,
            name: svc.name,
            image: svc.image ?? null,
            env: {},
            volumes: svc.volumes ?? [],
            containerId: null, // force the DB-fallback branch → bare-named ids
            projectSlug,
            namespaceVolumes: svc.namespaceVolumes,
          };
          const sources = await execA.listSources(handle);
          for (const src of sources) {
            if (src.type === "bind") {
              if (!isMovableBind(src.source)) continue;
            } else if (src.type !== "volume") {
              continue;
            }
            tasks.push({
              label: svc.name,
              src: { exec: execA, handle, sourceId: src.id },
              dst: { exec: execB, handle, sourceId: src.id },
            });
          }
        }
      }

      // Bounded parallelism — a few volumes move at once without saturating a
      // single SSH link. transferVolume picks direct (same-daemon) vs stream and
      // the compression per the mode/compression request (auto = topology-aware).
      const results = await runPool(tasks, TRANSFER_CONCURRENCY, async (t) => {
        const r = await transferVolume(t.src, t.dst, {
          mode: transfer.mode,
          compression: transfer.compression,
          clearTarget: true,
          log: (m) => log(`${t.label}/${t.src.sourceId}: ${m}`),
        });
        log(`${t.label}/${t.src.sourceId}: ${r.strategy} (${r.compression}) — ${r.bytesMoved} bytes`);
        return r.bytesMoved;
      });
      return results.reduce((sum, n) => sum + n, 0);
    } finally {
      await rtA.dispose().catch(() => {});
      if (rtB) await rtB.dispose().catch(() => {});
    }
  }

  /** Poll the target deployment until terminal. `ready` = success. */
  private async waitForDeployment(deploymentId: string): Promise<boolean> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const dep = await repos.deployment.findById(deploymentId);
      if (dep && TERMINAL_DEPLOY.has(dep.status)) {
        return dep.status === "ready";
      }
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
    }
    return false;
  }

  /** Destroy the originals on the source (by scanned container id — they carry
   *  no openship.* labels). Never removes the source's volumes. */
  private async cutover(
    sourceServerId: string,
    organizationId: string,
    scannedContainerIds: Record<string, string>,
  ): Promise<void> {
    const rtA = await createServerDockerRuntime(sourceServerId, organizationId);
    try {
      for (const cid of Object.values(scannedContainerIds)) {
        await rtA.stop(cid).catch(() => {});
        await rtA.destroy(cid).catch(() => {});
      }
    } finally {
      await rtA.dispose().catch(() => {});
    }
  }

  /** Confirm the destructive cutover (or finish keeping the originals stopped).
   *  Timing-safe token compare. Only valid from `awaiting_cutover`. */
  async resolveCutover(
    id: string,
    organizationId: string,
    confirmationToken: string,
    kill: boolean,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const run = await repos.dockerMigrationRun.findById(id);
    if (!run || run.organizationId !== organizationId) {
      return { ok: false, status: 404, error: "Migration not found" };
    }
    if (run.status !== "awaiting_cutover") {
      return { ok: false, status: 409, error: `Migration is not awaiting cutover (status: ${run.status})` };
    }
    const expected = Buffer.from(run.confirmationToken ?? "");
    const supplied = Buffer.from(confirmationToken ?? "");
    if (
      expected.length !== supplied.length ||
      !crypto.timingSafeEqual(expected, supplied)
    ) {
      return { ok: false, status: 403, error: "Invalid confirmation token" };
    }

    if (kill && run.sourceServerId) {
      await this.transition(id, "cutover");
      await this.cutover(
        run.sourceServerId,
        organizationId,
        (run.scannedContainerIds ?? {}) as Record<string, string>,
      );
    }
    await this.transition(id, "succeeded");
    return { ok: true };
  }

  private async rollback(
    id: string,
    ctx: {
      sourceServerId: string;
      targetServerId: string;
      organizationId: string;
      sameServer: boolean;
    },
    scannedContainerIds: Record<string, string>,
    deploymentId: string | undefined,
    errorMessage: string,
  ): Promise<void> {
    // Best-effort: tear down whatever landed on the target, then bring the
    // originals back up on the source. Never destroy the source.
    //
    // This must run for same-server migrations too: `listDeploymentContainers`
    // scopes strictly by `openship.deployment=<deploymentId>` label, which
    // never overlaps with the pre-migration `scannedContainerIds` restarted
    // below, so it's safe regardless of source/target identity. Skipping it
    // for same-server previously left the newly-deployed (and possibly
    // port/name-colliding) containers running while the originals were also
    // restarted on the same daemon.
    try {
      if (deploymentId) {
        const rtB = await createServerDockerRuntime(ctx.targetServerId, ctx.organizationId);
        try {
          const containers = await rtB.listDeploymentContainers(deploymentId);
          for (const c of containers) {
            await rtB.destroy(c.containerId).catch(() => {});
          }
        } finally {
          await rtB.dispose().catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`[migration] ${id} rollback teardown failed:`, safeErrorMessage(err));
    }
    try {
      const rtA = await createServerDockerRuntime(ctx.sourceServerId, ctx.organizationId);
      try {
        for (const cid of Object.values(scannedContainerIds)) {
          await rtA.start(cid).catch(() => {});
        }
      } finally {
        await rtA.dispose().catch(() => {});
      }
    } catch (err) {
      console.warn(`[migration] ${id} rollback restart failed:`, safeErrorMessage(err));
    }
    await this.transition(id, "rolled_back", {
      errorMessage: errorMessage.slice(0, 4096),
    });
  }
}

export const migrationOrchestrator = new MigrationOrchestratorImpl();
