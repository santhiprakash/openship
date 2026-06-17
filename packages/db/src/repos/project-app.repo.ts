import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { projectApp } from "../schema";
import { member } from "../schema/organization";

export type ProjectApp = typeof projectApp.$inferSelect;
export type NewProjectApp = typeof projectApp.$inferInsert;

export function createProjectAppRepo(db: Database) {
  return {
    async findById(id: string) {
      return db.query.projectApp.findFirst({
        where: and(eq(projectApp.id, id), isNull(projectApp.deletedAt)),
      });
    },

    /** Slug uniqueness scoped to one org. */
    async findBySlugInOrg(organizationId: string, slug: string) {
      return db.query.projectApp.findFirst({
        where: and(
          eq(projectApp.organizationId, organizationId),
          eq(projectApp.slug, slug),
          isNull(projectApp.deletedAt),
        ),
      });
    },

    /**
     * Find a project_app by slug without scoping to a user. Use ONLY for
     * deterministic, globally-unique slugs (e.g. `webmail-<serverId>`),
     * never for user-facing slugs where cross-user collisions are
     * expected. Caller is responsible for verifying org membership after
     * the lookup (via assertResourceInOrg).
     */
    async findFirstBySlug(slug: string) {
      return db.query.projectApp.findFirst({
        where: and(eq(projectApp.slug, slug), isNull(projectApp.deletedAt)),
      });
    },

    // listByUser removed — use listByOrganization. project_app.user_id
    // is gone; access is org-only.

    /** Org-scoped list. */
    async listByOrganization(
      organizationId: string,
      opts?: { page?: number; perPage?: number },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db.query.projectApp.findMany({
        where: and(
          eq(projectApp.organizationId, organizationId),
          isNull(projectApp.deletedAt),
        ),
        orderBy: [desc(projectApp.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(projectApp)
        .where(
          and(eq(projectApp.organizationId, organizationId), isNull(projectApp.deletedAt)),
        );

      return { rows, total: Number(total), page, perPage };
    },

    async create(data: Omit<NewProjectApp, "id">) {
      const id = generateId("app");
      const row = { id, ...data };
      await db.insert(projectApp).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as ProjectApp;
    },

    async update(id: string, data: Partial<NewProjectApp>) {
      await db
        .update(projectApp)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(projectApp.id, id));
    },

    async softDelete(id: string) {
      await db
        .update(projectApp)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectApp.id, id));
    },
  };
}
