/**
 * Managed-edge INFRA for the self-app's custom domain: install OpenResty +
 * certbot and, when the operator consents, take over / migrate an existing
 * proxy on ports 80/443. That's ALL this module does now — it no longer owns
 * routing or cert issuance. The route (hostname → 127.0.0.1:dashPort) and the
 * Let's Encrypt cert are registered by the NORMAL deployment pipeline via
 * `reapplyProjectLiveRoutes` + `manageDomainSsl`, resolved from the self-app's
 * adopt deployment (see lib/startup/self-deploy.ts). This keeps the self-app on
 * the same routing/SSL path as every other app — no duplication.
 *
 * Single-flight so the boot reconcile + the wizard endpoint never install twice
 * at once. Root Linux only (apt/dnf + certbot + systemd); a no-op elsewhere.
 */

import { env } from "../../config/env";

export interface SelfEdgeInfraProgress {
  onLog?: (message: string, level?: "info" | "warn" | "error") => void;
}

export interface SelfEdgeInfraResult {
  ok: boolean;
  reason?: string;
}

export interface SelfEdgeOptions {
  /** Operator accepted reclaiming ports 80/443 from an existing proxy. Without
   *  it, an occupied edge makes the install throw rather than blind-kill. */
  edgeTakeover?: boolean;
  /** Operator accepted MIGRATING the existing proxy's sites into Openship
   *  before taking over (full scan → import → takeover). */
  edgeMigrate?: boolean;
}

let inFlight: Promise<SelfEdgeInfraResult> | null = null;

/**
 * Ensure OpenResty + certbot are installed (and optionally take over/migrate an
 * existing proxy). Single-flight. Returns `{ok:false, reason}` on a non-Linux /
 * non-root host or a failed migrate — the caller treats that as "skip the local
 * edge" (free/byo domains don't need it).
 */
export function ensureSelfEdgeInfra(
  progress?: SelfEdgeInfraProgress,
  options?: SelfEdgeOptions,
): Promise<SelfEdgeInfraResult> {
  if (inFlight) return inFlight;
  inFlight = runEnsure(progress, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runEnsure(
  progress?: SelfEdgeInfraProgress,
  options?: SelfEdgeOptions,
): Promise<SelfEdgeInfraResult> {
  const log = (message: string, level: "info" | "warn" | "error" = "info") => {
    if (progress?.onLog) progress.onLog(message, level);
    else console.log(`[edge] ${message}`);
  };

  if (process.platform !== "linux") {
    log("managed edge needs a Linux host — skipping (use a reverse proxy in front).", "warn");
    return { ok: false, reason: "not_linux" };
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    log("managed edge needs root (to install OpenResty/certbot) — skipping.", "warn");
    return { ok: false, reason: "not_root" };
  }

  const {
    createExecutor,
    SystemManager,
    probeEdge,
    scanImportableSites,
    canImportProxy,
    runEdgeTakeover,
  } = await import("@repo/adapters");
  const executor = createExecutor(); // LocalExecutor — this same machine

  // Migrate: import the existing proxy's sites and take over 80/443. The
  // self-app's own route is added AFTER by the pipeline (reapplyProjectLiveRoutes),
  // not here — so no extraRoutes.
  if (options?.edgeMigrate) {
    const status = await probeEdge(executor);
    const proxy = status.occupants.find((o) => o.proxy)?.proxy;
    const scan =
      proxy && canImportProxy(proxy)
        ? await scanImportableSites(executor, proxy)
        : { sites: [], warnings: [] };
    const res = await runEdgeTakeover(
      executor,
      { status, sites: scan.sites, acmeEmail: env.OPENSHIP_ACME_EMAIL, extraRoutes: [] },
      (entry) => log(entry.message, entry.level),
    );
    if (!res.ok) return { ok: false, reason: "migrate_failed" };
    return { ok: true };
  }

  // Install OpenResty + certbot (idempotent). edgeTakeover authorizes reclaiming
  // 80/443 from an existing proxy; without it an occupied edge throws instead of
  // blind-killing.
  const installerConfig = options?.edgeTakeover
    ? { edgePolicy: { mode: "takeover" as const, stopTargets: [] } }
    : undefined;
  const system = new SystemManager("bare", { executor, installerConfig });
  await system.ensureFeature("ssl", (entry) => log(entry.message));
  return { ok: true };
}
