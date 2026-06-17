import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { deployment, buildSession } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Deployment = typeof deployment.$inferSelect;
export type NewDeployment = typeof deployment.$inferInsert;
export type BuildSession = typeof buildSession.$inferSelect;
export type NewBuildSession = typeof buildSession.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDeploymentRepo(db: Database) {
  return {
    // ── Deployments ────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.deployment.findFirst({
        where: eq(deployment.id, id),
      });
    },

    async listByProject(
      projectId: string,
      opts?: { page?: number; perPage?: number; environment?: string },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const conditions = [eq(deployment.projectId, projectId)];
      if (opts?.environment) {
        conditions.push(eq(deployment.environment, opts.environment));
      }

      const rows = await db.query.deployment.findMany({
        where: and(...conditions),
        orderBy: [desc(deployment.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(and(...conditions));

      return { rows, total: Number(total), page, perPage };
    },

    // listByUser removed — use listByOrganization. deployment.user_id
    // is gone; access is org-only.

    /** Org-scoped list — every deployment for the active org. */
    async listByOrganization(
      organizationId: string,
      opts?: { page?: number; perPage?: number },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 50;
      const offset = (page - 1) * perPage;

      const rows = await db.query.deployment.findMany({
        where: eq(deployment.organizationId, organizationId),
        orderBy: [desc(deployment.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(eq(deployment.organizationId, organizationId));

      return { rows, total: Number(total), page, perPage };
    },

    async create(data: Omit<NewDeployment, "id">) {
      const id = generateId("dep");
      const row = { id, ...data };
      await db.insert(deployment).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Deployment;
    },

    async updateStatus(id: string, status: string, extra?: Partial<NewDeployment>) {
      await db
        .update(deployment)
        .set({ status, ...extra, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    async setContainerId(id: string, containerId: string, url?: string) {
      await db
        .update(deployment)
        .set({ containerId, url, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Find the most recent deployment for a project (any status) */
    async findLatestByProject(projectId: string) {
      return db.query.deployment.findFirst({
        where: eq(deployment.projectId, projectId),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    /**
     * Batch variant of findLatestByProject — one SQL round trip for
     * N projects. Used by getHome to eliminate the N+1.
     *
     * Strategy: fetch all rows for the project set, then pick the
     * newest per project in JS. Simpler than DISTINCT ON across
     * drivers (pg, pglite) and correct because the project filter
     * keeps the set small.
     */
    async findLatestByProjects(projectIds: string[]): Promise<Map<string, Deployment>> {
      if (projectIds.length === 0) return new Map();
      const rows = await db.query.deployment.findMany({
        where: inArray(deployment.projectId, projectIds),
        orderBy: [desc(deployment.createdAt)],
      });
      const out = new Map<string, Deployment>();
      for (const row of rows) {
        if (!out.has(row.projectId)) out.set(row.projectId, row);
      }
      return out;
    },

    /** Bulk lookup by id — used by enrichProject batching. */
    async findManyById(ids: string[]): Promise<Map<string, Deployment>> {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select()
        .from(deployment)
        .where(inArray(deployment.id, ids));
      const out = new Map<string, Deployment>();
      for (const row of rows) out.set(row.id, row);
      return out;
    },

    /** Find the most recent successful deployment for rollback */
    async findLatestReady(projectId: string, environment: string) {
      return db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.environment, environment),
          eq(deployment.status, "ready"),
        ),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    // ── Rollback / retention ───────────────────────────────────────────
    //
    // Owned by the RollbackOrchestrator. These methods are policy-free
    // — they only do the DB work. Decisions (when to archive, when to
    // purge, pin limits) live in the orchestrator.

    /** Set the timestamp marking "this deployment's artifact is archived
     *  and rollback-restorable". Pass null to mark it purged. */
    async setArtifactRetainedAt(id: string, at: Date | null) {
      await db
        .update(deployment)
        .set({ artifactRetainedAt: at, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Toggle the user-tagged pin. The endpoint enforces the per-project
     *  pin cap before calling this; this method is unguarded. */
    async setPinned(id: string, pinned: boolean) {
      await db
        .update(deployment)
        .set({ pinned, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Count pinned ready deployments for a project. Used by the pin
     *  endpoint to enforce maxPinnedDeployments. */
    async countPinned(projectId: string): Promise<number> {
      const [{ value }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(
          and(
            eq(deployment.projectId, projectId),
            eq(deployment.pinned, true),
          ),
        );
      return Number(value);
    },

    /** List ready deployments for a project, newest first. Used by the
     *  orchestrator's prune step to decide what falls outside the
     *  rollbackWindow. */
    async listReadyOrderedDesc(projectId: string, environment?: string) {
      const conditions = [
        eq(deployment.projectId, projectId),
        eq(deployment.status, "ready"),
      ];
      if (environment) {
        conditions.push(eq(deployment.environment, environment));
      }
      return db.query.deployment.findMany({
        where: and(...conditions),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    // ── Build sessions ─────────────────────────────────────────────────

    async createBuildSession(data: Omit<NewBuildSession, "id">) {
      const id = generateId("bld");
      const row = { id, ...data };
      await db.insert(buildSession).values(row);
      return { ...row, createdAt: new Date() } as BuildSession;
    },

    async findBuildSession(id: string) {
      return db.query.buildSession.findFirst({
        where: eq(buildSession.id, id),
      });
    },

    async findBuildSessionByDeploymentId(deploymentId: string) {
      return db.query.buildSession.findFirst({
        where: eq(buildSession.deploymentId, deploymentId),
        orderBy: [desc(buildSession.createdAt)],
      });
    },

    async updateBuildSession(id: string, data: Partial<NewBuildSession>) {
      await db
        .update(buildSession)
        .set(data)
        .where(eq(buildSession.id, id));
    },

    async finishBuildSession(id: string, status: string, durationMs: number, logs?: unknown[]) {
      await db
        .update(buildSession)
        .set({
          status,
          durationMs,
          logs: logs as never,
          finishedAt: new Date(),
        })
        .where(eq(buildSession.id, id));
    },

    async deleteDeployment(id: string) {
      await db.delete(buildSession).where(eq(buildSession.deploymentId, id));
      await db.delete(deployment).where(eq(deployment.id, id));
    },

    async deleteByProjectId(projectId: string) {
      await db.delete(buildSession).where(eq(buildSession.projectId, projectId));
      await db.delete(deployment).where(eq(deployment.projectId, projectId));
    },
  };
}
