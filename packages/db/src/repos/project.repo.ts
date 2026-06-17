import { eq, and, isNull, desc, sql, type SQL } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { project, envVar } from "../schema";
import { member } from "../schema/organization";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
export type EnvVar = typeof envVar.$inferSelect;
export type NewEnvVar = typeof envVar.$inferInsert;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build Drizzle conditions for env var queries scoped by project/environment/service */
function envVarScope(projectId: string, environment?: string, serviceId?: string | null): SQL[] {
  const conditions: SQL[] = [eq(envVar.projectId, projectId)];
  if (environment) {
    conditions.push(eq(envVar.environment, environment));
  }
  if (serviceId === null) {
    // Explicitly project-level only
    conditions.push(isNull(envVar.serviceId));
  } else if (serviceId) {
    conditions.push(eq(envVar.serviceId, serviceId));
  }
  return conditions;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createProjectRepo(db: Database) {
  return {
    // ── Projects ───────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.project.findFirst({
        where: and(eq(project.id, id), isNull(project.deletedAt)),
      });
    },

    /** Slug uniqueness scoped to one org. */
    async findBySlugInOrg(organizationId: string, slug: string) {
      return db.query.project.findFirst({
        where: and(
          eq(project.organizationId, organizationId),
          eq(project.slug, slug),
          isNull(project.deletedAt),
        ),
      });
    },

    /**
     * Find a project by slug without scoping to a user. Use ONLY for slugs
     * that are deterministic and globally unique (e.g. `webmail-<serverId>`),
     * never for user-facing slugs where collisions across users are expected.
     */
    async findFirstBySlug(slug: string) {
      return db.query.project.findFirst({
        where: and(eq(project.slug, slug), isNull(project.deletedAt)),
      });
    },

    /** Find all projects linked to a given git owner/repo (for webhook dispatch) */
    async findByGitRepo(owner: string, repo: string) {
      const ownerKey = owner.toLowerCase();
      const repoKey = repo.toLowerCase();
      return db.query.project.findMany({
        where: and(
          sql`lower(${project.gitOwner}) = ${ownerKey}`,
          sql`lower(${project.gitRepo}) = ${repoKey}`,
          isNull(project.deletedAt),
        ),
      });
    },

    async listByApp(appId: string) {
      return db.query.project.findMany({
        where: and(eq(project.appId, appId), isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
      });
    },

    /**
     * List every project visible to a user — across ALL orgs they're a
     * member of. Resolves via the `member` join (not a stamped user_id
     * column, which doesn't exist anymore). Useful for "show me
     * everything I have access to" views like cross-org dashboards.
     *
     * For scoped lookups on the user's CURRENT org, prefer
     * `listByOrganization(activeOrgId, ...)`.
     */
    async listForUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(and(eq(member.userId, userId), isNull(project.deletedAt)))
        .orderBy(desc(project.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(and(eq(member.userId, userId), isNull(project.deletedAt)));

      return {
        rows: rows.map((r) => r.project),
        total: Number(total),
        page,
        perPage,
      };
    },

    /**
     * Org-scoped list. Replaces listByUser in multi-user controllers —
     * returns every project visible to the active organization.
     * Membership check is enforced at the middleware layer; this just
     * scopes the rows.
     */
    async listByOrganization(
      organizationId: string,
      opts?: { page?: number; perPage?: number },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db.query.project.findMany({
        where: and(eq(project.organizationId, organizationId), isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .where(and(eq(project.organizationId, organizationId), isNull(project.deletedAt)));

      return { rows, total: Number(total), page, perPage };
    },

    /** Org-scoped findById — verifies the project belongs to the org. */
    async findByIdInOrganization(id: string, organizationId: string) {
      return db.query.project.findFirst({
        where: and(eq(project.id, id), eq(project.organizationId, organizationId)),
      });
    },

    /**
     * Same as listForUser but filtered to production environments only.
     * Used for the "primary" view that hides preview branch deploys.
     */
    async listPrimaryForUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const condition = and(
        eq(member.userId, userId),
        eq(project.environmentSlug, "production"),
        isNull(project.deletedAt),
      );

      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(condition)
        .orderBy(desc(project.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(condition);

      return {
        rows: rows.map((r) => r.project),
        total: Number(total),
        page,
        perPage,
      };
    },

    async create(data: Omit<NewProject, "id">) {
      const id = generateId("proj");
      const row = { id, ...data };
      await db.insert(project).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Project;
    },

    async update(id: string, data: Partial<NewProject>) {
      await db
        .update(project)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(project.id, id));
    },

    async updateByApp(appId: string, data: Partial<NewProject>) {
      await db
        .update(project)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(project.appId, appId), isNull(project.deletedAt)));
    },

    /** Update favicon cache metadata without touching the user-visible updatedAt field. */
    async updateFaviconCache(
      id: string,
      data: { favicon?: string | null; faviconCheckedAt?: Date | null },
    ) {
      const patch: Partial<NewProject> = {};

      if (Object.prototype.hasOwnProperty.call(data, "favicon")) {
        patch.favicon = data.favicon ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(data, "faviconCheckedAt")) {
        patch.faviconCheckedAt = data.faviconCheckedAt ?? null;
      }

      if (Object.keys(patch).length === 0) return;

      await db.update(project).set(patch).where(eq(project.id, id));
    },

    /** Soft-delete a project */
    async softDelete(id: string) {
      await db
        .update(project)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(project.id, id));
    },

    /** Set the active deployment for a project */
    async setActiveDeployment(projectId: string, deploymentId: string | null) {
      await db
        .update(project)
        .set({ activeDeploymentId: deploymentId, updatedAt: new Date() })
        .where(eq(project.id, projectId));
    },

    // ── Environment variables ──────────────────────────────────────────

    async listEnvVars(projectId: string, environment?: string, serviceId?: string | null) {
      return db.query.envVar.findMany({
        where: and(...envVarScope(projectId, environment, serviceId)),
      });
    },

    /** Lookup a single env var by id — needed by permission.resolveResourceOrg. */
    async findEnvVarById(id: string) {
      return db.query.envVar.findFirst({ where: eq(envVar.id, id) });
    },

    async setEnvVar(data: Omit<NewEnvVar, "id">) {
      const id = generateId("env");
      const row = { id, ...data };
      await db.insert(envVar).values(row);
      return row;
    },

    async updateEnvVar(id: string, value: string) {
      await db.update(envVar).set({ value, updatedAt: new Date() }).where(eq(envVar.id, id));
    },

    async deleteEnvVar(id: string) {
      await db.delete(envVar).where(eq(envVar.id, id));
    },

    /** Bulk upsert env vars for a project + environment (optionally scoped to a service) */
    async bulkSetEnvVars(
      projectId: string,
      environment: string,
      vars: { key: string; value: string; isSecret?: boolean }[],
      serviceId?: string | null,
    ) {
      // Delete existing for this project+environment+service scope, then re-insert
      await db.delete(envVar).where(and(...envVarScope(projectId, environment, serviceId ?? null)));

      if (vars.length === 0) return;

      const rows = vars.map((v) => ({
        id: generateId("env"),
        projectId,
        environment,
        serviceId: serviceId ?? null,
        key: v.key,
        value: v.value,
        isSecret: v.isSecret ?? false,
      }));

      await db.insert(envVar).values(rows);
    },

    /** Get a map of env vars for injection into builds/containers */
    async getEnvMap(
      projectId: string,
      environment: string,
      serviceId?: string | null,
    ): Promise<Record<string, string>> {
      const rows = await db.query.envVar.findMany({
        where: and(...envVarScope(projectId, environment, serviceId)),
      });
      const map: Record<string, string> = {};
      for (const row of rows) {
        map[row.key] = row.value;
      }
      return map;
    },
  };
}
