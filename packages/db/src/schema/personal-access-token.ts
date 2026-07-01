import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Personal Access Token — a revocable, per-user Bearer credential for
 * programmatic API access (MCP clients, CLI, scripts). Presented as
 * `Authorization: Bearer opsh_pat_<secret>`; the auth middleware resolves it to
 * the owning user + org and builds the same RequestContext a session would, so
 * the existing permission model applies unchanged.
 *
 * Only the SHA-256 hash of the token is stored — the plaintext is shown to the
 * user exactly once at creation. `tokenPrefix` (e.g. `opsh_pat_ab12`) is kept
 * for display only, so a user can recognise a token in the list.
 */
export const personalAccessToken = pgTable(
  "personal_access_token",
  {
    id: text("id").primaryKey(), // "pat_..."
    userId: text("user_id").notNull(),
    /** Org the token acts in. Null → resolved per request (X-Organization-Id / default). */
    organizationId: text("organization_id"),
    name: text("name").notNull(),
    /** Display-only leading chars of the token; NOT a lookup credential. */
    tokenPrefix: text("token_prefix").notNull(),
    /** SHA-256 hex of the full token — the lookup key. Unique. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Read-only tokens reject mutation methods (POST/PUT/PATCH/DELETE). */
    readOnly: boolean("read_only").notNull().default(false),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("personal_access_token_user_idx").on(t.userId),
    index("personal_access_token_prefix_idx").on(t.tokenPrefix),
  ],
);
