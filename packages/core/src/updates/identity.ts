/**
 * Unified "version identity" for anything Openship can update — one discriminated
 * shape covering the three drift kinds so a single resolver/scanner and a single
 * banner can treat git projects, release/dist projects, the self-app, and
 * image-based apps the same way. This is the commit-OR-tag unification: instead
 * of a bespoke check per kind, every updatable entity produces a `current` and a
 * `latest` UpdatableIdentity, and `isBehind` decides whether an update exists.
 */

import { compareSemver } from "./semver";

/** How an entity's version is identified. */
export type UpdatableKind = "commit" | "release" | "image";

export type UpdatableIdentity =
  /** Git-backed project: the deployed vs remote-HEAD commit sha. */
  | { kind: "commit"; sha: string; branch?: string; message?: string }
  /** Release/dist project or the self-app/webmail: a semver/tag. */
  | { kind: "release"; version: string; tag?: string }
  /**
   * Image-based app (compose/services template): a mutable tag plus the
   * content-addressable digest actually running. `digest` is what makes a moved
   * `:latest`/`:1` detectable — the tag string alone never changes.
   */
  | { kind: "image"; ref: string; digest?: string };

/** True when `a` and `b` are the same kind (comparing across kinds is meaningless). */
export function sameKind(a: UpdatableIdentity, b: UpdatableIdentity): boolean {
  return a.kind === b.kind;
}

/**
 * Is `current` behind `latest` (i.e. an update is available)?
 *
 *   - release → semver comparison (`compareSemver`), the single source of truth.
 *   - commit  → sha inequality (a different remote HEAD means new commits).
 *   - image   → digest inequality when BOTH digests are known; if either digest
 *               is unknown, fall back to ref/tag inequality. Unknown-vs-unknown
 *               (no digest either side) → NOT behind (we can't claim an update
 *               without evidence — fail-soft, never a false "update available").
 *
 * Mismatched kinds → false (never claim drift we can't reason about).
 */
export function isBehind(current: UpdatableIdentity, latest: UpdatableIdentity): boolean {
  if (current.kind !== latest.kind) return false;

  if (current.kind === "release" && latest.kind === "release") {
    return compareSemver(current.version, latest.version) < 0;
  }

  if (current.kind === "commit" && latest.kind === "commit") {
    return !!current.sha && !!latest.sha && current.sha !== latest.sha;
  }

  if (current.kind === "image" && latest.kind === "image") {
    // Compare the content digest only (the `sha256:…` part). The two sides come
    // from different sources with different prefixes — a stored RepoDigest
    // (`repo@sha256:…`) vs a registry manifest digest (`sha256:…`) — so full-
    // string comparison would falsely differ.
    const a = digestSha(current.digest);
    const b = digestSha(latest.digest);
    if (a && b) return a !== b;
    // Missing a digest on either side: only claim behind if the resolvable
    // reference actually differs; otherwise we have no evidence → not behind.
    if (current.ref && latest.ref && current.ref !== latest.ref) return true;
    return false;
  }

  return false;
}

/** Extract the `sha256:…` content digest from `repo@sha256:…` or a bare digest. */
export function digestSha(digest?: string): string | undefined {
  if (!digest) return undefined;
  const at = digest.lastIndexOf("@");
  return at >= 0 ? digest.slice(at + 1) : digest;
}

/** Compact human label for an identity — used in logs / UI subtitles. */
export function identityLabel(id: UpdatableIdentity): string {
  switch (id.kind) {
    case "commit":
      return id.sha.slice(0, 7);
    case "release":
      return id.version;
    case "image":
      return id.digest ? `${id.ref} (${id.digest.split(":").pop()?.slice(0, 12)})` : id.ref;
  }
}
