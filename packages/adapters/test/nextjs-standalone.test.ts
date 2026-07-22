import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareNextStandalone } from "../src/runtime/nextjs-standalone";
import { resolveProjectDir } from "../src/runtime/stack-output";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "next-sa-"));
  dirs.push(d);
  return d;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("prepareNextStandalone", () => {
  it("returns null when there is no standalone bundle (→ host mode)", async () => {
    const proj = await tmp();
    await mkdir(join(proj, ".next"), { recursive: true });
    await writeFile(join(proj, ".next", "BUILD_ID"), "x"); // host build, no /standalone
    expect(await prepareNextStandalone(proj)).toBeNull();
  });

  it("detects the bundle and nests static + public so it is self-contained", async () => {
    const proj = await tmp();
    await mkdir(join(proj, ".next", "standalone"), { recursive: true });
    await writeFile(join(proj, ".next", "standalone", "server.js"), "// server");
    await mkdir(join(proj, ".next", "static", "chunks"), { recursive: true });
    await writeFile(join(proj, ".next", "static", "chunks", "a.js"), "1");
    await mkdir(join(proj, "public"), { recursive: true });
    await writeFile(join(proj, "public", "logo.svg"), "<svg/>");

    const plan = await prepareNextStandalone(proj);
    expect(plan).not.toBeNull();
    expect(plan!.startCommand).toBe("node server.js");
    expect(plan!.bundleDir).toBe(join(proj, ".next", "standalone"));
    // static + public nested INTO the bundle (server.js resolves them relative to itself)
    expect(await exists(join(plan!.bundleDir, ".next", "static", "chunks", "a.js"))).toBe(true);
    expect(await exists(join(plan!.bundleDir, "public", "logo.svg"))).toBe(true);
    // originals untouched
    expect(await readFile(join(proj, ".next", "static", "chunks", "a.js"), "utf8")).toBe("1");
  });

  it("works when public/ is absent (public is optional)", async () => {
    const proj = await tmp();
    await mkdir(join(proj, ".next", "standalone"), { recursive: true });
    await writeFile(join(proj, ".next", "standalone", "server.js"), "// server");
    await mkdir(join(proj, ".next", "static"), { recursive: true });
    await writeFile(join(proj, ".next", "static", "a.js"), "1");

    const plan = await prepareNextStandalone(proj);
    expect(plan).not.toBeNull();
    expect(await exists(join(plan!.bundleDir, ".next", "static", "a.js"))).toBe(true);
    expect(await exists(join(plan!.bundleDir, "public"))).toBe(false);
  });
});

describe("resolveProjectDir", () => {
  it("returns buildDir when rootDirectory is empty/'.'/undefined", () => {
    expect(resolveProjectDir("/b")).toBe("/b");
    expect(resolveProjectDir("/b", ".")).toBe("/b");
    expect(resolveProjectDir("/b", "")).toBe("/b");
  });

  it("joins a subdir rootDirectory, trimming slashes", () => {
    expect(resolveProjectDir("/b", "apps/web")).toBe("/b/apps/web");
    expect(resolveProjectDir("/b", "/apps/web/")).toBe("/b/apps/web");
  });
});
