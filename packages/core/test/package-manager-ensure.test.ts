import { describe, expect, it } from "vitest";

import { packageManagerEnsureCommand } from "../src/stacks";

describe("packageManagerEnsureCommand", () => {
  it("emits a corepack-enable prelude for pnpm and yarn (the PMs missing from base images)", () => {
    for (const pm of ["pnpm", "yarn"] as const) {
      const cmd = packageManagerEnsureCommand(pm);
      expect(cmd).toContain(`corepack enable ${pm}`);
      // Fallback chain: corepack-for-pm → corepack → global npm install.
      expect(cmd).toContain("|| corepack enable ||");
      expect(cmd).toContain(`npm i -g ${pm}`);
      // Fully swallowed so a missing corepack never fails the build.
      expect(cmd.endsWith("|| true")).toBe(true);
    }
  });

  it("is a no-op for npm (present), bun (own image), unknown, and undefined", () => {
    for (const pm of ["npm", "bun", "go", "cargo", "pip", undefined] as const) {
      expect(packageManagerEnsureCommand(pm)).toBe("");
    }
  });
});
