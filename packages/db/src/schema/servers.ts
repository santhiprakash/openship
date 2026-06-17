import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization";

// ─── Servers ─────────────────────────────────────────────────────────────────

/**
 * SSH server configurations.
 *
 * One row per configured host. There's no kind / role flag - any server
 * can host apps, the mail stack, or both. Whether mail is installed on a
 * given host is derived at runtime from the mail-state.json the install
 * pipeline writes, not from a schema column.
 */
export const servers = pgTable("servers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),

  organizationId: text("organization_id")
    .references(() => organization.id, { onDelete: "cascade" }),

  /** Human-readable label - defaults to sshHost when not set */
  name: text("name"),

  // ── SSH credentials ────────────────────────────────────────────────────────

  sshHost: text("ssh_host").notNull(),
  sshPort: integer("ssh_port").default(22),
  sshUser: text("ssh_user").default("root"),
  sshAuthMethod: text("ssh_auth_method"), // "password" | "key"
  sshPassword: text("ssh_password"),
  sshKeyPath: text("ssh_key_path"),
  sshKeyPassphrase: text("ssh_key_passphrase"),
  sshJumpHost: text("ssh_jump_host"),
  sshArgs: text("ssh_args"),

  // ── Timestamps ─────────────────────────────────────────────────────────────

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
