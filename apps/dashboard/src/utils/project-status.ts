import type { Dictionary } from "@/i18n";

export type ProjectStatus =
  | "live"
  | "attention"
  | "queued"
  | "building"
  | "deploying"
  | "failed"
  | "cancelled"
  | "deleting"
  | "draft";

type ProjectStatusSource = {
  activeDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;
  /** True when the live release is a partial-failure deploy still awaiting the
   *  operator's keep/reject decision — surfaced as "Action Required", never
   *  "Live". */
  awaitingDecision?: boolean | null;
  /** True when the live release deployed fine but its free .opsh.io edge route
   *  didn't sync — also surfaced as "Action Required", with a Retry routing
   *  action (distinct from the keep/reject decision above). */
  routingUnsynced?: boolean | null;
  deletedAt?: string | null;
  /** True while an atomic teardown is in flight (the real in-progress flag;
   *  teardown hard-deletes on success, so `deletedAt` is rarely set). */
  deletionInProgress?: boolean | null;
  /** Marks the Openship control-plane self-app. It IS the running host service and
   *  has no deployment behind it, so it must never fall through to "draft". */
  appTemplateId?: string | null;
  isApp?: boolean | null;
  hasServer?: boolean | null;
};

// CSS-only presentation. The human-readable label is resolved from the
// active dictionary via `projectStatusLabel(status, t)` so badges localize.
export const PROJECT_STATUS_META: Record<
  ProjectStatus,
  { badge: string; dot: string }
> = {
  live: {
    badge: "bg-success-bg text-success",
    dot: "bg-success-solid",
  },
  attention: {
    badge: "bg-warning-bg text-warning",
    dot: "bg-warning-solid",
  },
  queued: {
    badge: "bg-info-bg text-info",
    dot: "bg-info-solid",
  },
  building: {
    badge: "bg-info-bg text-info",
    dot: "bg-info-solid",
  },
  deploying: {
    // primary = brand accent, intentionally not a status token.
    badge: "bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  failed: {
    badge: "bg-danger-bg text-danger",
    dot: "bg-danger-solid",
  },
  cancelled: {
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  deleting: {
    badge: "bg-danger-bg text-danger",
    dot: "bg-danger-solid animate-pulse",
  },
  draft: {
    badge: "bg-warning-bg text-warning",
    dot: "bg-warning-solid",
  },
};

/** Localized status label for a project/deployment status pill. */
export function projectStatusLabel(status: ProjectStatus, t: Dictionary): string {
  return t.projects.status[status];
}

export function getProjectStatus(project: ProjectStatusSource): ProjectStatus {
  if (project.deletedAt || project.deletionInProgress) {
    return "deleting";
  }

  // The Openship control-plane self-app IS the running host process; it has no
  // deployment record, so it must never render as "draft" with a "Deploy now"
  // CTA. If you can see the dashboard, it's live.
  if (project.appTemplateId === "openship") {
    return "live";
  }

  switch (project.latestDeploymentStatus) {
    case "queued":
      return "queued";
    case "building":
      return "building";
    case "deploying":
      return "deploying";
    default:
      break;
  }

  // A live release that still needs the operator: either a partial-failure
  // deploy awaiting keep/reject, or one whose free-domain edge route didn't
  // sync. Both flag "Action Required" — never the green "Live".
  if (project.awaitingDecision || project.routingUnsynced) {
    return "attention";
  }

  if (project.activeDeploymentId) {
    return "live";
  }

  switch (project.latestDeploymentStatus) {
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "draft";
  }
}