import { describe, expect, it } from "vitest";

import {
  buildOutputTransferExcludes,
  TRANSFER_EXCLUDES,
  STACKS,
} from "../src/stacks";

describe("buildOutputTransferExcludes", () => {
  it("keeps the stack's build output while still excluding deps/caches", () => {
    // Regression: TRANSFER_EXCLUDES lists `.next` (built for a ship-source flow),
    // but a build-local transfer must SHIP `.next` or `next start` fails on the
    // target with "Could not find a production build".
    const excludes = buildOutputTransferExcludes(STACKS.nextjs);
    expect(excludes).not.toContain(".next"); // the artifact ships
    expect(excludes).toContain(".next/cache"); // its cache does not (from cacheDirs)
    expect(excludes).toContain("node_modules"); // deps reinstalled on target
    expect(excludes).toContain(".git");
  });

  it("re-includes the output dir for every stack whose output sits in TRANSFER_EXCLUDES", () => {
    // nextjs=.next, nuxt=.output, sveltekit=.svelte-kit, remix/cra/react=build,
    // astro/vite/vue/angular=dist — all of these would otherwise be stripped.
    for (const id of ["nextjs", "nuxt", "sveltekit", "remix", "astro", "vite", "vue", "angular", "cra", "react"] as const) {
      const def = STACKS[id];
      const out = def.outputDirectory;
      if (!TRANSFER_EXCLUDES.includes(out)) continue; // e.g. gatsby → "public" (never excluded)
      expect(buildOutputTransferExcludes(def)).not.toContain(out);
    }
  });

  it("is a no-op for stacks whose output is not an excluded dir (e.g. '.')", () => {
    // node/express etc. build in place (outputDirectory "."); nothing to re-include,
    // and the full exclude set is preserved.
    const excludes = buildOutputTransferExcludes({ outputDirectory: "." });
    expect(excludes).toEqual([...TRANSFER_EXCLUDES]);
  });

  it("handles a missing stack definition without throwing", () => {
    expect(buildOutputTransferExcludes(undefined)).toEqual([...TRANSFER_EXCLUDES]);
  });
});
