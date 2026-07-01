/**
 * Database dump / restore primitives — power team-mode migration AND
 * per-project transfer between local and Openship Cloud.
 *
 * A subgraph is a coherent, FK-closed slice of the DB. Three flavors today:
 *
 *   instance     — every migration-managed table, every row. Used by
 *                  single-tenant migrations (Path A: VPS, Path B: cloud
 *                  ingest forward path).
 *   organization — rows tagged with a specific organizationId, plus
 *                  FK-resolved children. Used by SaaS cloud-ingest export
 *                  (multi-tenant) and the team-mode flows.
 *   project      — a single project + every row reachable via FK from it.
 *                  Used by project-transfer (per-project mobility between
 *                  local <-> cloud).
 *
 * Why not pg_dump? Because:
 *   1. PGlite has no `pg_dump` binary — it's WASM, not a daemon.
 *   2. Cross-version restores (PGlite → managed Postgres) can choke on
 *      pg_dump's `CREATE EXTENSION` / search_path / role preamble.
 *   3. Drizzle owns the schema; the destination has applied the same
 *      migrations already — we ship data, not DDL.
 *
 * NOT a backup tool. Use the existing backup module for that.
 */

import { sql, eq, inArray, getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, getDriver } from "./client";
import * as schema from "./schema";

export const DUMP_FORMAT_VERSION = 1;

// ─── Scope discriminated union ───────────────────────────────────────────────
//
// The shape exposes the same `tables` envelope regardless of `kind`, so the
// restore path is identical.

export type SubgraphScope =
  | { kind: "instance" }
  | { kind: "organization"; organizationId: string }
  | { kind: "project"; projectId: string };

export interface DumpOptions {
  /** Null encrypted-at-rest columns; required for cross-host moves. */
  stripEncrypted?: boolean;
}

export interface DatabaseDump {
  formatVersion: number;
  exportedAt: string;
  sourceDriver: "pg" | "pglite";
  /** Echoed back so restore can sanity-check intent vs. payload shape. */
  scope: SubgraphScope;
  tables: Record<string, Array<Record<string, unknown>>>;
  strippedEncryptedFields?: Array<{ table: string; column: string; rowsAffected: number }>;
}

/**
 * Thrown by restoreSubgraph when an INSERT hits a unique-constraint
 * violation (Postgres unique_violation, code 23505 — a duplicate PK OR
 * a duplicate unique column such as domain.hostname). Callers map this
 * to a friendly 409 — "this row already exists on the target" (the
 * operator already transferred this project, or a hostname collides).
 */
export class PkCollisionError extends Error {
  readonly code = "PK_COLLISION" as const;
  constructor(
    public readonly table: string,
    public readonly cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Duplicate key on ${table} during restore — this subgraph appears to already exist on the target. (${causeMessage})`,
    );
    this.name = "PkCollisionError";
  }
}

/**
 * Extract the underlying Postgres driver error (with its `.code`) from a
 * thrown error. Drizzle wraps the driver error in a `DrizzleQueryError`, so
 * the pg code (e.g. 23505 = unique_violation) lives on `.cause`, not the
 * top level. Walk the cause chain (bounded) and return the first link that
 * carries a string `code`.
 */
function resolvePgError(err: unknown): (Error & { code?: string }) | null {
  let e: unknown = err;
  for (let i = 0; i < 6 && e && typeof e === "object"; i++) {
    if (typeof (e as { code?: unknown }).code === "string") {
      return e as Error & { code?: string };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

// ─── Table catalogue ─────────────────────────────────────────────────────────
//
// One declarative table per row. `scopes` describes which subgraphs include
// it and how it's resolved. The same table can appear in multiple subgraphs
// via different relations.

type ScopeResolver =
  // Root row of the subgraph — selected by primary key.
  | { in: "project"; via: "root-project-id" }
  | { in: "organization"; via: "organizationId" }
  // Resolved by FK to an already-collected set of parent ids.
  | { in: "project"; via: "fk"; column: "projectId" }
  | { in: "project"; via: "fk"; column: "deploymentId" }
  | { in: "project"; via: "fk"; column: "serviceId" }
  | { in: "organization"; via: "fk"; column: "projectId" }
  | { in: "organization"; via: "fk"; column: "deploymentId" }
  // Resolved by reading a column on the ROOT project row, then
  // selecting THIS table where id = that value. Used to bring along
  // FK-target rows the project depends on (e.g. project_app via
  // project.appId). The walker fetches the root project on demand.
  | { in: "project"; via: "from-root-project"; sourceColumn: "appId" }
  // Whole-instance only.
  | { in: "instance"; via: "all-rows" };

interface TableSpec {
  sqlName: string;
  table: PgTable;
  /** Strategies this table participates in, in evaluation order. */
  scopes: ScopeResolver[];
  /** When true, rows have an organizationId column (needed by remapOrgId). */
  hasOrganizationId: boolean;
}

const TABLES: ReadonlyArray<TableSpec> = [
  // Auth + identity — instance-only (SaaS already has its own user/auth rows).
  { sqlName: "user", table: schema.user, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "organization", table: schema.organization, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "account", table: schema.account, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "session", table: schema.session, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "member", table: schema.member, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "invitation", table: schema.invitation, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "invitation_pending_grant", table: schema.invitationPendingGrant, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "resource_grant", table: schema.resourceGrant, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },

  // User / instance settings — instance-only.
  //
  // SECURITY NOTE: do NOT add an organization or project scope resolver
  // here. instance-scope dumps are rejected on the SaaS-side ingest
  // (cloud-ingest.service rejects scope.kind === "instance"), and that
  // rejection is what keeps user_settings.cloudSessionToken +
  // cloneTokenEncrypted from ever leaving the SaaS DB via the dump path.
  // Adding an org/project scope here would route user_settings rows
  // through the cloud export endpoint and around that gate.
  { sqlName: "user_settings", table: schema.userSettings, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "instance_settings", table: schema.instanceSettings, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },

  // Infra — instance-only.
  { sqlName: "servers", table: schema.servers, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "mail_servers", table: schema.mailServers, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },

  // GitHub — instance-only.
  { sqlName: "git_installation", table: schema.gitInstallation, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },

  // ── Project subgraph (also part of organization scope) ─────────────────────
  //
  // project_app is the parent of project (project.appId NOT NULL FK).
  // For project scope we MUST include it — restore would otherwise fail
  // its FK check at COMMIT time. Resolver walks project.appId off the
  // root project row and selects the matching project_app row.
  {
    sqlName: "project_app",
    table: schema.projectApp,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      { in: "project", via: "from-root-project", sourceColumn: "appId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "project",
    table: schema.project,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      { in: "project", via: "root-project-id" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "env_var",
    table: schema.envVar,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "deployment",
    table: schema.deployment,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "domain",
    table: schema.domain,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "service",
    table: schema.service,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
      { in: "project", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "service_deployment",
    table: schema.serviceDeployment,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "deploymentId" },
      { in: "project", via: "fk", column: "deploymentId" },
    ],
    hasOrganizationId: false,
  },

  // Backups
  {
    sqlName: "backup_destination",
    table: schema.backupDestination,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      // Not project-scoped: destinations are org-shared; transfer leaves
      // them behind on the source.
    ],
    hasOrganizationId: true,
  },
  // backup_policy / backup_run / backup_restore are intentionally NOT
  // in project scope. They reference backup_destination via NOT-NULL FK
  // (destinationId), and backup_destination is org-shared (not project-
  // scoped) — including these rows in a project transfer would leave
  // dangling FK references on the target. Backup history "stays behind
  // on the source"; the operator re-binds a destination on the new host.
  // Organization scope DOES carry them (backup_destination travels along).
  {
    sqlName: "backup_policy",
    table: schema.backupPolicy,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "fk", column: "projectId" },
    ],
    hasOrganizationId: false,
  },
  {
    sqlName: "backup_run",
    table: schema.backupRun,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "backup_restore",
    table: schema.backupRestore,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
      // See note on backup_policy / backup_run — not project-scoped.
    ],
    hasOrganizationId: true,
  },

  // Notifications
  {
    sqlName: "notification_channel",
    table: schema.notificationChannel,
    scopes: [{ in: "instance", via: "all-rows" }],
    hasOrganizationId: false,
  },
  {
    sqlName: "notification_subscription",
    table: schema.notificationSubscription,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "notification_default",
    table: schema.notificationDefault,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },
  {
    sqlName: "notification_delivery",
    table: schema.notificationDelivery,
    scopes: [
      { in: "instance", via: "all-rows" },
      { in: "organization", via: "organizationId" },
    ],
    hasOrganizationId: true,
  },

  // Analytics + audit — instance-only.
  { sqlName: "server_analytics", table: schema.serverAnalytics, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "server_analytics_geo", table: schema.serverAnalyticsGeo, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
  { sqlName: "audit_event", table: schema.auditEvent, scopes: [{ in: "instance", via: "all-rows" }], hasOrganizationId: false },
];

// Restore order = TABLES order (parents before children). Truncate uses reverse.

// ─── Encrypted columns (single source of truth) ──────────────────────────────
//
// Encryption-stripping is centralised here — every dump applies this list when
// stripEncrypted is true.

const ENCRYPTED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "user_settings", column: "cloudSessionToken" },
  { table: "user_settings", column: "cloneTokenEncrypted" },
  { table: "project", column: "cloneTokenEncrypted" },
  { table: "env_var", column: "value" },
  { table: "backup_destination", column: "accessKeyIdEnc" },
  { table: "backup_destination", column: "secretAccessKeyEnc" },
  { table: "backup_destination", column: "sftpPasswordEnc" },
  { table: "backup_destination", column: "sftpPrivateKeyEnc" },
  { table: "backup_destination", column: "sftpKeyPassphraseEnc" },
  { table: "deployment", column: "envVars" },
  { table: "notification_channel", column: "config" },
];

// ─── dumpSubgraph ────────────────────────────────────────────────────────────

export async function dumpSubgraph(
  scope: SubgraphScope,
  opts: DumpOptions = {},
): Promise<DatabaseDump> {
  const tables: DatabaseDump["tables"] = {};

  // FK-resolution state — built as we walk parents, consumed by children.
  const idSets: Record<string, Set<string>> = {
    projectId: new Set<string>(),
    deploymentId: new Set<string>(),
    serviceId: new Set<string>(),
  };

  const collectIds = (rows: Array<Record<string, unknown>>, key: string) => {
    for (const r of rows) {
      const v = r["id"];
      if (typeof v === "string") idSets[key]!.add(v);
    }
  };

  for (const spec of TABLES) {
    const resolver = pickResolver(spec, scope);
    if (!resolver) {
      // Table not in this subgraph.
      continue;
    }

    let rows: Array<Record<string, unknown>>;
    if (resolver.via === "all-rows") {
      rows = (await db.select().from(spec.table)) as Array<Record<string, unknown>>;
    } else if (resolver.via === "root-project-id" && scope.kind === "project") {
      const idCol = (spec.table as unknown as { id: never }).id;
      rows = (await db
        .select()
        .from(spec.table)
        .where(eq(idCol, scope.projectId as never))) as Array<Record<string, unknown>>;
    } else if (resolver.via === "organizationId" && scope.kind === "organization") {
      const orgCol = (spec.table as unknown as { organizationId: never }).organizationId;
      rows = (await db
        .select()
        .from(spec.table)
        .where(eq(orgCol, scope.organizationId as never))) as Array<Record<string, unknown>>;
    } else if (resolver.via === "fk") {
      const parentIds = Array.from(idSets[resolver.column] ?? []);
      if (parentIds.length === 0) {
        rows = [];
      } else {
        const col = (spec.table as unknown as Record<string, never>)[resolver.column];
        rows = (await db
          .select()
          .from(spec.table)
          .where(inArray(col, parentIds))) as Array<Record<string, unknown>>;
      }
    } else if (resolver.via === "from-root-project" && scope.kind === "project") {
      // Look up the source column on the root project row, then select
      // THIS table by id = that value. Lets us bring along the project's
      // FK-target parents (e.g. project_app) without a separate pass.
      const idCol = (spec.table as unknown as { id: never }).id;
      const sourceCol = (schema.project as unknown as Record<string, never>)[
        resolver.sourceColumn
      ];
      const sourceVals = (await db
        .select({ v: sourceCol })
        .from(schema.project)
        .where(eq(schema.project.id, scope.projectId as never))) as Array<{
        v: string | null;
      }>;
      const ids = sourceVals
        .map((r) => r.v)
        .filter((v): v is string => typeof v === "string");
      if (ids.length === 0) {
        rows = [];
      } else {
        rows = (await db
          .select()
          .from(spec.table)
          .where(inArray(idCol, ids))) as Array<Record<string, unknown>>;
      }
    } else {
      rows = [];
    }

    tables[spec.sqlName] = rows;

    // Collect ids for FK-resolved children. Order of TABLES guarantees
    // parents come first.
    if (spec.sqlName === "project") collectIds(rows, "projectId");
    else if (spec.sqlName === "deployment") collectIds(rows, "deploymentId");
    else if (spec.sqlName === "service") collectIds(rows, "serviceId");
  }

  const strippedEncryptedFields = opts.stripEncrypted ? stripEncryptedInPlace(tables) : undefined;

  return {
    formatVersion: DUMP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDriver: getDriver(),
    scope,
    tables,
    ...(strippedEncryptedFields ? { strippedEncryptedFields } : {}),
  };
}

function pickResolver(spec: TableSpec, scope: SubgraphScope): ScopeResolver | null {
  for (const r of spec.scopes) {
    if (r.in === scope.kind) return r;
  }
  return null;
}

function stripEncryptedInPlace(
  tables: DatabaseDump["tables"],
): NonNullable<DatabaseDump["strippedEncryptedFields"]> {
  const out: NonNullable<DatabaseDump["strippedEncryptedFields"]> = [];
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const rows = tables[table];
    if (!rows || rows.length === 0) continue;
    let rowsAffected = 0;
    for (const row of rows) {
      if (row[column] !== null && row[column] !== undefined) {
        row[column] = null;
        rowsAffected++;
      }
    }
    if (rowsAffected > 0) out.push({ table, column, rowsAffected });
  }
  return out;
}

// ─── restoreSubgraph ─────────────────────────────────────────────────────────

export interface RestoreOptions {
  /**
   * wipe  — truncate every table in the dump's scope, then insert. Atomic
   *         (one transaction, FK checks deferred). Used by team-mode
   *         forward (Path A/B) and reverse migrations. Currently only
   *         supported for instance-scope dumps; org/project scope must
   *         use merge mode.
   * merge — insert only; pre-existing PKs surface as a thrown DB error
   *         and the whole transaction rolls back. Used by project-transfer
   *         (target should be empty of the project's rows; conflict means
   *         the caller has already transferred, or the slug collides).
   */
  mode: "wipe" | "merge";
  /**
   * When set, every row in a table with hasOrganizationId=true has its
   * organizationId rewritten to this value before INSERT. Used by cloud
   * ingest (remap to SaaS org) and project transfer (remap to target org).
   */
  remapOrgId?: string;
}

export async function restoreSubgraph(
  dump: DatabaseDump,
  opts: RestoreOptions,
): Promise<void> {
  if (dump.formatVersion !== DUMP_FORMAT_VERSION) {
    throw new Error(
      `Dump format version ${dump.formatVersion} cannot be restored by this build (expected ${DUMP_FORMAT_VERSION}).`,
    );
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

    if (opts.mode === "wipe") {
      // Truncate only the tables this scope claims, in reverse order.
      // For project / organization scope we don't TRUNCATE because that
      // would wipe other tenants — `wipe` mode is conceptually a "this
      // scope only" wipe and the caller is responsible for ensuring the
      // dump covers every row in that scope. Today we only support wipe
      // for instance scope; org/project use merge.
      if (dump.scope.kind !== "instance") {
        throw new Error(
          `wipe mode is only supported for instance-scope dumps; got ${dump.scope.kind}.`,
        );
      }
      for (let i = TABLES.length - 1; i >= 0; i--) {
        const spec = TABLES[i]!;
        if (!pickResolver(spec, dump.scope)) continue;
        await tx.execute(
          sql`TRUNCATE TABLE ${sql.identifier(spec.sqlName)} RESTART IDENTITY CASCADE`,
        );
      }
    }

    // Pre-compute the encrypted-column set keyed by table so the insert
    // loop below can null those fields without re-scanning ENCRYPTED_COLUMNS
    // per row. Stripping on restore is REQUIRED (not optional like the
    // dump-side `stripEncrypted` flag): ciphertext from the wire was
    // encrypted under a foreign instance's BETTER_AUTH_SECRET, so we
    // could never decrypt it anyway, AND accepting it verbatim lets a
    // malicious caller plant arbitrary bytes in slots that downstream
    // code treats as "trusted encrypted blob" (env_var.value, notification
    // config, clone tokens, backup destination secrets, etc.). Always
    // null these — receivers re-link credentials post-restore.
    const encryptedByTable = new Map<string, string[]>();
    for (const { table, column } of ENCRYPTED_COLUMNS) {
      const list = encryptedByTable.get(table) ?? [];
      list.push(column);
      encryptedByTable.set(table, list);
    }

    for (const spec of TABLES) {
      if (!pickResolver(spec, dump.scope)) continue;
      const rows = dump.tables[spec.sqlName];
      if (!rows || rows.length === 0) continue;

      // Clone every row before mutation so we don't mangle the caller's
      // input dump object (callers may inspect it post-restore).
      //
      // SHALLOW CLONE — `{ ...r }` only copies top-level keys. That's
      // sufficient TODAY because every entry in ENCRYPTED_COLUMNS
      // targets a top-level column (env_var.value, deployment.envVars,
      // etc.) which we overwrite with `null`. If a future ENCRYPTED_COLUMNS
      // entry needs to redact a NESTED path (e.g. metadata.secret), this
      // clone needs to deepen — otherwise the redaction would mutate the
      // caller's input object.
      const encryptedCols = encryptedByTable.get(spec.sqlName);

      // Timestamp/date columns arrive as ISO strings whenever the dump crossed
      // the wire as JSON (cloud ingest, project transfer) — JSON.stringify turns
      // a Date into a string, and Drizzle's timestamp mapToDriverValue then calls
      // `.toISOString()` on it and throws. Revive them to Date before insert.
      // (In-process restores keep real Dates and skip the `typeof === string`
      // branch, so this is a no-op there.)
      const dateCols = Object.entries(getTableColumns(spec.table))
        .filter(([, col]) => (col as { dataType?: string }).dataType === "date")
        .map(([name]) => name);

      const prepared = rows.map((r) => {
        const next: Record<string, unknown> = { ...r };
        if (opts.remapOrgId && spec.hasOrganizationId) {
          next.organizationId = opts.remapOrgId;
        }
        if (encryptedCols) {
          for (const col of encryptedCols) next[col] = null;
        }
        for (const col of dateCols) {
          if (typeof next[col] === "string") next[col] = new Date(next[col] as string);
        }
        return next;
      });

      // Shared parents (e.g. project_app, which owns many project environments
      // via the `from-root-project` resolver) may already exist on the target
      // — a re-promote re-supplies the same row, and inserting it again is a
      // no-op, not a conflict. Skip on conflict for those; every other table
      // keeps strict insert so a real collision still surfaces as PkCollision.
      const isSharedParent = spec.scopes.some((s) => s.via === "from-root-project");

      try {
        if (isSharedParent) {
          await tx.insert(spec.table).values(prepared as never).onConflictDoNothing();
        } else {
          await tx.insert(spec.table).values(prepared as never);
        }
      } catch (err) {
        // PostgreSQL unique_violation = 23505 (PGlite mirrors this).
        // Surface as a typed error so callers (project transfer wizard,
        // cloud ingest) can distinguish "this row already exists on the
        // target" from a real server fault. The code lives on the driver
        // error, which Drizzle wraps — resolve it through the cause chain.
        const pg = resolvePgError(err);
        if (pg?.code === "23505") {
          throw new PkCollisionError(spec.sqlName, pg);
        }
        throw err;
      }
    }
  });
}

/**
 * Delete a project's rows in child→parent FK order, inside one transaction.
 *
 * Scope note: this deletes every project-owned table INCLUDING `backup_policy`,
 * which a project-scope *dump* deliberately does NOT carry (backup tables FK to
 * the org-shared `backup_destination`). So on a bring-home wipe→restore cycle
 * the project's backup schedules are dropped and NOT re-created — the operator
 * re-binds a destination + re-creates schedules on the new host. This matches
 * the original inline bring-home wipe (behaviour preserved by the extraction).
 *
 * Deliberately does NOT touch `project_app`: that parent is shared across a
 * project's environments (many `project` rows → one app), so a project delete
 * must leave it, and `restoreSubgraph` re-inserts it idempotently.
 *
 * Single source of truth for "wipe one project's rows", used by the local
 * bring-home transfer AND the SaaS-side cloud teardown.
 */
export async function deleteProjectSubgraph(projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Resolve deployment ids first so service_deployment (FK → deployment) goes first.
    const deploymentRows = await tx
      .select({ id: schema.deployment.id })
      .from(schema.deployment)
      .where(eq(schema.deployment.projectId, projectId));
    const deploymentIds = deploymentRows.map((r) => r.id);
    if (deploymentIds.length > 0) {
      await tx
        .delete(schema.serviceDeployment)
        .where(inArray(schema.serviceDeployment.deploymentId, deploymentIds));
    }

    // Children before parents.
    await tx.delete(schema.service).where(eq(schema.service.projectId, projectId));
    await tx.delete(schema.domain).where(eq(schema.domain.projectId, projectId));
    await tx.delete(schema.envVar).where(eq(schema.envVar.projectId, projectId));
    await tx.delete(schema.backupPolicy).where(eq(schema.backupPolicy.projectId, projectId));
    await tx.delete(schema.deployment).where(eq(schema.deployment.projectId, projectId));
    await tx.delete(schema.project).where(eq(schema.project.id, projectId));
  });
}

// ─── Legacy shims ────────────────────────────────────────────────────────────
//
// Kept functional so external scripts and any in-flight callers keep
// working. New code should use dumpSubgraph / restoreSubgraph.

/** @deprecated Use dumpSubgraph({ kind: "instance" }, opts). */
export async function dumpDatabase(opts: DumpOptions = {}): Promise<DatabaseDump> {
  return dumpSubgraph({ kind: "instance" }, opts);
}

/** @deprecated Use restoreSubgraph(dump, { mode: wipeFirst ? "wipe" : "merge" }). */
export async function restoreDatabase(
  dump: DatabaseDump,
  opts: { wipeFirst?: boolean } = {},
): Promise<void> {
  return restoreSubgraph(dump, { mode: opts.wipeFirst ? "wipe" : "merge" });
}
