/**
 * In-instance "does the served static output exist at this path?" probe.
 *
 * Mirrors port-listen.ts: runs INSIDE the deployment (bare host / container) via
 * a CommandExecutor and reports whether the served directory exists and holds a
 * servable index. Advisory only — a static app whose Output Directory or a
 * per-domain path is wrong serves a 404, and this surfaces that from where the
 * files actually live instead of a host-side guess.
 */

import type { PortProbeExecutor } from "./port-listen";

export interface OutputProbeResult {
  /** The served path exists (a file or a directory). */
  found: boolean;
  /** Something servable is there: the path IS a file, or it's a dir with index.html. */
  hasIndex: boolean;
  /**
   * The probe ran and produced a reading. False = inconclusive (executor
   * unusable) — callers must treat `checked:false` as "no signal", never as
   * "missing".
   */
  checked: boolean;
}

// Print explicit tokens and force exit 0 so a missing path never rejects the
// exec (same discipline as PROC_NET_TCP_CMD). Single-quote-escape the path.
function buildCommand(servedPath: string): string {
  const p = servedPath.replace(/'/g, "'\\''");
  return [
    `if [ -e '${p}' ]; then echo FOUND; fi`,
    `if [ -f '${p}' ] || [ -f '${p}/index.html' ]; then echo INDEX; fi`,
    "true",
  ].join("; ");
}

/**
 * One probe. Never throws — returns `checked:false` when the exec itself failed
 * (inconclusive). No polling: static output is written before a deploy reports
 * "started", so unlike a port there's nothing to wait for.
 */
export async function probeStaticOutput(
  executor: PortProbeExecutor,
  servedPath: string,
): Promise<OutputProbeResult> {
  try {
    const out = await executor.exec(buildCommand(servedPath), { timeout: 5_000 });
    return {
      found: /(^|\n)FOUND(\r?\n|$)/.test(out),
      hasIndex: /(^|\n)INDEX(\r?\n|$)/.test(out),
      checked: true,
    };
  } catch {
    return { found: false, hasIndex: false, checked: false };
  }
}
