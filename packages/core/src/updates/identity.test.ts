import { describe, it, expect } from "vitest";
import { isBehind, digestSha, identityLabel, type UpdatableIdentity } from "./identity";

describe("isBehind", () => {
  it("release: lower semver is behind", () => {
    expect(
      isBehind({ kind: "release", version: "0.3.0" }, { kind: "release", version: "0.3.1" }),
    ).toBe(true);
    expect(
      isBehind({ kind: "release", version: "0.3.1" }, { kind: "release", version: "0.3.1" }),
    ).toBe(false);
    expect(
      isBehind({ kind: "release", version: "1.0.0" }, { kind: "release", version: "0.9.9" }),
    ).toBe(false);
  });

  it("commit: differing sha is behind, equal is not", () => {
    expect(isBehind({ kind: "commit", sha: "aaa" }, { kind: "commit", sha: "bbb" })).toBe(true);
    expect(isBehind({ kind: "commit", sha: "aaa" }, { kind: "commit", sha: "aaa" })).toBe(false);
    // Missing a sha → no evidence → not behind.
    expect(isBehind({ kind: "commit", sha: "" }, { kind: "commit", sha: "bbb" })).toBe(false);
  });

  it("image: compares the sha256 suffix across repo@ / bare forms", () => {
    const current: UpdatableIdentity = {
      kind: "image",
      ref: "n8nio/n8n:latest",
      digest: "n8nio/n8n@sha256:aaaa",
    };
    const moved: UpdatableIdentity = {
      kind: "image",
      ref: "n8nio/n8n:latest",
      digest: "sha256:bbbb", // registry-form, no repo prefix
    };
    const same: UpdatableIdentity = { kind: "image", ref: "n8nio/n8n:latest", digest: "sha256:aaaa" };
    expect(isBehind(current, moved)).toBe(true);
    expect(isBehind(current, same)).toBe(false);
  });

  it("image: unknown digest on either side → not behind unless ref differs", () => {
    expect(
      isBehind(
        { kind: "image", ref: "n8nio/n8n:latest" },
        { kind: "image", ref: "n8nio/n8n:latest", digest: "sha256:x" },
      ),
    ).toBe(false);
    expect(
      isBehind(
        { kind: "image", ref: "n8nio/n8n:1.0" },
        { kind: "image", ref: "n8nio/n8n:1.1" },
      ),
    ).toBe(true);
  });

  it("mismatched kinds never claim drift", () => {
    expect(isBehind({ kind: "commit", sha: "a" }, { kind: "release", version: "1.0.0" })).toBe(false);
  });
});

describe("digestSha", () => {
  it("extracts the sha256 from repo@ and bare forms", () => {
    expect(digestSha("n8nio/n8n@sha256:abc")).toBe("sha256:abc");
    expect(digestSha("sha256:abc")).toBe("sha256:abc");
    expect(digestSha(undefined)).toBeUndefined();
  });
});

describe("identityLabel", () => {
  it("renders a compact label per kind", () => {
    expect(identityLabel({ kind: "commit", sha: "abcdef1234" })).toBe("abcdef1");
    expect(identityLabel({ kind: "release", version: "0.3.1" })).toBe("0.3.1");
    expect(identityLabel({ kind: "image", ref: "n8nio/n8n:latest" })).toBe("n8nio/n8n:latest");
  });
});
