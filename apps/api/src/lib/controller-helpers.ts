/**
 * Shared controller helpers - used across all Hono route handlers.
 *
 * Eliminates duplication of getUserId / param / platform() across controllers.
 */

import type { Context } from "hono";
import {
  initPlatform,
  getPlatform,
  type Platform,
  type PlatformTarget,
  type PlatformConfig,
} from "@repo/adapters";
import { env } from "../config/env";
import { isOblienConfigured } from "./platform-mode";

// ─── Auth helpers ────────────────────────────────────────────────────────────

/** Extract the authenticated user ID from Hono context */
export function getUserId(c: Context): string {
  const user = c.get("user");
  if (!user?.id) throw new Error("Unauthorized: no user in context");
  return user.id;
}

/**
 * Extract the active organization ID from Hono context.
 * Set by activeOrganizationMiddleware — every authed route should mount
 * that middleware after authMiddleware.
 */
export function getActiveOrganizationId(c: Context): string {
  const orgId = c.get("activeOrganizationId");
  if (!orgId || typeof orgId !== "string") {
    throw new Error("No active organization in context");
  }
  return orgId;
}

/** Combined getter — both userId (actor) and activeOrgId (scoping). */
export function getActorContext(c: Context): { userId: string; organizationId: string } {
  return {
    userId: getUserId(c),
    organizationId: getActiveOrganizationId(c),
  };
}

/**
 * Assert a resource belongs to the caller's active organization. Throws a
 * 404-shaped error if it doesn't, to avoid leaking the resource's existence
 * across orgs (404, not 403 — IDOR-safe).
 *
 * Use on every per-resource detail/update/delete endpoint:
 *   const project = await repos.project.findById(id);
 *   assertResourceInOrg(project, "Project", organizationId);
 *
 * Resources with `organizationId === null` are rejected (fail-closed).
 * Use `requireResourceInOrg` for an explicit strict variant.
 */
import { NotFoundError } from "@repo/core";

export function assertResourceInOrg<T extends { organizationId?: string | null }>(
  resource: T | null | undefined,
  resourceLabel: string,
  organizationId: string,
  resourceId?: string,
): asserts resource is T {
  if (!resource) {
    throw new NotFoundError(resourceLabel, resourceId);
  }
  // 404-shape rather than 403 — never confirm existence of out-of-org
  // resources. NULL org_id is treated as "not in any org" and fails closed.
  if (resource.organizationId !== organizationId) {
    throw new NotFoundError(resourceLabel, resourceId);
  }
}

/**
 * Stricter version: rejects resources with NULL organizationId too.
 * Use this in NEW code paths where every resource should be org-stamped.
 */
export function requireResourceInOrg<T extends { organizationId?: string | null }>(
  resource: T | null | undefined,
  resourceLabel: string,
  organizationId: string,
  resourceId?: string,
): asserts resource is T {
  if (!resource || resource.organizationId !== organizationId) {
    throw new NotFoundError(resourceLabel, resourceId);
  }
}

/** Extract and validate a required route parameter */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

// ─── Platform resolution ─────────────────────────────────────────────────────

/**
 * Resolve the deployment target from environment config.
 *
 * CLOUD_MODE (SaaS hosting) and DEPLOY_MODE=cloud (Oblien runtime) both
 * need the cloud platform adapter, so either triggers the cloud config.
 * Auth/billing concerns are gated separately by CLOUD_MODE alone.
 *
 * Priority:
 *   1. CLOUD_MODE=true or DEPLOY_MODE=cloud → "cloud" (Oblien runtime)
 *   2. DEPLOY_MODE=desktop → "desktop"
 *   3. Default → "selfhosted" with docker or bare runtime
 */
function resolveConfig(): PlatformConfig {
  if (isOblienConfigured()) {
    return {
      target: "cloud",
      cloudClientId: env.OBLIEN_CLIENT_ID,
      cloudClientSecret: env.OBLIEN_CLIENT_SECRET,
    };
  }

  if (env.DEPLOY_MODE === "desktop") {
    return { target: "desktop" };
  }

  // Self-hosted: docker or bare
  return {
    target: "selfhosted",
    runtime: env.DEPLOY_MODE === "bare" ? "bare" : "docker",
  };
}

/**
 * Initialize the platform at server startup.
 *
 * Call this ONCE before the server starts handling requests.
 * After this, `platform()` returns the cached instance synchronously.
 */
export async function bootstrapPlatform(): Promise<Platform> {
  return initPlatform(resolveConfig());
}

/**
 * Get the platform - the single entry point for all service code.
 *
 * Returns: { runtime, routing, ssl, system }
 *   - runtime: build/deploy/stop/start lifecycle
 *   - routing: register/remove reverse-proxy routes
 *   - ssl: provision/renew TLS certificates
 *   - system: prerequisite validation (self-hosted only, null otherwise)
 *
 * All service code uses this. Nothing constructs adapters directly.
 */
export function platform(): Platform {
  return getPlatform();
}

// ─── Project access ──────────────────────────────────────────────────────────


// Access-control model:
//   - Route-level `requirePermission` middleware loads the resource and
//     verifies org membership before the controller runs.
//   - For list/create endpoints, the org is resolved from the
//     X-Organization-Id header (or the session default cookie).
//   - Service layers receive `organizationId` directly from controllers
//     and use `assertResourceInOrg(...)` for defense-in-depth.
//
// For a user-scoped access check, use `permission.assert(c, {...})` or
// `assertResourceInOrg(resource, ...)`.
