import { and, desc, eq, isNull } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { personalAccessToken } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PersonalAccessToken = typeof personalAccessToken.$inferSelect;
export type NewPersonalAccessToken = typeof personalAccessToken.$inferInsert;
/** A token row with the secret hash projected out — safe to hand to callers. */
export type PublicPersonalAccessToken = Omit<PersonalAccessToken, "tokenHash">;

export interface CreatePatInput {
  userId: string;
  organizationId: string | null;
  name: string;
  tokenPrefix: string;
  /** SHA-256 hex of the full token. Plaintext is never stored. */
  tokenHash: string;
  readOnly: boolean;
  expiresAt: Date | null;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createPersonalAccessTokenRepo(db: Database) {
  return {
    async create(input: CreatePatInput): Promise<PersonalAccessToken> {
      const [row] = await db
        .insert(personalAccessToken)
        .values({
          id: generateId("pat"),
          userId: input.userId,
          organizationId: input.organizationId,
          name: input.name,
          tokenPrefix: input.tokenPrefix,
          tokenHash: input.tokenHash,
          readOnly: input.readOnly,
          expiresAt: input.expiresAt,
        })
        .returning();
      return row!;
    },

    /**
     * Resolve an ACTIVE token by the SHA-256 hash of the presented secret.
     * Returns null when missing, revoked, or expired. Lookup is by the full
     * hash (unique-indexed) — the secret carries full entropy, so equality on
     * the hash leaks nothing exploitable.
     */
    async findActiveByHash(tokenHash: string): Promise<PersonalAccessToken | null> {
      const row = await db.query.personalAccessToken.findFirst({
        where: eq(personalAccessToken.tokenHash, tokenHash),
      });
      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.expiresAt && row.expiresAt < new Date()) return null;
      return row;
    },

    /**
     * List a user's tokens (newest first). The `tokenHash` column is projected
     * out at the query level, so the secret hash never leaves the repo — callers
     * physically cannot leak it.
     */
    async listByUser(userId: string): Promise<PublicPersonalAccessToken[]> {
      return db.query.personalAccessToken.findMany({
        columns: { tokenHash: false },
        where: eq(personalAccessToken.userId, userId),
        orderBy: [desc(personalAccessToken.createdAt)],
      });
    },

    /** Revoke one of the user's own tokens. Returns false if not found/already revoked. */
    async revoke(id: string, userId: string): Promise<boolean> {
      const rows = await db
        .update(personalAccessToken)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(personalAccessToken.id, id),
            eq(personalAccessToken.userId, userId),
            isNull(personalAccessToken.revokedAt),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    /** Best-effort last-used stamp (called on each authenticated request). */
    async touchLastUsed(id: string): Promise<void> {
      await db
        .update(personalAccessToken)
        .set({ lastUsedAt: new Date() })
        .where(eq(personalAccessToken.id, id));
    },
  };
}
