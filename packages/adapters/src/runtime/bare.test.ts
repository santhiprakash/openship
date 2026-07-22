import { describe, expect, test } from "vitest";
import { BareRuntime } from "./bare";

// C3 — resolveStaticRoot becomes OpenResty's `root <dir>;`. It MUST stay inside
// the deployment workDir; an absolute or ../-traversing outputDirectory would
// point the document root at the host filesystem (arbitrary file disclosure).
describe("BareRuntime.resolveStaticRoot confinement", () => {
  const rt = new BareRuntime();
  const WORK = "/opt/openship/releases/dep_123";

  test("empty / '.' → the workDir itself", () => {
    expect(rt.resolveStaticRoot(WORK, "")).toBe(WORK);
    expect(rt.resolveStaticRoot(WORK, ".")).toBe(WORK);
  });

  test("relative subdir → joined under workDir", () => {
    expect(rt.resolveStaticRoot(WORK, "dist")).toBe(`${WORK}/dist`);
    expect(rt.resolveStaticRoot(WORK, "apps/web/dist")).toBe(`${WORK}/apps/web/dist`);
  });

  test("absolute path is rejected", () => {
    expect(() => rt.resolveStaticRoot(WORK, "/")).toThrow(/absolute paths are not allowed/);
    expect(() => rt.resolveStaticRoot(WORK, "/etc")).toThrow(/absolute paths are not allowed/);
    expect(() => rt.resolveStaticRoot(WORK, "/etc/letsencrypt/live")).toThrow(/absolute/);
  });

  test("../ traversal that escapes the workDir is rejected", () => {
    expect(() => rt.resolveStaticRoot(WORK, "../../../../etc")).toThrow(/escapes/);
    expect(() => rt.resolveStaticRoot(WORK, "dist/../../../root")).toThrow(/escapes/);
  });

  test("../ that stays inside is allowed", () => {
    expect(rt.resolveStaticRoot(WORK, "build/../dist")).toBe(`${WORK}/dist`);
  });
});
