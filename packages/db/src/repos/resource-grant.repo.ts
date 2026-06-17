/**
 * Resource grant repo — fine-grained access overrides for restricted members.
 *
 * The permission resolver at apps/api/src/lib/permission.ts is the only
 * code that should consult this table for access decisions. Controllers
 * call `permission.assert(c, ...)` and never read grants directly.
 */

import { and, eq, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { resourceGrant } from "../schema/resource-grant";

export type ResourceGrantRow = typeof resourceGrant.$inferSelect;
export type Permission = "read" | "write" | "admin";
export type ResourceType =
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit"
  | "analytics"
  | "github"
  | "permissions"
  | "domain"
  | "settings"
  | "terminal"
  | "cloud"
  | "notifications"
  | "service"
  | "deployment"
  | "backup_policy"
  | "backup_run"
  | "backup_restore";

export interface ResourceGrant {
  id: string;
  organizationId: string;
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  permissions: Permission[];
  grantedByUserId: string | null;
  createdAt: Date;
}

function rowToGrant(row: ResourceGrantRow): ResourceGrant {
  let permissions: Permission[] = [];
  try {
    const parsed = JSON.parse(row.permissionsJson);
    if (Array.isArray(parsed)) {
      permissions = parsed.filter(
        (p): p is Permission => p === "read" || p === "write" || p === "admin",
      );
    }
  } catch {
    permissions = [];
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    resourceType: row.resourceType as ResourceType,
    resourceId: row.resourceId,
    permissions,
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt,
  };
}

export function createResourceGrantRepo(db: Database) {
  return {
    /** All grants for a single (org, user) pair — powers the member detail panel. */
    async listByMember(organizationId: string, userId: string): Promise<ResourceGrant[]> {
      const rows = await db
        .select()
        .from(resourceGrant)
        .where(
          and(eq(resourceGrant.organizationId, organizationId), eq(resourceGrant.userId, userId)),
        );
      return rows.map(rowToGrant);
    },

    /**
     * Find the grant covering a specific resource. Used by the permission
     * resolver — checks (orgId, userId, resourceType, resourceId) AND
     * the wildcard row (resourceType, '*'). Returns whichever grants the
     * requested action, or null.
     */
    async findForResource(
      organizationId: string,
      userId: string,
      resourceType: ResourceType,
      resourceId: string,
    ): Promise<ResourceGrant | null> {
      const rows = await db
        .select()
        .from(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            eq(resourceGrant.userId, userId),
            eq(resourceGrant.resourceType, resourceType),
            sql`(${resourceGrant.resourceId} = ${resourceId} OR ${resourceGrant.resourceId} = '*')`,
          ),
        );
      // If both a specific grant and a wildcard exist, prefer the specific.
      const specific = rows.find((r) => r.resourceId === resourceId);
      return specific
        ? rowToGrant(specific)
        : rows.length > 0
          ? rowToGrant(rows[0])
          : null;
    },

    /**
     * Upsert a grant — replaces the permissions array if a row already
     * exists for the same (org, user, resourceType, resourceId). Atomic
     * via the unique index defined in the schema.
     */
    async upsert(input: {
      organizationId: string;
      userId: string;
      resourceType: ResourceType;
      resourceId: string;
      permissions: Permission[];
      grantedByUserId: string | null;
    }): Promise<ResourceGrant> {
      const id = generateId("grant");
      const permissionsJson = JSON.stringify(input.permissions);

      await db
        .insert(resourceGrant)
        .values({
          id,
          organizationId: input.organizationId,
          userId: input.userId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          permissionsJson,
          grantedByUserId: input.grantedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            resourceGrant.organizationId,
            resourceGrant.userId,
            resourceGrant.resourceType,
            resourceGrant.resourceId,
          ],
          set: { permissionsJson, grantedByUserId: input.grantedByUserId },
        });

      // Return the canonical row (id may differ if conflict updated existing).
      const found = await this.findForResource(
        input.organizationId,
        input.userId,
        input.resourceType,
        input.resourceId,
      );
      return found!;
    },

    /** Lookup by primary key. Org-scoped — wrong-org callers get null. */
    async findById(id: string, organizationId: string): Promise<ResourceGrant | null> {
      const [row] = await db
        .select()
        .from(resourceGrant)
        .where(
          and(eq(resourceGrant.id, id), eq(resourceGrant.organizationId, organizationId)),
        )
        .limit(1);
      return row ? rowToGrant(row) : null;
    },

    async delete(id: string, organizationId: string): Promise<void> {
      await db
        .delete(resourceGrant)
        .where(
          and(eq(resourceGrant.id, id), eq(resourceGrant.organizationId, organizationId)),
        );
    },

    /** Bulk-delete grants for a specific resource (called on resource deletion). */
    async deleteForResource(
      organizationId: string,
      resourceType: ResourceType,
      resourceId: string,
    ): Promise<void> {
      await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            eq(resourceGrant.resourceType, resourceType),
            eq(resourceGrant.resourceId, resourceId),
          ),
        );
    },

    /**
     * Bulk-delete all grants for a (org, user) pair. Called from the
     * Better Auth `afterRemoveMember` hook so a user's grants disappear
     * the moment they lose membership. Without this, orphan rows linger
     * (the permission resolver short-circuits on missing membership so
     * they're security-inert, but they're still data debt).
     */
    async deleteByMember(organizationId: string, userId: string): Promise<void> {
      await db
        .delete(resourceGrant)
        .where(
          and(
            eq(resourceGrant.organizationId, organizationId),
            eq(resourceGrant.userId, userId),
          ),
        );
    },
  };
}
