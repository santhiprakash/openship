import { eq, and, asc, inArray } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { service, serviceDeployment } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Service = typeof service.$inferSelect;
export type NewService = typeof service.$inferInsert;
export type ServiceDeployment = typeof serviceDeployment.$inferSelect;
export type NewServiceDeployment = typeof serviceDeployment.$inferInsert;

// ─── Routing normalization ───────────────────────────────────────────────────

/**
 * Single normalization rule for the service-row routing columns
 * (`exposed`, `exposedPort`, `domain`, `customDomain`, `domainType`).
 *
 * Exported so the API layer (service.service.ts) can apply the SAME
 * normalization on patch input before persisting. Two divergent
 * implementations were drifting (one trimmed differently than the
 * other) - collapsing to a single source of truth here.
 */
export function normalizeRoutingFields(input: {
  exposed?: boolean | null;
  exposedPort?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
}): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: string;
} {
  const exposed = input.exposed ?? false;

  if (!exposed) {
    return { exposed: false, exposedPort: null, domain: null, customDomain: null, domainType: "free" };
  }

  const domainType = input.domainType === "custom" ? "custom" : "free";
  const trimOrNull = (v?: string | null) => {
    const t = v?.trim();
    return t || null;
  };

  return {
    exposed: true,
    exposedPort: trimOrNull(input.exposedPort),
    domain: domainType === "free" ? trimOrNull(input.domain) : null,
    customDomain: domainType === "custom" ? trimOrNull(input.customDomain) : null,
    domainType,
  };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServiceRepo(db: Database) {
  return {
    // ── Services ───────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.service.findFirst({
        where: eq(service.id, id),
      });
    },

    async findByName(projectId: string, name: string) {
      return db.query.service.findFirst({
        where: and(eq(service.projectId, projectId), eq(service.name, name)),
      });
    },

    async listByProject(projectId: string) {
      return db.query.service.findMany({
        where: eq(service.projectId, projectId),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
    },

    /**
     * Batch variant of listByProject — one SQL round trip for N
     * projects. Used by getHome to eliminate the N+1.
     */
    async listByProjects(projectIds: string[]): Promise<Map<string, Service[]>> {
      if (projectIds.length === 0) return new Map();
      const rows = await db.query.service.findMany({
        where: inArray(service.projectId, projectIds),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
      const out = new Map<string, Service[]>();
      for (const id of projectIds) out.set(id, []);
      for (const row of rows) {
        const list = out.get(row.projectId);
        if (list) list.push(row);
      }
      return out;
    },

    async create(data: Omit<NewService, "id">) {
      const id = generateId("svc");
      const row = { id, ...data };
      await db.insert(service).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Service;
    },

    async update(id: string, data: Partial<NewService>) {
      await db
        .update(service)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(service.id, id));
    },

    async remove(id: string) {
      await db.delete(service).where(eq(service.id, id));
    },

    /**
     * Hard-delete every service row under a project. The FK on
     * `serviceDeployment.serviceId` cascades, so this also removes the
     * per-deployment service rows. Used by the project cleanup pipeline
     * after a soft-delete - without this, service rows would survive as
     * orphans (project soft-delete is logical only and never triggers the
     * FK cascade that would remove them automatically).
     */
    async deleteByProjectId(projectId: string) {
      await db.delete(service).where(eq(service.projectId, projectId));
    },

    /** List only the rows of one kind under a project. */
    async listByProjectKind(projectId: string, kind: "compose" | "monorepo") {
      return db.query.service.findMany({
        where: and(eq(service.projectId, projectId), eq(service.kind, kind)),
        orderBy: [asc(service.sortOrder), asc(service.name)],
      });
    },

    /**
     * Sync monorepo sub-apps for a project. Mirrors `syncFromCompose` but for
     * `kind="monorepo"` rows - creates new, updates existing, removes stale
     * (matched by `name`, which is the sub-app's stable identifier). Leaves
     * compose rows in the same project untouched.
     */
    async syncMonorepoApps(
      projectId: string,
      apps: {
        name: string;
        rootDirectory: string;
        framework?: string | null;
        packageManager?: string | null;
        buildImage?: string | null;
        installCommand?: string | null;
        buildCommand?: string | null;
        startCommand?: string | null;
        outputDirectory?: string | null;
        port?: number | string | null;
        enabled?: boolean;
        exposed?: boolean;
        exposedPort?: string | null;
        domain?: string | null;
        customDomain?: string | null;
        domainType?: string | null;
        environment?: Record<string, string>;
      }[],
    ) {
      const existing = await this.listByProjectKind(projectId, "monorepo");
      const existingByName = new Map(existing.map((s) => [s.name, s]));
      const incomingNames = new Set(apps.map((a) => a.name));

      const results: Service[] = [];
      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        const ex = existingByName.get(app.name);

        const routing = normalizeRoutingFields({
          exposed: app.exposed ?? ex?.exposed ?? true,
          exposedPort: app.exposedPort ?? ex?.exposedPort ?? (app.port != null ? String(app.port) : null),
          domain: app.domain ?? ex?.domain,
          customDomain: app.customDomain ?? ex?.customDomain,
          domainType: app.domainType ?? ex?.domainType,
        });

        const fields = {
          kind: "monorepo" as const,
          name: app.name,
          rootDirectory: app.rootDirectory,
          framework: app.framework ?? null,
          packageManager: app.packageManager ?? null,
          buildImage: app.buildImage ?? null,
          installCommand: app.installCommand ?? null,
          buildCommand: app.buildCommand ?? null,
          startCommand: app.startCommand ?? null,
          outputDirectory: app.outputDirectory ?? null,
          environment: app.environment ?? {},
          ...routing,
          enabled: app.enabled ?? true,
          sortOrder: i,
        };

        if (ex) {
          await this.update(ex.id, fields);
          results.push({ ...ex, ...fields, updatedAt: new Date() } as Service);
        } else {
          const created = await this.create({
            projectId,
            ...fields,
            // Compose-only fields stay null on monorepo rows.
            image: null,
            build: null,
            dockerfile: null,
            ports: [],
            dependsOn: [],
            volumes: [],
            command: null,
            restart: "unless-stopped",
          });
          results.push(created);
        }
      }

      // Remove monorepo rows that aren't in the incoming list (compose rows
      // are filtered out by listByProjectKind, so they survive).
      for (const ex of existing) {
        if (!incomingNames.has(ex.name)) {
          await this.remove(ex.id);
        }
      }

      return results;
    },

    /**
     * Sync services from a parsed compose file.
     *
     * SCOPED TO kind="compose" ONLY. Monorepo sub-app rows have their own
     * sync path (the monorepoApps ensure() flow) and must NOT be touched
     * here - removing rows not in the incoming compose list would otherwise
     * delete every monorepo sub-app on a compose-mode build of a mixed
     * project, and per-row fields would be stomped if a monorepo row shared
     * a name with a compose service.
     *
     * Also preserves the user's explicit `enabled` choice on updates -
     * compose's YAML doesn't carry an enabled flag, so re-syncing a row
     * the user disabled in the dashboard must keep it disabled.
     */
    async syncFromCompose(
      projectId: string,
      parsed: {
        name: string;
        /** Discriminator - strictly "compose" entries are honored. Monorepo
         *  rows passed in here are dropped: no DB unique constraint on
         *  (projectId, name) means a monorepo row pretending to be compose
         *  would create a duplicate ghost row alongside the real one. */
        kind?: string | null;
        image?: string;
        build?: string;
        dockerfile?: string;
        ports?: string[];
        dependsOn?: string[];
        environment?: Record<string, string>;
        volumes?: string[];
        command?: string;
        restart?: string;
        exposed?: boolean;
        exposedPort?: string;
        domain?: string;
        customDomain?: string;
        domainType?: string;
      }[],
    ) {
      // Defensive filter - even though every caller should already strip
      // non-compose entries before reaching here, an explicit kind="monorepo"
      // would otherwise insert a ghost compose row with the same name as the
      // real monorepo sub-app. Belt-and-suspenders.
      const composeParsed = parsed.filter((p) => !p.kind || p.kind === "compose");

      const all = await this.listByProject(projectId);
      const composeExisting = all.filter((s) => s.kind === "compose" || s.kind === null);
      const existingByName = new Map(composeExisting.map((s) => [s.name, s]));
      const incomingNames = new Set(composeParsed.map((s) => s.name));

      // Create or update
      const results: Service[] = [];
      for (let i = 0; i < composeParsed.length; i++) {
        const p = composeParsed[i];
        const ex = existingByName.get(p.name);

        const routing = normalizeRoutingFields({
          exposed: p.exposed ?? (ex?.exposed || false),
          exposedPort: p.exposedPort ?? ex?.exposedPort,
          domain: p.domain ?? ex?.domain,
          customDomain: p.customDomain ?? ex?.customDomain,
          domainType: p.domainType ?? ex?.domainType,
        });

        if (ex) {
          // Update existing - preserve the operator's `enabled` choice. The
          // compose YAML doesn't carry an enabled flag; forcing true on
          // every sync would un-disable services the user explicitly
          // disabled in the dashboard.
          await this.update(ex.id, {
            image: p.image ?? null,
            build: p.build ?? null,
            dockerfile: p.dockerfile ?? null,
            ports: p.ports ?? [],
            dependsOn: p.dependsOn ?? [],
            environment: p.environment ?? {},
            volumes: p.volumes ?? [],
            command: p.command ?? null,
            restart: p.restart ?? "unless-stopped",
            ...routing,
            // enabled left as-is (already on ex)
            sortOrder: i,
          });
          results.push({
            ...ex,
            ...p,
            ...routing,
            sortOrder: i,
            updatedAt: new Date(),
          } as Service);
        } else {
          // Create new - new compose services default to enabled.
          const svc = await this.create({
            projectId,
            name: p.name,
            kind: "compose",
            image: p.image ?? null,
            build: p.build ?? null,
            dockerfile: p.dockerfile ?? null,
            ports: p.ports ?? [],
            dependsOn: p.dependsOn ?? [],
            environment: p.environment ?? {},
            volumes: p.volumes ?? [],
            command: p.command ?? null,
            restart: p.restart ?? "unless-stopped",
            ...routing,
            enabled: true,
            sortOrder: i,
          });
          results.push(svc);
        }
      }

      // Remove stale compose services (not in the incoming compose YAML).
      // Monorepo sub-apps live in a different kind and were filtered out
      // above; they survive untouched.
      for (const ex of composeExisting) {
        if (!incomingNames.has(ex.name)) {
          await this.remove(ex.id);
        }
      }

      return results;
    },

    // ── Service Deployments ────────────────────────────────────────────

    async findServiceDeployment(id: string) {
      return db.query.serviceDeployment.findFirst({
        where: eq(serviceDeployment.id, id),
      });
    },

    async listByDeployment(deploymentId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.deploymentId, deploymentId),
      });
    },

    async listByService(serviceId: string) {
      return db.query.serviceDeployment.findMany({
        where: eq(serviceDeployment.serviceId, serviceId),
      });
    },

    async createServiceDeployment(data: Omit<NewServiceDeployment, "id">) {
      const id = generateId("sd");
      const row = { id, ...data };
      await db.insert(serviceDeployment).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as ServiceDeployment;
    },

    async updateServiceDeployment(id: string, data: Partial<NewServiceDeployment>) {
      await db
        .update(serviceDeployment)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(serviceDeployment.id, id));
    },
  };
}
