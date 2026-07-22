/**
 * Advisory parsing + resolution. Pure functions over already-fetched data so
 * both the desktop main process and the dashboard share identical logic.
 */

import type {
  Advisory,
  AdvisoryManifest,
  AdvisorySeverity,
  LatestRelease,
  UpdateState,
} from "./types";
import { changelogUrl } from "./types";
import { compareSemver, satisfiesRange } from "./semver";

const SEVERITY_RANK: Record<AdvisorySeverity, number> = { critical: 0, recommended: 1, info: 2 };
const VALID_SEVERITY = new Set<AdvisorySeverity>(["critical", "recommended", "info"]);

/**
 * Parse + validate an UNTRUSTED manifest (fetched from GitHub raw). Malformed
 * entries are dropped rather than trusted — this is third-party-authored data
 * as far as any single client is concerned, so we treat it defensively.
 */
export function parseManifest(raw: unknown): AdvisoryManifest {
  const list = (raw as { advisories?: unknown } | null)?.advisories;
  if (!Array.isArray(list)) return { advisories: [] };

  const advisories: Advisory[] = [];
  for (const item of list) {
    const a = item as Partial<Advisory> | null;
    if (
      typeof a?.id !== "string" ||
      typeof a?.affects !== "string" ||
      typeof a?.title !== "string" ||
      typeof a?.message !== "string" ||
      !VALID_SEVERITY.has(a?.severity as AdvisorySeverity)
    ) {
      continue;
    }
    const advisory: Advisory = {
      id: a.id,
      severity: a.severity as AdvisorySeverity,
      affects: a.affects,
      title: a.title,
      message: a.message,
    };
    const action = a.action;
    if (
      action &&
      typeof action.label === "string" &&
      (action.kind === "update" || action.kind === "open-url" || action.kind === "update-entity")
    ) {
      advisory.action = {
        label: action.label,
        kind: action.kind,
        ...(typeof action.url === "string" ? { url: action.url } : {}),
        ...(typeof action.entityId === "string" ? { entityId: action.entityId } : {}),
      };
    }
    const target = a.target;
    if (
      target &&
      (target.type === "platform" ||
        target.type === "app" ||
        target.type === "project" ||
        target.type === "mail")
    ) {
      advisory.target = {
        type: target.type,
        ...(typeof target.id === "string" ? { id: target.id } : {}),
      };
    }
    advisories.push(advisory);
  }
  return { advisories };
}

/** Advisories whose `affects` range includes `currentVersion`, most severe first. */
export function matchAdvisories(currentVersion: string, manifest: AdvisoryManifest): Advisory[] {
  return manifest.advisories
    .filter((a) => {
      try {
        return satisfiesRange(currentVersion, a.affects);
      } catch {
        return false;
      }
    })
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
}

export interface ResolveUpdateInput {
  currentVersion: string;
  latestRelease: LatestRelease | null;
  manifest: AdvisoryManifest | null;
  /** Advisory ids the user already dismissed (ignored for critical). */
  dismissed?: readonly string[];
  /** User disabled follow-up notifications. Critical advisories still surface once. */
  muted?: boolean;
}

/**
 * Fold fetched data + user prefs into what the UI should show. The muting rule
 * encodes the product decision: a `critical` advisory is ALWAYS shown once;
 * `recommended`/`info` respect the mute toggle and per-id dismissal.
 */
export function resolveUpdateState(input: ResolveUpdateInput): UpdateState {
  const { currentVersion, latestRelease, manifest, dismissed = [], muted = false } = input;

  const latestVersion = latestRelease?.version ?? null;
  const updateAvailable = !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;

  const advisories = (manifest ? matchAdvisories(currentVersion, manifest) : []).filter((a) => {
    if (a.severity === "critical") return true;
    if (muted) return false;
    return !dismissed.includes(a.id);
  });

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    advisories,
    changelogUrl: changelogUrl(),
    latestChangelogUrl: changelogUrl(latestRelease?.tag),
  };
}
