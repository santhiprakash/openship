import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { service } from "./service";

// ─── Domains ─────────────────────────────────────────────────────────────────

/**
 * Custom domains linked to projects.
 * Each domain goes through a verification flow (DNS TXT record check)
 * before becoming active and getting SSL provisioned.
 */
export const domain = pgTable("domain", {
  id: text("id").primaryKey(), // "dom_..."
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** Service ID for service-scoped domain routing (null = project-level / main service) */
  serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),

  /** The custom domain (e.g. "app.example.com") */
  hostname: text("hostname").notNull().unique(),
  /** Internal target port this hostname should route to */
  targetPort: integer("target_port"),
  /** Static output subpath this hostname should serve */
  targetPath: text("target_path"),
  /** Route kind: managed/free subdomain or custom domain */
  domainType: text("domain_type"),
  /** Is this the primary domain for the project? */
  isPrimary: boolean("is_primary").notNull().default(false),

  /* ── Verification ───────────────────────────────────────────────────── */
  /** Domain status: pending | active | failed | removing */
  status: text("status").notNull().default("pending"),
  /** DNS TXT verification value (e.g. "openship-verify=abc123") */
  verificationToken: text("verification_token"),
  /** Whether DNS verification has passed */
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at"),

  /* ── SSL ─────────────────────────────────────────────────────────────── */
  /** SSL status: none | provisioning | active | expired | error */
  sslStatus: text("ssl_status").notNull().default("none"),
  /** Issuer (e.g. "letsencrypt", "oblien") */
  sslIssuer: text("ssl_issuer"),
  /** When the current certificate expires */
  sslExpiresAt: timestamp("ssl_expires_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Routing hot path — every request that resolves a hostname hits this.
  index("idx_domain_project").on(t.projectId),
  index("idx_domain_project_hostname").on(t.projectId, t.hostname),
]);
