/**
 * Stack output preparation — the pipeline-agnostic hook for: "did this stack's
 * build emit a self-contained bundle we can ship wholesale (traced deps, no
 * on-target install)?"
 *
 * Every runtime that ships a local build (bare/server, cloud, …) consults this
 * instead of hardcoding per-stack branches. Add support for a stack by
 * registering a preparer here — no runtime edits needed. The per-stack
 * detection logic (e.g. Next's `.next/standalone` + static/public nesting)
 * lives in its own module; this is just the registry + generic entry points.
 */

import { join } from "node:path";
import type { StackId } from "@repo/core";
import { prepareNextStandalone, type NextStandalonePlan } from "./nextjs-standalone";

/** A self-contained build output: ship `bundleDir` as-is; run `startCommand`. */
export type StackOutputPlan = NextStandalonePlan;

/** Given the built project dir, return a shippable bundle — or null (→ host mode). */
export type StackOutputPreparer = (projectDir: string) => Promise<StackOutputPlan | null>;

/**
 * Per-stack self-contained-output preparers. A stack appears here only when its
 * build can emit a wholesale-shippable bundle. Slot new stacks in the same way:
 *   nextjs → next.config `output: 'standalone'` → `.next/standalone`
 *   (nuxt/nitro `.output`, sveltekit adapter-node, … register alongside)
 */
export const STACK_OUTPUT_PREPARERS: Partial<Record<StackId, StackOutputPreparer>> = {
  nextjs: prepareNextStandalone,
};

/** Run the stack's preparer if one is registered; null otherwise. */
export async function prepareStackOutput(
  stack: string,
  projectDir: string,
): Promise<StackOutputPlan | null> {
  const prepare = STACK_OUTPUT_PREPARERS[stack as StackId];
  return prepare ? prepare(projectDir) : null;
}

/**
 * Resolve the project directory inside a local build dir, honoring a
 * (possibly slash-wrapped) `rootDirectory`. Mirrors `resolveBuildDirectory`
 * in build-pipeline.ts. Generic build-dir helper — not stack-specific.
 */
export function resolveProjectDir(buildDir: string, rootDirectory?: string): string {
  const normalized = rootDirectory?.trim().replace(/^\/+|\/+$/g, "");
  return normalized ? join(buildDir, normalized) : buildDir;
}
