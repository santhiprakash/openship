/**
 * Permission resolver — the SINGLE SOURCE OF TRUTH for access decisions.
 *
 * Design (post-refactor):
 *
 *   1. Resources own their own scope. Every resource has `organization_id`.
 *      Access is decided by: load resource → read its org_id → check the
 *      caller's membership in that org.
 *
 *   2. There is no "active organization" mutating as a side effect of GETs.
 *      The org context for list/create endpoints comes EXPLICITLY from the
 *      request, in this priority order:
 *        1. X-Organization-Id header (set by API clients + dashboard JS)
 *        2. Session's "default org" cookie (UX fallback)
 *        3. (future) API key's bound org
 *
 *   3. The `member(user_id, organization_id, role)` table is THE relation.
 *      Every access decision hinges on a membership lookup against the
 *      resource's org. Resources do NOT carry user_id for access — that's
 *      what audit_event is for.
 *
 *   4. Detail endpoints derive org from the resource. Auto-switch is gone.
 *
 * Resource inheritance for restricted-role grants: domain/deployment/
 * service/env_var → project; backup_run/backup_restore → backup_destination;
 * build_session → project (via deployment).
 *
 * Throws `NotFoundError` (404) on deny — IDOR-safe, never confirms the
 * existence of resources the caller isn't permitted to see.
 */

import type { Context } from "hono";
import { ForbiddenError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import type { Permission, ResourceType } from "@repo/db";
import { getUserId } from "./controller-helpers";

/** Grantable resource roots — the types that can be the target of a grant. */
const GRANTABLE_ROOTS: ResourceType[] = [
  "project",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
  // Org-singleton features — listed so the resolver accepts their tags
  // even though restricted-role grants on them are unusual in practice.
  "analytics",
  "github",
  "permissions",
  "domain",
  "settings",
  "terminal",
  "cloud",
];

/** Resource types accepted by permission.check — includes leaves. */
export type CheckedResourceType =
  | ResourceType
  | "deployment"
  | "domain"
  | "service"
  | "env_var"
  | "backup_run"
  | "backup_restore"
  | "build_session";

export interface PermissionInput {
  resourceType: CheckedResourceType;
  resourceId: string;
  action: Permission;
  /**
   * Set to `"list"` for endpoints that operate on a COLLECTION (list, create-
   * in-org) rather than a specific resource. The org comes from the request
   * scope (header/cookie) instead of being derived from a resource.
   *
   * For singletons like billing/audit, pass resourceId="*" and omit scope.
   */
  scope?: "list";
}

/* ------------------------------------------------------------------ */
/*  Resource → org resolution                                          */
/* ------------------------------------------------------------------ */

interface ResolvedResource {
  orgId: string;
  rootType: ResourceType;
  rootId: string;
}

async function loadRootOrgId(
  type: ResourceType,
  id: string,
): Promise<string | null> {
  switch (type) {
    case "project": {
      const p = await repos.project.findById(id);
      return p?.organizationId ?? null;
    }
    case "server": {
      const s = await repos.server.get(id).catch(() => null);
      return s?.organizationId ?? null;
    }
    case "mail_server": {
      // Mail-server rows are keyed by server.id; the org id lives on server.
      const s = await repos.server.get(id).catch(() => null);
      return s?.organizationId ?? null;
    }
    case "backup_destination": {
      const d = await repos.backupDestination.findById(id);
      return d?.organizationId ?? null;
    }
    case "billing":
    case "audit":
      // Org-singletons — the id IS the org id (or "*" for list scope).
      // List scope is handled upstream; here we just accept the org id.
      return id === "*" ? null : id;
    default:
      return null;
  }
}

/**
 * Walk from a (possibly leaf) resource to its grantable root and return
 * the org_id that owns it. Returns null if the resource doesn't exist.
 */
async function resolveResourceOrg(
  resourceType: CheckedResourceType,
  resourceId: string,
): Promise<ResolvedResource | null> {
  if (GRANTABLE_ROOTS.includes(resourceType as ResourceType)) {
    const orgId = await loadRootOrgId(resourceType as ResourceType, resourceId);
    if (!orgId) return null;
    return { orgId, rootType: resourceType as ResourceType, rootId: resourceId };
  }

  switch (resourceType) {
    case "deployment": {
      const dep = await repos.deployment.findById(resourceId);
      if (!dep?.projectId) return null;
      const orgId = await loadRootOrgId("project", dep.projectId);
      return orgId ? { orgId, rootType: "project", rootId: dep.projectId } : null;
    }
    case "domain": {
      const d = await repos.domain.findById(resourceId);
      if (!d?.projectId) return null;
      const orgId = await loadRootOrgId("project", d.projectId);
      return orgId ? { orgId, rootType: "project", rootId: d.projectId } : null;
    }
    case "service": {
      const s = await repos.service.findById(resourceId);
      if (!s?.projectId) return null;
      const orgId = await loadRootOrgId("project", s.projectId);
      return orgId ? { orgId, rootType: "project", rootId: s.projectId } : null;
    }
    case "env_var": {
      // env_var.id → project.id → project.organizationId. Resolves so
      // restricted members with a project write-grant can mutate that
      // project's env vars (matches the header docstring's promise that
      // env_var inherits its grantable root from project).
      const ev = await repos.project.findEnvVarById(resourceId).catch(() => null);
      if (!ev?.projectId) return null;
      const orgId = await loadRootOrgId("project", ev.projectId);
      return orgId ? { orgId, rootType: "project", rootId: ev.projectId } : null;
    }
    case "backup_policy": {
      const policy = await repos.backupPolicy.findById(resourceId).catch(() => null);
      if (!policy?.destinationId) return null;
      const orgId = await loadRootOrgId("backup_destination", policy.destinationId);
      return orgId
        ? { orgId, rootType: "backup_destination", rootId: policy.destinationId }
        : null;
    }
    case "backup_run": {
      const run = await repos.backupRun.findById(resourceId).catch(() => null);
      if (!run?.destinationId) return null;
      const orgId = await loadRootOrgId("backup_destination", run.destinationId);
      return orgId
        ? { orgId, rootType: "backup_destination", rootId: run.destinationId }
        : null;
    }
    case "backup_restore": {
      const r = await repos.backupRestore.findById(resourceId).catch(() => null);
      if (!r?.destinationId) return null;
      const orgId = await loadRootOrgId("backup_destination", r.destinationId);
      return orgId
        ? { orgId, rootType: "backup_destination", rootId: r.destinationId }
        : null;
    }
    case "build_session": {
      const bs = await repos.deployment.findBuildSession(resourceId).catch(() => null);
      if (!bs?.deploymentId) return null;
      const dep = await repos.deployment.findById(bs.deploymentId);
      if (!dep?.projectId) return null;
      const orgId = await loadRootOrgId("project", dep.projectId);
      return orgId ? { orgId, rootType: "project", rootId: dep.projectId } : null;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Request scope resolution (for list/create endpoints)               */
/* ------------------------------------------------------------------ */

/**
 * Resolve the org context for list/create endpoints. Priority:
 *   1. X-Organization-Id header (explicit, authoritative)
 *   2. session.activeOrganizationId (cookie's stored default — UX fallback)
 *   3. null (caller must specify)
 *
 * Returns the org id or null if nothing is set.
 */
export function resolveRequestScopeOrg(c: Context): string | null {
  const header =
    c.req.header("X-Organization-Id") ?? c.req.header("x-organization-id");
  if (header && header.trim()) return header.trim();

  const sessionOrgId = c.get("activeOrganizationId");
  if (typeof sessionOrgId === "string" && sessionOrgId.trim()) {
    return sessionOrgId;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Pure role check (no context required)                              */
/* ------------------------------------------------------------------ */

async function roleCheck(
  userId: string,
  organizationId: string,
  input: PermissionInput,
): Promise<boolean> {
  const member = await repos.member.find(organizationId, userId);
  if (!member) return false;

  const role = (member.role ?? "member") as
    | "owner"
    | "admin"
    | "member"
    | "restricted";

  // 1. Owner: all-access.
  if (role === "owner") return true;

  // 2. Admin: everything except billing (owner-only).
  if (role === "admin") {
    if (input.resourceType === "billing") return false;
    return true;
  }

  // 3. Member: read+write on org resources; never on billing or audit.
  if (role === "member") {
    if (input.resourceType === "billing" || input.resourceType === "audit") {
      return false;
    }
    return true;
  }

  // 4. Restricted: only explicit grants.
  if (role === "restricted") {
    const root = await resolveResourceOrg(input.resourceType, input.resourceId);
    if (!root) return false;
    const grant = await repos.resourceGrant.findForResource(
      organizationId,
      userId,
      root.rootType,
      root.rootId,
    );
    if (!grant) return false;

    // Exhaustive switch — adding a new Permission value (delete/list/etc.)
    // without updating this arm fails the build via the `never` check.
    switch (input.action) {
      case "read":
        return grant.permissions.some(
          (p) => p === "read" || p === "write" || p === "admin",
        );
      case "write":
        return grant.permissions.some((p) => p === "write" || p === "admin");
      case "admin":
        return grant.permissions.includes("admin");
      default: {
        const _exhaustive: never = input.action;
        return false;
      }
    }
  }

  return false;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pure resolver — userId + orgId in, boolean out. Used in places where
 * a Hono context isn't available (background jobs, hooks).
 *
 * For resource-detail input, the CALLER is responsible for already having
 * verified that organizationId matches the resource's org. Prefer `check()`
 * with a context — it does the verification for you.
 */
export async function checkPermission(
  userId: string,
  organizationId: string,
  input: PermissionInput,
): Promise<boolean> {
  return roleCheck(userId, organizationId, input);
}

/**
 * Hono-context check. Derives org from the resource (detail endpoints) or
 * the request scope (list/create endpoints), then runs the role check.
 *
 * SIDE EFFECT: on success, stashes the resolved org id under
 * `c.set("scopedOrganizationId", orgId)` so downstream controllers can read
 * "which org am I operating in" without re-deriving.
 */
export async function check(c: Context, input: PermissionInput): Promise<boolean> {
  const userId = getUserId(c);

  let organizationId: string;

  if (input.scope === "list") {
    const resolved = resolveRequestScopeOrg(c);
    if (!resolved) return false;
    organizationId = resolved;
  } else if (input.resourceId === "*") {
    // Org-singleton (billing/audit) — org from request scope.
    const resolved = resolveRequestScopeOrg(c);
    if (!resolved) return false;
    organizationId = resolved;
  } else {
    const resource = await resolveResourceOrg(input.resourceType, input.resourceId);
    if (!resource) return false;
    organizationId = resource.orgId;
  }

  const allowed = await roleCheck(userId, organizationId, input);
  if (allowed) {
    c.set("scopedOrganizationId", organizationId);
  }
  return allowed;
}

/**
 * Assert version — throws 404 on deny so out-of-permission resources
 * don't leak existence via 403s. The IDOR-safe pattern.
 */
export async function assert(c: Context, input: PermissionInput): Promise<void> {
  const allowed = await check(c, input);
  if (!allowed) {
    throw new NotFoundError(input.resourceType, input.resourceId);
  }
}

/**
 * Like `assert` but throws 403 instead of 404. Use ONLY when the caller
 * already knows the resource exists (e.g. they just listed it) but lacks
 * the specific action permission. Default to `assert` for safety.
 */
export async function require_(c: Context, input: PermissionInput): Promise<void> {
  const allowed = await check(c, input);
  if (!allowed) {
    throw new ForbiddenError(
      `Insufficient permissions for ${input.action} on ${input.resourceType}`,
    );
  }
}

/**
 * Helper exported for controllers that need the resolved org id directly
 * (e.g. to stamp it on a new resource at create time). Reads what
 * `check()` stashed; falls back to deriving from the request scope.
 */
export function getScopedOrgId(c: Context): string {
  const stashed = c.get("scopedOrganizationId");
  if (typeof stashed === "string" && stashed) return stashed;
  const resolved = resolveRequestScopeOrg(c);
  if (!resolved) {
    throw new Error(
      "No organization scope in context. Caller must run requirePermission() or provide X-Organization-Id header.",
    );
  }
  return resolved;
}

export const permission = {
  check,
  checkPermission,
  assert,
  require: require_,
  resolveRequestScopeOrg,
  getScopedOrgId,
};
