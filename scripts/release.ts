#!/usr/bin/env bun
/**
 * Cut a new Openship release.
 *
 * Usage:
 *   bun scripts/release.ts patch          # 0.1.0      → 0.1.1
 *   bun scripts/release.ts minor          # 0.1.0      → 0.2.0
 *   bun scripts/release.ts major          # 0.1.0      → 1.0.0
 *   bun scripts/release.ts rc             # 0.1.0      → 0.1.1-rc.1
 *                                         # 0.1.1-rc.1 → 0.1.1-rc.2
 *                                         # 0.1.1-rc.2 → 0.1.1     (promote: rc → stable)
 *   bun scripts/release.ts <explicit>     # set to literal "0.2.0-beta.3"
 *   bun scripts/release.ts --dry-run patch
 *
 * What it does:
 *   1. Refuse if working tree is dirty
 *   2. Refuse if not on main (override with --force-branch)
 *   3. Refuse if HEAD is behind origin/main (you'd push an old commit)
 *   4. Compute next version from apps/api/package.json
 *   5. Sync both root package.json and apps/api/package.json
 *   6. Commit "Bump to vX.Y.Z"
 *   7. Push the bump commit to main
 *   8. Tag vX.Y.Z and push the tag
 *   9. Print the GitHub Actions URL so you can watch
 *
 * The tag-push triggers .github/workflows/release.yml which builds both
 * dist tarballs + SHA-256 sidecars and publishes a GitHub Release.
 * Tags containing `-` (rc.N, beta.N) become prereleases automatically.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT_PKG = join(ROOT, "package.json");
const API_PKG = join(ROOT, "apps/api/package.json");
// Every package.json whose version should track the release. API is the
// operative source the next version is computed from; the rest are synced to
// match so the desktop app (forge reads apps/desktop/package.json), web,
// email, and the npm-published CLI all report the same version as the tag.
const SYNCED_PKGS = [
  ROOT_PKG,
  API_PKG,
  join(ROOT, "apps/desktop/package.json"),
  join(ROOT, "apps/web/package.json"),
  join(ROOT, "apps/email/package.json"),
  join(ROOT, "apps/cli/package.json"),
];

/* ─── CLI parsing ──────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forceBranch = args.includes("--force-branch");
if (args.includes("--help") || args.includes("-h")) usageAndExit();
const cmd = args.find((a) => !a.startsWith("--"));

type BumpKind = "patch" | "minor" | "major" | "rc" | "current" | "literal";
// No arg (or "current") → release the version already in package.json as-is,
// no bump. Otherwise bump / set the version.
const bump: { kind: BumpKind; literal?: string } =
  !cmd || cmd === "current"
    ? { kind: "current" }
    : cmd === "patch" || cmd === "minor" || cmd === "major" || cmd === "rc"
      ? { kind: cmd }
      : { kind: "literal", literal: cmd };

if (bump.kind === "literal" && !/^\d+\.\d+\.\d+(-[a-z0-9]+(\.\d+)?)?$/i.test(bump.literal!)) {
  console.error(`Refusing literal version "${bump.literal}" — not a semver string.`);
  process.exit(1);
}

/* ─── Pre-flight checks ────────────────────────────────────────────── */

if (!dryRun) {
  preflight();
}

/* ─── Version compute ──────────────────────────────────────────────── */

const currentApi = readVersion(API_PKG);
const currentRoot = readVersion(ROOT_PKG);
if (currentApi !== currentRoot) {
  log(
    `⚠️  Version drift detected: root=${currentRoot}, apps/api=${currentApi}. ` +
      `Bumping from apps/api's (operative) value.`,
  );
}

const next = computeNext(currentApi, bump);
const tag = `v${next}`;

log(`Current version (apps/api): ${currentApi}`);
log(`Next version:               ${next}`);
log(`Tag:                        ${tag}`);
log(`Prerelease:                 ${tag.includes("-") ? "yes" : "no"}`);
log(``);

if (dryRun) {
  if (bump.kind === "current") {
    log(`[dry-run] would tag the current version (no bump) and push ${tag}`);
  } else {
    log(`[dry-run] would update:`);
    for (const p of SYNCED_PKGS) log(`  - ${p}`);
    log(`[dry-run] would commit + push, then tag + push ${tag}`);
  }
  log(`[dry-run] no files written, no git ops executed.`);
  process.exit(0);
}

if (tagExists(tag)) {
  console.error(
    `Refusing: tag ${tag} already exists. ` +
      (bump.kind === "current"
        ? `Bump the version (patch/minor/major) instead of re-releasing ${tag}.`
        : `Pick a different version.`),
  );
  process.exit(1);
}

/* ─── Apply ─────────────────────────────────────────────────────────── */

if (bump.kind === "current") {
  // No version change — release exactly what's committed.
  git("push", "origin", `refs/heads/${currentBranch()}`);
  log(`✓ pushed ${currentBranch()} (releasing current version, no bump)`);
} else {
  for (const p of SYNCED_PKGS) writeVersion(p, next);
  log(`✓ updated ${SYNCED_PKGS.length} package.json files`);

  git("add", ...SYNCED_PKGS);
  // Only commit if the version actually changed. Re-releasing the version you're
  // already on (e.g. after a failed tag push) writes no diff, and `git commit`
  // would abort with "nothing to commit" and kill the release. Skip the commit
  // in that case and ship the already-committed version as-is.
  const nothingStaged =
    spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT }).status === 0;
  if (nothingStaged) {
    log(`Version already ${next} — no bump commit needed, releasing as-is.`);
  } else {
    git("commit", "-m", `Bump to ${tag}`);
    log(`✓ committed`);
  }

  git("push", "origin", `refs/heads/${currentBranch()}`);
  log(`✓ pushed ${currentBranch()}`);
}

git("tag", tag);
// Fully-qualified refspec: a BRANCH sharing the tag's name (e.g. a leftover
// `v0.2.0` branch) would otherwise make `git push origin v0.2.0` ambiguous
// ("src refspec … matches more than one").
git("push", "origin", `refs/tags/${tag}`);
log(`✓ pushed tag ${tag} — CI is building installers for macOS, Windows & Linux`);

/* ─── Final report ─────────────────────────────────────────────────── */

const remoteUrl = git("remote", "get-url", "origin", { capture: true }).trim();
const ghMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
const actionsUrl = ghMatch ? `https://github.com/${ghMatch[1]}/${ghMatch[2]}/actions` : "";
if (ghMatch) {
  const [, owner, repo] = ghMatch;
  log(``);
  log(`Release will appear at:`);
  log(`  https://github.com/${owner}/${repo}/releases/tag/${tag}`);
  log(``);
}

// Stream the live build status right here in the terminal.
watchCi(tag, actionsUrl);

/* ─── Helpers ──────────────────────────────────────────────────────── */

function usageAndExit(): never {
  console.error(
    [
      "Usage: bun scripts/release.ts [current|patch|minor|major|rc|x.y.z[-rc.N]] [--dry-run] [--force-branch]",
      "",
      "  (no arg)       release the current version as-is (no bump)",
      "  current        same as no arg",
      "  patch          0.1.0      → 0.1.1",
      "  minor          0.1.0      → 0.2.0",
      "  major          0.1.0      → 1.0.0",
      "  rc             0.1.0      → 0.1.1-rc.1",
      "                 0.1.1-rc.1 → 0.1.1-rc.2",
      "                 0.1.1-rc.2 → 0.1.1   (rc → stable promotion)",
      "  <literal>      explicit semver string",
      "",
      "  --dry-run      print the plan, don't touch anything",
      "  --force-branch run from a non-main branch (default refuses)",
      "",
      "In every case CI builds installers for macOS (arm64 + x64), Windows,",
      "and Linux and publishes them to the GitHub release. Live build status",
      "streams here after the tag is pushed (needs the `gh` CLI, logged in).",
    ].join("\n"),
  );
  process.exit(1);
}

/** True if the tag already exists locally or on origin. */
function tagExists(t: string): boolean {
  const local = git("tag", "--list", t, { capture: true }).trim();
  if (local) return true;
  const remote = git("ls-remote", "--tags", "origin", t, { capture: true }).trim();
  return remote.length > 0;
}

/**
 * Stream the live status of the release workflow run into this terminal.
 * Uses the `gh` CLI (`gh run watch`), which shows each job spinning →
 * pass/fail and exits when the run finishes. Degrades gracefully (prints the
 * Actions URL) if `gh` is missing, not authed, or the run isn't found yet.
 */
function watchCi(t: string, fallbackUrl: string): void {
  const have = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (have.status !== 0) {
    if (fallbackUrl) log(`Watch the build:  ${fallbackUrl}`);
    return;
  }

  log(`Waiting for the release run to register on GitHub…`);
  let runId = "";
  for (let i = 0; i < 15 && !runId; i++) {
    Bun.sleepSync(4000);
    const out = spawnSync(
      "gh",
      ["run", "list", "--workflow", "release.yml", "--limit", "15", "--json", "databaseId,headBranch,event,createdAt"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (out.status !== 0) continue;
    try {
      const runs = JSON.parse(out.stdout ?? "[]") as Array<{
        databaseId: number;
        headBranch: string;
        event: string;
      }>;
      // Tag-triggered runs show headBranch === the tag name.
      const match = runs.find((r) => r.headBranch === t || r.headBranch === `refs/tags/${t}`);
      if (match) runId = String(match.databaseId);
    } catch {
      // keep polling
    }
  }

  if (!runId) {
    log(`Couldn't locate the run automatically.`);
    if (fallbackUrl) log(`Watch the build:  ${fallbackUrl}`);
    return;
  }

  log(``);
  log(`▼ live build status (Ctrl-C to stop watching — the build keeps running):`);
  log(``);
  // Streams job-by-job status and exits when the run completes.
  spawnSync("gh", ["run", "watch", runId, "--interval", "6"], { cwd: ROOT, stdio: "inherit" });
  log(``);
  spawnSync("gh", ["run", "view", runId], { cwd: ROOT, stdio: "inherit" });
}

function preflight(): void {
  // 1. Clean working tree
  const status = git("status", "--porcelain", { capture: true }).trim();
  if (status) {
    console.error(
      `Refusing: working tree is dirty. Commit or stash first.\n${status}`,
    );
    process.exit(1);
  }

  // 2. On main
  const branch = currentBranch();
  if (branch !== "main" && !forceBranch) {
    console.error(
      `Refusing: current branch is "${branch}", not "main". ` +
        `Pass --force-branch to release from a different branch.`,
    );
    process.exit(1);
  }

  // 3. Up-to-date with origin (refuse if behind — would push a stale tag)
  git("fetch", "origin", branch);
  const behind = git("rev-list", "--count", `HEAD..origin/${branch}`, { capture: true }).trim();
  if (behind !== "0") {
    console.error(
      `Refusing: local "${branch}" is ${behind} commit(s) behind origin. Pull first.`,
    );
    process.exit(1);
  }
}

function currentBranch(): string {
  return git("rev-parse", "--abbrev-ref", "HEAD", { capture: true }).trim();
}

function readVersion(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (!pkg.version) {
    console.error(`Refusing: ${pkgPath} has no "version" field.`);
    process.exit(1);
  }
  return pkg.version;
}

function writeVersion(pkgPath: string, next: string): void {
  const raw = readFileSync(pkgPath, "utf8");
  const re = /("version"\s*:\s*")[^"]+(")/;
  // Error only if the field is genuinely absent — NOT when it's already at the
  // target value (a no-op, common when syncing a drifted package.json).
  if (!re.test(raw)) {
    console.error(`Refusing: could not locate version field in ${pkgPath}.`);
    process.exit(1);
  }
  // Preserve formatting + trailing newline. Surgical replacement of the
  // version field rather than full re-serialization avoids reformatting
  // the whole file (which would create noisy diffs).
  const replaced = raw.replace(re, (_, a, b) => `${a}${next}${b}`);
  if (replaced !== raw) writeFileSync(pkgPath, replaced);
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** e.g. "rc.1", "beta.3" — undefined when stable. */
  prerelease?: string;
}

function parseSemver(v: string): SemverParts {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) {
    console.error(`Refusing: "${v}" is not a parseable semver.`);
    process.exit(1);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
}

function formatSemver(p: SemverParts): string {
  const base = `${p.major}.${p.minor}.${p.patch}`;
  return p.prerelease ? `${base}-${p.prerelease}` : base;
}

function computeNext(current: string, bump: { kind: BumpKind; literal?: string }): string {
  if (bump.kind === "current") return current;
  if (bump.kind === "literal") return bump.literal!;
  const parsed = parseSemver(current);
  switch (bump.kind) {
    case "patch":
      return formatSemver({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + (parsed.prerelease ? 0 : 1) });
    case "minor":
      return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
    case "major":
      return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0 });
    case "rc": {
      // rc → next rc OR rc → stable promotion
      if (parsed.prerelease) {
        const rcMatch = parsed.prerelease.match(/^rc\.(\d+)$/);
        if (rcMatch) {
          // currently rc.N — bump to rc.(N+1)
          return formatSemver({ ...parsed, prerelease: `rc.${Number(rcMatch[1]) + 1}` });
        }
        // some other prerelease (beta.N etc.) — bump patch + start rc.1
        return formatSemver({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch + 1,
          prerelease: "rc.1",
        });
      }
      // stable → next patch rc.1
      return formatSemver({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
        prerelease: "rc.1",
      });
    }
  }
}

function git(
  ...args: [string, ...(string | { capture: true })[]]
): string;
function git(
  ...args: string[]
): string;
function git(...args: (string | { capture: true })[]): string {
  const last = args[args.length - 1];
  const capture = typeof last === "object" && last !== null && (last as { capture?: boolean }).capture === true;
  const realArgs = (capture ? args.slice(0, -1) : args) as string[];
  const result = spawnSync("git", realArgs, {
    cwd: ROOT,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`git ${realArgs.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  return capture ? (result.stdout ?? "") : "";
}

function log(msg: string): void {
  console.log(msg);
}
