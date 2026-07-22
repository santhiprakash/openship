import { eq, and } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { routeRule } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RouteRule = typeof routeRule.$inferSelect;
export type NewRouteRule = typeof routeRule.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createRouteRuleRepo(db: Database) {
  return {
    async get(id: string) {
      return db.query.routeRule.findFirst({ where: eq(routeRule.id, id) });
    },

    /** Every rule for a project — the routing push serializes them all. */
    async listByProject(projectId: string): Promise<RouteRule[]> {
      return db.query.routeRule.findMany({
        where: eq(routeRule.projectId, projectId),
      });
    },

    async listByDomain(domainId: string): Promise<RouteRule[]> {
      return db.query.routeRule.findMany({
        where: eq(routeRule.domainId, domainId),
      });
    },

    async create(data: Omit<NewRouteRule, "id">): Promise<RouteRule> {
      const id = generateId("rr");
      const row = { id, ...data };
      await db.insert(routeRule).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as RouteRule;
    },

    async update(id: string, data: Partial<NewRouteRule>) {
      await db
        .update(routeRule)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(routeRule.id, id));
    },

    async remove(id: string) {
      await db.delete(routeRule).where(eq(routeRule.id, id));
    },

    /** Scoped delete — guards a mutation to a project's own rule. */
    async removeForProject(projectId: string, id: string) {
      await db
        .delete(routeRule)
        .where(and(eq(routeRule.projectId, projectId), eq(routeRule.id, id)));
    },

    async deleteByProjectId(projectId: string) {
      await db.delete(routeRule).where(eq(routeRule.projectId, projectId));
    },
  };
}
