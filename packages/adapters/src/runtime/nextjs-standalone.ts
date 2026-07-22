/**
 * Next.js `output: 'standalone'` support (detect-only).
 *
 * When a project's own `next.config` sets `output: 'standalone'`, `next build`
 * emits a self-contained server bundle at `<proj>/.next/standalone` — a minimal
 * `server.js` plus the traced subset of `node_modules`. It runs with
 * `node server.js` and needs NO `npm install` on the target.
 *
 * The catch: Next does NOT copy static assets or `public/` into that bundle,
 * and `server.js` resolves them relative to its own directory. So to ship a
 * genuinely self-contained artifact we nest `.next/static` and `public/` inside
 * the standalone dir first.
 *
 * Detection is deliberately narrow — we require `.next/standalone/server.js` at
 * the bundle root, which is the single-app layout. Monorepo standalone nests
 * the server under an app subpath (no root `server.js`), so it returns null and
 * the caller falls back to host mode. Never mutates `next.config`.
 */

import { cp, stat } from "node:fs/promises";
import { join } from "node:path";

export interface NextStandalonePlan {
  /** Absolute dir to ship WHOLESALE (self-contained, incl. traced node_modules). */
  bundleDir: string;
  /** Start command to run from the shipped bundle root. */
  startCommand: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a Next.js standalone build under `projectDir` and make its bundle
 * self-contained (nest static + public). Returns null when there's no
 * root-level standalone bundle — the caller then ships via host mode.
 */
export async function prepareNextStandalone(
  projectDir: string,
): Promise<NextStandalonePlan | null> {
  const bundleDir = join(projectDir, ".next", "standalone");
  if (!(await exists(join(bundleDir, "server.js")))) return null;

  const staticSrc = join(projectDir, ".next", "static");
  if (await exists(staticSrc)) {
    await cp(staticSrc, join(bundleDir, ".next", "static"), { recursive: true });
  }
  const publicSrc = join(projectDir, "public");
  if (await exists(publicSrc)) {
    await cp(publicSrc, join(bundleDir, "public"), { recursive: true });
  }

  return { bundleDir, startCommand: "node server.js" };
}
