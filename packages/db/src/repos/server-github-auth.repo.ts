import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { serverGithubAuth } from "../schema";

export type ServerGithubAuth = typeof serverGithubAuth.$inferSelect;
export type NewServerGithubAuth = typeof serverGithubAuth.$inferInsert;

/** Per-server GitHub auth config (one row per server). Secrets are stored
 *  encrypted by the caller; this repo never encrypts/decrypts. */
export function createServerGithubAuthRepo(db: Database) {
  return {
    async getByServer(serverId: string): Promise<ServerGithubAuth | undefined> {
      return db.query.serverGithubAuth.findFirst({
        where: eq(serverGithubAuth.serverId, serverId),
      });
    },

    /** Insert-or-replace the auth config for a server (unique on serverId). */
    async upsert(data: NewServerGithubAuth): Promise<ServerGithubAuth> {
      const [row] = await db
        .insert(serverGithubAuth)
        .values(data)
        .onConflictDoUpdate({
          target: serverGithubAuth.serverId,
          set: {
            mode: data.mode,
            tokenEncrypted: data.tokenEncrypted ?? null,
            tokenSource: data.tokenSource ?? null,
            tokenLogin: data.tokenLogin ?? null,
            serverKeyPrivateEncrypted: data.serverKeyPrivateEncrypted ?? null,
            serverKeyPublic: data.serverKeyPublic ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },

    /** Remove a server's GitHub auth config (disconnect). */
    async deleteByServer(serverId: string): Promise<void> {
      await db.delete(serverGithubAuth).where(eq(serverGithubAuth.serverId, serverId));
    },
  };
}
