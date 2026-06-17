import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Database } from "../client";
import { gitInstallation } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GitInstallation = typeof gitInstallation.$inferSelect;
export type NewGitInstallation = typeof gitInstallation.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGitInstallationRepo(db: Database) {
  return {
    /** Find installation by user + owner */
    async findByOwner(userId: string, owner: string) {
      return db.query.gitInstallation.findFirst({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.owner, owner.toLowerCase()),
        ),
      });
    },

    /**
     * Find installation by organization + owner.
     *
     * Multi-user/org scoping path: a single GitHub App installation may be
     * accessed by any member of the owning org. Resolution by org is the
     * preferred path for multi-user — `findByOwner(userId, ...)` ties the
     * installation to whichever member happened to install it, which breaks
     * the moment that user leaves the org.
     */
    async findByOrgAndOwner(organizationId: string, owner: string) {
      return db.query.gitInstallation.findFirst({
        where: and(
          eq(gitInstallation.organizationId, organizationId),
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.owner, owner.toLowerCase()),
        ),
      });
    },

    /** Find all installations for a user */
    async listByUser(userId: string) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
        ),
      });
    },

    /**
     * Atomic upsert keyed on (provider, owner, userId). Concurrent
     * webhook redeliveries converge on a single row via the unique
     * index. Updates installationId + ownership metadata on conflict
     * so a re-install (new installationId for the same GitHub account)
     * refreshes the row in place.
     */
    async upsert(data: Omit<NewGitInstallation, "id">) {
      const id = randomUUID();
      const row = { id, ...data, owner: data.owner.toLowerCase() };
      const now = new Date();
      const [returned] = await db
        .insert(gitInstallation)
        .values(row)
        .onConflictDoUpdate({
          target: [
            gitInstallation.provider,
            gitInstallation.owner,
            gitInstallation.userId,
          ],
          set: {
            installationId: data.installationId,
            organizationId: data.organizationId,
            ownerType: data.ownerType,
            providerUserId: data.providerUserId ?? null,
            providerOwnerId: data.providerOwnerId ?? null,
            isOrg: data.isOrg ?? false,
            updatedAt: now,
          },
        })
        .returning();
      return returned ?? { ...row, createdAt: now, updatedAt: now };
    },

    /** Replace all GitHub App installations for a user with a fresh snapshot */
    async replaceForUser(userId: string, data: Array<Omit<NewGitInstallation, "id" | "userId" | "provider">>) {
      const rows = data.map((installation) => ({
        id: randomUUID(),
        userId,
        provider: "github",
        ...installation,
        owner: installation.owner.toLowerCase(),
      }));

      const replace = async (tx: Database) => {
        await tx
          .delete(gitInstallation)
          .where(
            and(
              eq(gitInstallation.userId, userId),
              eq(gitInstallation.provider, "github"),
            ),
          );

        if (rows.length > 0) {
          await tx.insert(gitInstallation).values(rows);
        }
      };

      await db.transaction(replace);
    },

    /** Remove installation by user + owner */
    async removeByOwner(userId: string, owner: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.owner, owner.toLowerCase()),
          ),
        );
    },

    /** Remove installation by installation_id */
    async removeByInstallationId(userId: string, installationId: number) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Remove installation rows by installation_id, regardless of linked OAuth account */
    async removeByInstallationIdForProvider(installationId: number) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Remove all GitHub installations for a user */
    async removeAllForUser(userId: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
          ),
        );
    },
  };
}
