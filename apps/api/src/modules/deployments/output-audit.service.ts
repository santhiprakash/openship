/**
 * Advisory static-output audit — the file-side counterpart to port-audit.
 *
 * Confirms a static/path-based deployment actually has servable output at each
 * routed path, probing from INSIDE the deployment via the runtime's
 * `inContainerExecutor` (same handle auditPorts uses). Purely advisory — it can
 * NEVER throw or fail a deploy; the worst it does is record `checked:false` so
 * the dashboard stays silent.
 */

import { probeStaticOutput, type BuildLogger, type RuntimeAdapter } from "@repo/adapters";
import type { OutputCheckResult } from "../../lib/deployment-runtime";

/**
 * Probe each `{ path, servedPath }` inside `containerId`. Returns one result per
 * target. Guaranteed to resolve (never rejects).
 */
export async function auditStaticOutput(
  runtime: RuntimeAdapter,
  containerId: string,
  targets: Array<{ path: string; servedPath: string }>,
  logger: BuildLogger,
): Promise<OutputCheckResult[]> {
  if (targets.length === 0) return [];

  const inconclusive = (reason: OutputCheckResult["skippedReason"]): OutputCheckResult[] =>
    targets.map((t) => ({
      path: t.path,
      servedPath: t.servedPath,
      found: false,
      hasIndex: false,
      checked: false,
      skippedReason: reason,
    }));

  // Runtime can't exec inside the instance (e.g. cloud Pages after the build
  // workspace is gone) → no signal, stay silent.
  if (!runtime.inContainerExecutor) return inconclusive("no-exec");

  try {
    const executor = await runtime.inContainerExecutor(containerId);
    const results: OutputCheckResult[] = [];
    for (const target of targets) {
      const probe = await probeStaticOutput(executor, target.servedPath);
      if (probe.checked && !probe.found) {
        logger.log(`Output check: nothing found at ${target.servedPath}.\n`, "warn");
      }
      results.push({
        path: target.path,
        servedPath: target.servedPath,
        found: probe.found,
        hasIndex: probe.hasIndex,
        checked: probe.checked,
      });
    }
    return results;
  } catch {
    // Couldn't acquire the executor — advisory only, degrade to inconclusive.
    return inconclusive("no-exec");
  }
}
