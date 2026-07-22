import { eq, and } from "drizzle-orm";
import type { Database } from "../client";
import { githubDeployKey } from "../schema";

export type GithubDeployKey = typeof githubDeployKey.$inferSelect;
export type NewGithubDeployKey = typeof githubDeployKey.$inferInsert;

/** Per-(server, owner, repo) GitHub deploy keys minted by Openship. */
export function createGithubDeployKeyRepo(db: Database) {
  return {
    async getByRepo(
      serverId: string,
      owner: string,
      repo: string,
    ): Promise<GithubDeployKey | undefined> {
      return db.query.githubDeployKey.findFirst({
        where: and(
          eq(githubDeployKey.serverId, serverId),
          eq(githubDeployKey.owner, owner),
          eq(githubDeployKey.repo, repo),
        ),
      });
    },

    async listByServer(serverId: string): Promise<GithubDeployKey[]> {
      return db.query.githubDeployKey.findMany({
        where: eq(githubDeployKey.serverId, serverId),
        orderBy: (k, { asc }) => [asc(k.createdAt)],
      });
    },

    async create(data: NewGithubDeployKey): Promise<GithubDeployKey> {
      const [row] = await db.insert(githubDeployKey).values(data).returning();
      return row;
    },

    async deleteByRepo(serverId: string, owner: string, repo: string): Promise<void> {
      await db
        .delete(githubDeployKey)
        .where(
          and(
            eq(githubDeployKey.serverId, serverId),
            eq(githubDeployKey.owner, owner),
            eq(githubDeployKey.repo, repo),
          ),
        );
    },

    async deleteByServer(serverId: string): Promise<void> {
      await db.delete(githubDeployKey).where(eq(githubDeployKey.serverId, serverId));
    },
  };
}
