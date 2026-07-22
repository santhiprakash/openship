import { describe, expect, it } from "vitest";

import { cloudCpus } from "../src/types";

// Oblien accepts fractional `cpus`, so tier values pass through verbatim —
// cloudCpus only guards the resource-schema floor (0.25) so a 0/negative never
// reaches the API. (It previously ceil'd to a whole integer to work around an
// Oblien API that rejected fractions, which over-allocated the 0.25/0.5 tiers.)
describe("cloudCpus", () => {
  it("passes fractional tier values through unchanged", () => {
    expect(cloudCpus(0.25)).toBe(0.25);
    expect(cloudCpus(0.5)).toBe(0.5); // the free "low" tier
    expect(cloudCpus(1)).toBe(1);
    expect(cloudCpus(1.5)).toBe(1.5);
    expect(cloudCpus(2)).toBe(2);
    expect(cloudCpus(4)).toBe(4);
  });

  it("clamps up to the 0.25 floor, never returning 0 or negative", () => {
    for (const cores of [0, 0.1, 0.2]) {
      expect(cloudCpus(cores)).toBe(0.25);
    }
    expect(cloudCpus(-1)).toBe(0.25);
  });
});
