import { and, eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { cloudWebhookBinding } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CloudWebhookBinding = typeof cloudWebhookBinding.$inferSelect;
export type NewCloudWebhookBinding = typeof cloudWebhookBinding.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createCloudWebhookBindingRepo(db: Database) {
  return {
    /**
     * Bindings for a git repo (lowercased owner/repo). Returns an array — a
     * repo can have several environment branches bound. Caller picks the row
     * whose `gitBranch` is "" (default) or matches the pushed branch.
     */
    async findByRepo(owner: string, repo: string, branch?: string) {
      const conditions = [
        eq(cloudWebhookBinding.gitOwner, owner.toLowerCase()),
        eq(cloudWebhookBinding.gitRepo, repo.toLowerCase()),
      ];
      if (branch !== undefined) {
        conditions.push(eq(cloudWebhookBinding.gitBranch, branch));
      }
      return db.query.cloudWebhookBinding.findMany({
        where: and(...conditions),
      });
    },

    /** Create or update a binding, keyed on (gitOwner, gitRepo, gitBranch). */
    async upsert(
      data: Omit<NewCloudWebhookBinding, "id" | "createdAt" | "updatedAt"> & {
        id?: string;
      },
    ): Promise<CloudWebhookBinding> {
      const [row] = await db
        .insert(cloudWebhookBinding)
        .values({
          id: data.id ?? generateId("cwb"),
          ...data,
          gitOwner: data.gitOwner.toLowerCase(),
          gitRepo: data.gitRepo.toLowerCase(),
        })
        .onConflictDoUpdate({
          target: [
            cloudWebhookBinding.gitOwner,
            cloudWebhookBinding.gitRepo,
            cloudWebhookBinding.gitBranch,
          ],
          set: {
            organizationId: data.organizationId,
            cloudProjectId: data.cloudProjectId,
            webhookId: data.webhookId,
            webhookSecret: data.webhookSecret,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    async deleteByCloudProject(cloudProjectId: string): Promise<void> {
      await db
        .delete(cloudWebhookBinding)
        .where(eq(cloudWebhookBinding.cloudProjectId, cloudProjectId));
    },
  };
}
