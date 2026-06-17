import { pgTable, text, timestamp, boolean, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

// ─── GitHub App installation tracking ────────────────────────────────────────

/**
 * Tracks GitHub App installations per user.
 * Each row represents one installation (user or org account).
 */
export const gitInstallation = pgTable(
  "git_installation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Org that owns this installation. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    installationId: integer("installation_id").notNull(),
    owner: text("owner").notNull(),
    ownerType: text("owner_type").notNull().default("User"),
    providerUserId: text("provider_user_id"),
    providerOwnerId: text("provider_owner_id"),
    isOrg: boolean("is_org").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One installation row per (provider, owner) per user. Backs the
    // atomic onConflictDoUpdate in the upsert path so concurrent webhook
    // redeliveries can't duplicate rows.
    uniqueIndex("uq_git_installation_provider_owner_user").on(
      t.provider,
      t.owner,
      t.userId,
    ),
    // Member-onboarding + org-scoped App resolution: every authed
    // request that mints an installation token via the org path hits
    // this. Without it, the table is full-scanned per lookup.
    index("idx_git_installation_org").on(
      t.organizationId,
      t.provider,
      t.owner,
    ),
  ],
);
