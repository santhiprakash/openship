import { describe, it, expect } from "vitest";
import { systemCatalog } from "./catalog";
import type { EnvironmentProfile } from "./environment";

/**
 * Regression guard for GitHub #86: the OpenResty apt repo must never be pinned
 * to a raw `$(lsb_release -sc)` codename (breaks on non-LTS / not-yet-published
 * codenames like Ubuntu 26.04 "resolute"). The install command must instead
 * probe openresty.org and fall back to the nearest supported LTS, and must heal
 * a stale openresty.list left by a prior (broken) run before the first apt-get.
 */

const linux = (over: Partial<EnvironmentProfile>): EnvironmentProfile => ({
  os: "linux",
  arch: "amd64",
  distro: "ubuntu",
  packageManager: "apt",
  serviceManager: "systemd",
  isRoot: true,
  canSudo: false,
  ...over,
});

const cmd = (p: EnvironmentProfile) =>
  systemCatalog.installs.openresty(p).installCommand ?? "";

describe("openresty install plan — #86 codename handling", () => {
  for (const [name, profile] of [
    ["apt/ubuntu", linux({ packageManager: "apt", distro: "ubuntu" })],
    // "none" → the runtime-probe dispatcher branch, which has its own apt arm
    // and must carry the same guarantees.
    ["runtime-probe", linux({ packageManager: "none" })],
  ] as const) {
    describe(name, () => {
      const c = cmd(profile);

      it("never emits a bare $(lsb_release -sc) repo pin", () => {
        expect(c).not.toMatch(/lsb_release -sc\)\s+main/);
      });

      it("probes the live repo for the codename", () => {
        expect(c).toContain("wget -q --spider");
        expect(c).toContain("/dists/$c/Release");
      });

      it("carries the nearest-LTS fallback ladder", () => {
        expect(c).toContain("noble jammy focal");
        expect(c).toContain("bookworm bullseye");
      });

      it("heals a stale openresty.list before the first apt-get update", () => {
        const rmAt = c.indexOf("rm -f /etc/apt/sources.list.d/openresty.list");
        const updateAt = c.indexOf("apt-get update");
        expect(rmAt).toBeGreaterThanOrEqual(0);
        expect(rmAt).toBeLessThan(updateAt);
      });
    });
  }

  it("uses the ubuntu repo for ubuntu and debian repo for debian", () => {
    expect(cmd(linux({ distro: "ubuntu" }))).toContain("REPO=ubuntu");
    expect(cmd(linux({ distro: "debian" }))).toContain("REPO=debian");
  });
});
