import { eq, lt } from "drizzle-orm";
import type { Database } from "../client";
import { githubWebhookEvent } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GithubWebhookEvent = typeof githubWebhookEvent.$inferSelect;
export type NewGithubWebhookEvent = typeof githubWebhookEvent.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGithubWebhookEventRepo(db: Database) {
  return {
    /**
     * Atomically claim a delivery id. Returns true if THIS caller inserted the
     * row (first time we've seen this delivery), false if it already existed (a
     * redelivery). onConflictDoNothing + returning() makes concurrent deliveries
     * of the same id resolve to exactly one winner.
     */
    async claim(deliveryId: string, eventType: string): Promise<boolean> {
      const rows = await db
        .insert(githubWebhookEvent)
        .values({ deliveryId, eventType })
        .onConflictDoNothing()
        .returning();
      return rows.length > 0;
    },

    /** Stamp a delivery as fully handled (best-effort observability). */
    async markProcessed(deliveryId: string): Promise<void> {
      await db
        .update(githubWebhookEvent)
        .set({ processedAt: new Date() })
        .where(eq(githubWebhookEvent.deliveryId, deliveryId));
    },

    /**
     * Delete claim rows older than `cutoff`. Idempotency only needs a recent
     * window (GitHub redelivers within hours), so old rows are safe to drop —
     * keeps the table bounded. Returns rows deleted.
     */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(githubWebhookEvent)
        .where(lt(githubWebhookEvent.receivedAt, cutoff))
        .returning();
      return rows.length;
    },
  };
}
