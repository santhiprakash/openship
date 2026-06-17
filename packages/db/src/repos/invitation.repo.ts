/**
 * Invitation repo — reads on the `invitation` table managed by the Better
 * Auth organization plugin.
 *
 * The plugin owns the WRITE path (inviteMember, acceptInvitation,
 * rejectInvitation, cancelInvitation) through Better Auth's own DB
 * adapter. We READ here from outside the plugin — for rate-limiting,
 * audit emission, and any future per-org invitation listings.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { db as Db } from "../client";
import { invitation } from "../schema/organization";

export type Invitation = typeof invitation.$inferSelect;

export function createInvitationRepo(db: typeof Db) {
  return {
    /**
     * Count invitations created by a given inviter since `since`.
     * Used to enforce the per-user invitation rate limit before the
     * organization plugin inserts a fresh row.
     */
    async countByInviterSince(inviterId: string, since: Date): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(invitation)
        .where(
          and(
            eq(invitation.inviterId, inviterId),
            gte(invitation.createdAt, since),
          ),
        );
      // node-postgres returns count as a string; pglite returns a number.
      const raw = rows[0]?.n ?? 0;
      return typeof raw === "string" ? Number(raw) : raw;
    },

    /** Find a single invitation by id. Returns undefined when missing. */
    async findById(id: string): Promise<Invitation | undefined> {
      const [row] = await db
        .select()
        .from(invitation)
        .where(eq(invitation.id, id))
        .limit(1);
      return row;
    },

    /**
     * List pending invitations for an organization. Used by the
     * admin's "team management" view to show the in-flight invites
     * alongside members. Status filter is exclusive — only "pending"
     * rows are returned. Accepted/rejected/canceled/expired are not.
     */
    async listPendingByOrg(organizationId: string): Promise<Invitation[]> {
      return db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.status, "pending"),
          ),
        );
    },
  };
}
