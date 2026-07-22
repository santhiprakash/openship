/**
 * Curated Apps catalog.
 *
 * An "App" is a one-click install surfaced in the dashboard's Apps tab. Two kinds:
 *
 *   - "template": a fixed set of upstream images wired together (a backend + its
 *     database, a CMS + its DB, …). These deploy through the compose/services
 *     path — the instantiator creates a repo-less `services` project (marked
 *     `isApp`), seeds the service rows below, and deploys. The runtime handles
 *     service discovery (each service is reachable by name on the project
 *     network) and volume namespacing.
 *   - "flow": an app whose provisioning already has a bespoke wizard (mail /
 *     iRedMail). The catalog entry just points at that flow (`flowHref`); it does
 *     NOT instantiate services here.
 *
 * `configFields` are the operator-facing inputs the Create-App form renders;
 * each maps to a service env key. Fields with `generate:"secret"` are filled
 * with a strong random value by the instantiator (operators never type them);
 * fields sharing a `generateGroup` get the SAME generated value (e.g. a DB
 * password that must match across two services). Secret fields are written
 * through the per-service encrypted-env path, never stored as plaintext here.
 */

import type { ComposeHealthcheck } from "./types";
import type { AppManagement, AppSettingGroup } from "./app-settings";

export type AppCategory = "backend" | "database" | "cms" | "mail" | "analytics" | "automation" | "other";

export interface TemplateServiceSpec {
  /** Service name — also its hostname/alias on the project network. */
  name: string;
  /** Upstream image (image-only services skip build/clone). */
  image: string;
  /** Port mappings, compose syntax (e.g. "8080:80"). */
  ports?: readonly string[];
  /** Container port to publish publicly (routing target / primary route). */
  exposedPort?: number;
  /**
   * Extra public routes beyond `exposedPort` — a multi-port service (e.g. Convex's
   * API on 3210 + HTTP actions on 3211) publishes one route per port, each under
   * its own subdomain. `slugSuffix` disambiguates the secondary hostname
   * (`<app>-<service>-<suffix>`). Omit for single-route services.
   */
  routes?: readonly {
    port: number;
    slugSuffix?: string;
  }[];
  /** Non-secret environment defaults. */
  environment?: Readonly<Record<string, string>>;
  /** Env keys the operator/instantiator must fill in (secrets) — not stored as defaults. */
  secretEnv?: readonly string[];
  /** Named volumes / bind mounts (compose syntax). Named volumes are project-scoped. */
  volumes?: readonly string[];
  /** Services that must be running first (deploy ordering). */
  dependsOn?: readonly string[];
  /** Publish this service on a public route. */
  exposed?: boolean;
  /** Container healthcheck (maps to `service.advanced.healthcheck`). */
  healthcheck?: ComposeHealthcheck;
  /** Restart policy (compose syntax). */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  /** Override the container command. */
  command?: string;
}

export interface AppConfigField {
  /** Env key this value maps to. */
  key: string;
  /** Service whose env this writes to. */
  service: string;
  label: string;
  help?: string;
  type?: "text" | "password";
  /** Prefilled default. */
  default?: string;
  /** Auto-generate a strong random value (operator never types it). */
  generate?: "secret";
  /** Fields sharing a group get the SAME generated value (cross-service match). */
  generateGroup?: string;
  required?: boolean;
  /** Write as an encrypted secret (isSecret:true). */
  secret?: boolean;
}

export interface AppTemplate {
  id: string;
  name: string;
  description: string;
  /** "template" = instantiate the services below; "flow" = defer to `flowHref`. */
  kind: "template" | "flow";
  /** Catalog logo id (resolved to an icon in the dashboard). */
  logo: string;
  category: AppCategory;
  tags?: readonly string[];
  /** Stack id the instantiated project carries (template kind). */
  framework?: string;
  /** Services to seed (template kind). */
  services?: readonly TemplateServiceSpec[];
  /** Operator-facing config inputs the Create-App form renders (template kind). */
  configFields?: readonly AppConfigField[];
  /** Dashboard route to hand off to (flow kind, e.g. "/emails"). */
  flowHref?: string;
  /** Curated day-2 settings surfaced after install (see app-settings.ts). */
  settings?: readonly AppSettingGroup[];
  /**
   * How the installed app is managed. Omit → derived: "schema" when `settings`
   * exist, else none (raw project tabs only). Set explicitly for apps with a
   * bespoke surface (mail → /emails).
   */
  management?: AppManagement;
}

/**
 * Convex — self-hosted reactive backend. Backend serves the API on 3210 and HTTP
 * actions on 3211; the dashboard (6791) talks to the backend. Data persists on a
 * named volume (SQLite) — the simplest production-capable start; Postgres is a
 * later config option. `INSTANCE_SECRET` is generated; the public origins
 * (`CONVEX_CLOUD_ORIGIN`/`CONVEX_SITE_ORIGIN`/`NEXT_PUBLIC_DEPLOYMENT_URL`) are
 * filled from the assigned domain by the instantiator's Convex post-deploy step.
 */
const CONVEX_TEMPLATE: AppTemplate = {
  id: "convex",
  name: "Convex",
  description: "Self-hosted Convex reactive backend + dashboard, with a persistent data volume.",
  kind: "template",
  logo: "convex",
  category: "backend",
  tags: ["backend", "database", "realtime"],
  framework: "docker-compose",
  services: [
    {
      name: "backend",
      image: "ghcr.io/get-convex/convex-backend:latest",
      ports: ["3210:3210", "3211:3211"],
      exposedPort: 3210,
      exposed: true,
      // Two public routes: the API (3210) and HTTP actions (3211) each get their
      // own subdomain (`<app>-backend` and `<app>-backend-http`).
      routes: [{ port: 3210 }, { port: 3211, slugSuffix: "http" }],
      environment: {
        INSTANCE_NAME: "convex-self-hosted",
        DISABLE_BEACON: "true",
        // Resolved at deploy time to each port's assigned public URL. The API
        // origin points at the 3210 route; HTTP actions at the 3211 route.
        CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
        CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
      },
      secretEnv: ["INSTANCE_SECRET"],
      volumes: ["convex_data:/convex/data"],
      healthcheck: {
        test: ["CMD-SHELL", "curl -f http://localhost:3210/version || exit 1"],
        interval: "10s",
        timeout: "5s",
        retries: 5,
        startPeriod: "20s",
      },
      restart: "unless-stopped",
    },
    {
      name: "dashboard",
      image: "ghcr.io/get-convex/convex-dashboard:latest",
      ports: ["6791:6791"],
      exposedPort: 6791,
      exposed: true,
      dependsOn: ["backend"],
      environment: {
        // The dashboard talks to the backend over its public URL (resolved at deploy).
        NEXT_PUBLIC_DEPLOYMENT_URL: "{{publicUrl:backend}}",
      },
      restart: "unless-stopped",
    },
  ],
  configFields: [
    {
      key: "INSTANCE_SECRET",
      service: "backend",
      label: "Instance secret",
      help: "Auto-generated. Signs the admin key and internal tokens.",
      generate: "secret",
      secret: true,
    },
  ],
  management: { kind: "schema" },
  settings: [
    {
      id: "general",
      label: "General",
      fields: [
        {
          key: "DISABLE_BEACON",
          service: "backend",
          label: "Disable telemetry beacon",
          type: "boolean",
          default: "true",
        },
      ],
    },
    {
      id: "advanced",
      label: "Advanced",
      description: "Changing these regenerates or invalidates the deployment's admin key — the dashboard and CLI must be re-authenticated afterwards.",
      fields: [
        {
          key: "INSTANCE_NAME",
          service: "backend",
          label: "Instance name",
          help: "Sets the deployment name. Changing it AFTER the first deploy invalidates the admin key and locks the dashboard/CLI out — safest to set it here, at install.",
          type: "text",
          default: "convex-self-hosted",
          advanced: true,
          requiresRedeploy: true,
          installStep: true,
        },
        {
          key: "INSTANCE_SECRET",
          service: "backend",
          label: "Instance secret",
          help: "Signs the admin key and internal tokens. Rotating it invalidates existing admin keys.",
          type: "password",
          secret: true,
          advanced: true,
          requiresRedeploy: true,
        },
      ],
    },
  ],
};

/**
 * n8n — workflow automation. Single service; state persists on a volume (SQLite
 * by default). `N8N_ENCRYPTION_KEY` is generated and encrypts stored credentials.
 */
const N8N_TEMPLATE: AppTemplate = {
  id: "n8n",
  name: "n8n",
  description: "Workflow automation — connect apps and APIs with a visual editor.",
  kind: "template",
  logo: "n8n",
  category: "automation",
  tags: ["automation", "workflows", "integrations"],
  framework: "docker-compose",
  services: [
    {
      name: "n8n",
      image: "n8nio/n8n:latest",
      ports: ["5678:5678"],
      exposedPort: 5678,
      exposed: true,
      environment: {
        N8N_PORT: "5678",
        N8N_PROTOCOL: "https",
        GENERIC_TIMEZONE: "UTC",
        // Public URL for webhook/callback links — resolved at deploy time.
        WEBHOOK_URL: "{{publicUrl:n8n}}",
      },
      secretEnv: ["N8N_ENCRYPTION_KEY"],
      volumes: ["n8n_data:/home/node/.n8n"],
      restart: "unless-stopped",
    },
  ],
  configFields: [
    {
      key: "N8N_ENCRYPTION_KEY",
      service: "n8n",
      label: "Encryption key",
      help: "Auto-generated. Encrypts stored credentials.",
      generate: "secret",
      secret: true,
    },
  ],
  management: { kind: "schema" },
  settings: [
    {
      id: "general",
      label: "General",
      fields: [
        {
          key: "GENERIC_TIMEZONE",
          service: "n8n",
          label: "Timezone",
          help: "Used by Schedule and Cron nodes.",
          type: "text",
          default: "UTC",
          placeholder: "UTC",
          installStep: true,
        },
        {
          key: "N8N_DEFAULT_LOCALE",
          service: "n8n",
          label: "Locale",
          type: "text",
          default: "en",
          placeholder: "en",
        },
      ],
    },
    {
      id: "executions",
      label: "Executions",
      description: "Bound stored execution history so the data volume doesn't grow without limit.",
      fields: [
        {
          key: "EXECUTIONS_DATA_PRUNE",
          service: "n8n",
          label: "Prune old executions",
          type: "boolean",
          default: "true",
        },
        {
          key: "EXECUTIONS_DATA_MAX_AGE",
          service: "n8n",
          label: "Keep executions for (hours)",
          help: "336 hours = 14 days.",
          type: "number",
          default: "336",
          integer: true,
          min: 1,
          advanced: true,
        },
      ],
    },
  ],
};

/**
 * Ghost — modern publishing platform. Ghost 5 requires MySQL in production, so
 * this is a two-service template; the DB password is generated once and shared
 * (matching `generateGroup`) between the DB and Ghost's connection config.
 */
const GHOST_TEMPLATE: AppTemplate = {
  id: "ghost",
  name: "Ghost",
  description: "Modern publishing platform for blogs, newsletters, and membership sites.",
  kind: "template",
  logo: "ghost",
  category: "cms",
  tags: ["cms", "blog", "newsletter"],
  framework: "docker-compose",
  services: [
    {
      name: "ghost-db",
      image: "mysql:8.0",
      environment: { MYSQL_DATABASE: "ghost" },
      secretEnv: ["MYSQL_ROOT_PASSWORD"],
      volumes: ["ghost_db:/var/lib/mysql"],
      restart: "unless-stopped",
    },
    {
      name: "ghost",
      image: "ghost:5-alpine",
      ports: ["2368:2368"],
      exposedPort: 2368,
      exposed: true,
      dependsOn: ["ghost-db"],
      environment: {
        NODE_ENV: "production",
        // Ghost builds absolute links (feeds, emails, admin) from `url` — resolved
        // to its assigned public URL at deploy time.
        url: "{{publicUrl:ghost}}",
        database__client: "mysql",
        database__connection__host: "ghost-db",
        database__connection__user: "root",
        database__connection__database: "ghost",
      },
      secretEnv: ["database__connection__password"],
      volumes: ["ghost_content:/var/lib/ghost/content"],
      restart: "unless-stopped",
    },
  ],
  configFields: [
    {
      key: "MYSQL_ROOT_PASSWORD",
      service: "ghost-db",
      label: "Database password",
      generate: "secret",
      generateGroup: "ghostdb",
      secret: true,
    },
    {
      key: "database__connection__password",
      service: "ghost",
      label: "Ghost DB password",
      generate: "secret",
      generateGroup: "ghostdb",
      secret: true,
    },
  ],
};

/**
 * Uptime Kuma — self-hosted uptime monitoring. Single service, SQLite on a volume.
 */
const UPTIME_KUMA_TEMPLATE: AppTemplate = {
  id: "uptime-kuma",
  name: "Uptime Kuma",
  description: "Self-hosted uptime monitoring with status pages and alerts.",
  kind: "template",
  logo: "uptime-kuma",
  category: "other",
  tags: ["monitoring", "uptime", "status"],
  framework: "docker-compose",
  services: [
    {
      name: "uptime-kuma",
      image: "louislam/uptime-kuma:1",
      ports: ["3001:3001"],
      exposedPort: 3001,
      exposed: true,
      volumes: ["uptime_kuma_data:/app/data"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * Vaultwarden — lightweight self-hosted Bitwarden-compatible password manager.
 * Single service; data on a volume. `DOMAIN` must be its public URL (WebAuthn /
 * links) — resolved at deploy time.
 */
const VAULTWARDEN_TEMPLATE: AppTemplate = {
  id: "vaultwarden",
  name: "Vaultwarden",
  description: "Lightweight self-hosted password manager (Bitwarden-compatible).",
  kind: "template",
  logo: "vaultwarden",
  category: "other",
  tags: ["passwords", "security", "bitwarden"],
  framework: "docker-compose",
  services: [
    {
      name: "vaultwarden",
      image: "vaultwarden/server:latest",
      ports: ["80:80"],
      exposedPort: 80,
      exposed: true,
      environment: {
        DOMAIN: "{{publicUrl:vaultwarden}}",
      },
      volumes: ["vaultwarden_data:/data"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * Metabase — open-source BI / analytics. Single service; uses an embedded H2 DB
 * on a volume for a quick start (point at Postgres later for production).
 */
const METABASE_TEMPLATE: AppTemplate = {
  id: "metabase",
  name: "Metabase",
  description: "Open-source business intelligence — dashboards and questions over your data.",
  kind: "template",
  logo: "metabase",
  category: "analytics",
  tags: ["analytics", "bi", "dashboards"],
  framework: "docker-compose",
  services: [
    {
      name: "metabase",
      image: "metabase/metabase:latest",
      ports: ["3000:3000"],
      exposedPort: 3000,
      exposed: true,
      environment: {
        MB_DB_FILE: "/metabase-data/metabase.db",
      },
      volumes: ["metabase_data:/metabase-data"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * Directus — headless CMS + instant REST/GraphQL API. Single service on the
 * SQLite default (DB file + uploads on volumes). `SECRET` (token signing) is
 * generated; `PUBLIC_URL` is resolved at deploy time. The admin is created in
 * the Studio onboarding on first visit.
 */
const DIRECTUS_TEMPLATE: AppTemplate = {
  id: "directus",
  name: "Directus",
  description: "Headless CMS with an instant REST + GraphQL API over your data. Create the admin on first visit.",
  kind: "template",
  logo: "directus",
  category: "cms",
  tags: ["cms", "headless", "api"],
  framework: "docker-compose",
  services: [
    {
      name: "directus",
      image: "directus/directus:latest",
      ports: ["8055:8055"],
      exposedPort: 8055,
      exposed: true,
      environment: {
        DB_CLIENT: "sqlite3",
        DB_FILENAME: "/directus/database/data.db",
        PUBLIC_URL: "{{publicUrl:directus}}",
      },
      secretEnv: ["SECRET"],
      volumes: ["directus_database:/directus/database", "directus_uploads:/directus/uploads"],
      restart: "unless-stopped",
    },
  ],
  configFields: [
    {
      key: "SECRET",
      service: "directus",
      label: "App secret",
      help: "Auto-generated. Signs access tokens.",
      generate: "secret",
      secret: true,
    },
  ],
};

/**
 * NocoDB — Airtable-style database UI. Single service; SQLite metadata +
 * attachments persist on a volume. The first sign-up becomes the super admin.
 */
const NOCODB_TEMPLATE: AppTemplate = {
  id: "nocodb",
  name: "NocoDB",
  description: "Airtable-style spreadsheet UI over an SQL database. The first sign-up becomes the admin.",
  kind: "template",
  logo: "nocodb",
  category: "database",
  tags: ["database", "airtable", "no-code"],
  framework: "docker-compose",
  services: [
    {
      name: "nocodb",
      image: "nocodb/nocodb:latest",
      ports: ["8080:8080"],
      exposedPort: 8080,
      exposed: true,
      volumes: ["nocodb_data:/usr/app/data"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * Grafana — metrics dashboards and visualization. Single service, embedded
 * SQLite on a volume. Default first login is admin / admin (forced change).
 */
const GRAFANA_TEMPLATE: AppTemplate = {
  id: "grafana",
  name: "Grafana",
  description: "Dashboards and visualization for your metrics and logs. First login is admin / admin.",
  kind: "template",
  logo: "grafana",
  category: "analytics",
  tags: ["analytics", "dashboards", "monitoring"],
  framework: "docker-compose",
  services: [
    {
      name: "grafana",
      image: "grafana/grafana:latest",
      ports: ["3000:3000"],
      exposedPort: 3000,
      exposed: true,
      volumes: ["grafana_data:/var/lib/grafana"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * Gitea — self-hosted Git with issues and pull requests. Single service on the
 * SQLite default; all state (repos, DB, config) persists under /data. `ROOT_URL`
 * is resolved at deploy time for correct clone/redirect links. A setup wizard
 * runs on first visit (first registered user becomes admin).
 */
const GITEA_TEMPLATE: AppTemplate = {
  id: "gitea",
  name: "Gitea",
  description: "Self-hosted Git with issues, pull requests, and a first-run setup wizard.",
  kind: "template",
  logo: "gitea",
  category: "other",
  tags: ["git", "vcs", "developer"],
  framework: "docker-compose",
  services: [
    {
      name: "gitea",
      image: "gitea/gitea:1",
      ports: ["3000:3000"],
      exposedPort: 3000,
      exposed: true,
      environment: { GITEA__server__ROOT_URL: "{{publicUrl:gitea}}" },
      volumes: ["gitea_data:/data"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * code-server — VS Code in the browser. Single service; config + projects on
 * volumes. `PASSWORD` (the single login) is generated so first sign-in works.
 */
const CODE_SERVER_TEMPLATE: AppTemplate = {
  id: "code-server",
  name: "code-server",
  description: "Run VS Code in your browser, on your server. Login uses an auto-generated password.",
  kind: "template",
  logo: "code-server",
  category: "other",
  tags: ["developer", "ide", "vscode"],
  framework: "docker-compose",
  services: [
    {
      name: "code-server",
      image: "codercom/code-server:latest",
      ports: ["8080:8080"],
      exposedPort: 8080,
      exposed: true,
      secretEnv: ["PASSWORD"],
      volumes: [
        "code_server_config:/home/coder/.config",
        "code_server_local:/home/coder/.local",
        "code_server_project:/home/coder/project",
      ],
      restart: "unless-stopped",
    },
  ],
  configFields: [
    {
      key: "PASSWORD",
      service: "code-server",
      label: "Login password",
      help: "Auto-generated. Required to sign in.",
      generate: "secret",
      secret: true,
    },
  ],
};

/**
 * FreshRSS — self-hosted RSS/Atom reader. Single service on the SQLite default;
 * config + DB persist on a volume. A setup wizard runs on first visit.
 */
const FRESHRSS_TEMPLATE: AppTemplate = {
  id: "freshrss",
  name: "FreshRSS",
  description: "Self-hosted RSS and Atom feed reader with a first-run setup wizard.",
  kind: "template",
  logo: "freshrss",
  category: "other",
  tags: ["rss", "feeds", "reader"],
  framework: "docker-compose",
  services: [
    {
      name: "freshrss",
      image: "freshrss/freshrss:latest",
      ports: ["80:80"],
      exposedPort: 80,
      exposed: true,
      volumes: ["freshrss_data:/var/www/FreshRSS/data"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * Stirling PDF — a full local PDF toolkit (split/merge/convert/OCR). Single
 * service; configs + OCR language data on volumes. Recent images ship with
 * login enabled (default admin / stirling — change it on first sign-in).
 */
const STIRLING_PDF_TEMPLATE: AppTemplate = {
  id: "stirling-pdf",
  name: "Stirling PDF",
  description: "Split, merge, convert, OCR and edit PDFs locally. Default login is admin / stirling — change it.",
  kind: "template",
  logo: "stirling-pdf",
  category: "other",
  tags: ["pdf", "documents", "tools"],
  framework: "docker-compose",
  services: [
    {
      name: "stirling-pdf",
      image: "stirlingtools/stirling-pdf:latest",
      ports: ["8080:8080"],
      exposedPort: 8080,
      exposed: true,
      volumes: ["stirling_config:/configs", "stirling_tessdata:/usr/share/tessdata"],
      restart: "unless-stopped",
    },
  ],
};

/**
 * IT-Tools — a box of developer/sysadmin utilities. Fully client-side static
 * app; no login, no DB, no persistent state.
 */
const IT_TOOLS_TEMPLATE: AppTemplate = {
  id: "it-tools",
  name: "IT-Tools",
  description: "A handy collection of developer and sysadmin utilities. No login, no setup.",
  kind: "template",
  logo: "it-tools",
  category: "other",
  tags: ["developer", "tools", "utilities"],
  framework: "docker-compose",
  services: [
    {
      name: "it-tools",
      image: "corentinth/it-tools:latest",
      ports: ["80:80"],
      exposedPort: 80,
      exposed: true,
      restart: "unless-stopped",
    },
  ],
};

/**
 * Excalidraw — virtual whiteboard for hand-drawn-style diagrams. The official
 * image is the client only (stateless; drawings live in the browser). Real-time
 * collaboration needs a separate room server, out of scope for this one-click.
 */
const EXCALIDRAW_TEMPLATE: AppTemplate = {
  id: "excalidraw",
  name: "Excalidraw",
  description: "Virtual whiteboard for sketches and diagrams. Stateless — drawings save in your browser.",
  kind: "template",
  logo: "excalidraw",
  category: "other",
  tags: ["whiteboard", "diagrams", "drawing"],
  framework: "docker-compose",
  services: [
    {
      name: "excalidraw",
      image: "excalidraw/excalidraw:latest",
      ports: ["80:80"],
      exposedPort: 80,
      exposed: true,
      restart: "unless-stopped",
    },
  ],
};

/**
 * Openship Mail — a "flow" app: it doesn't instantiate compose services, it
 * hands off to the mail PROVIDER WIZARD at /apps/new/mail, which offers:
 *   • Self-host        → the iRedMail provisioning flow at /emails.
 *   • Connect existing → deploy just the Zero webmail UI against an external
 *                        IMAP/SMTP backend (Amazon SES / Gmail / Fastmail / custom).
 * Present in the catalog so mail is a first-class one-click app alongside the rest.
 */
const MAIL_FLOW: AppTemplate = {
  id: "mail",
  name: "Openship Mail",
  description: "A complete self-hosted mail server — SMTP/IMAP + webmail on your own domain.",
  kind: "flow",
  logo: "mail-webmail",
  category: "mail",
  tags: ["mail", "email", "smtp", "imap"],
  // Catalog click → the provider wizard (chooses self-host vs connect-existing).
  flowHref: "/apps/new/mail",
  // Bespoke day-2 management surface — the mail provisioning + admin wizard.
  management: { kind: "custom", href: "/emails" },
};

/**
 * Buzz (github.com/block/buzz, Apache-2.0) — a self-hostable workspace on a Nostr
 * relay where humans and AI agents collaborate: chat, code patches, reviews, and
 * workflows recorded as signed events in one audit log. Catalog placeholder for
 * now: listed but left out of AVAILABLE_APP_IDS, so the UI shows it dimmed as
 * "Coming soon" until an install path is wired. `kind: "template"` keeps it a
 * neutral entry (no services yet) — whoever enables it fills in the deploy shape.
 */
const BUZZ_TEMPLATE: AppTemplate = {
  id: "buzz",
  name: "Buzz",
  description: "Self-hostable workspace where humans and AI agents collaborate — chat, code, reviews, and workflows in one audit log.",
  kind: "template",
  logo: "buzz",
  category: "other",
  tags: ["collaboration", "ai", "agents", "chat", "workflows", "nostr"],
};

export const APP_TEMPLATES: readonly AppTemplate[] = [
  MAIL_FLOW,
  CONVEX_TEMPLATE,
  N8N_TEMPLATE,
  GHOST_TEMPLATE,
  DIRECTUS_TEMPLATE,
  NOCODB_TEMPLATE,
  METABASE_TEMPLATE,
  GRAFANA_TEMPLATE,
  GITEA_TEMPLATE,
  CODE_SERVER_TEMPLATE,
  UPTIME_KUMA_TEMPLATE,
  VAULTWARDEN_TEMPLATE,
  FRESHRSS_TEMPLATE,
  STIRLING_PDF_TEMPLATE,
  IT_TOOLS_TEMPLATE,
  EXCALIDRAW_TEMPLATE,
  // ── Coming soon (not in AVAILABLE_APP_IDS) ──
  BUZZ_TEMPLATE,
];

export function getAppTemplate(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}

/**
 * Apps enabled (installable) in THIS version. Everything else in the catalog is
 * still shown — dimmed + "Coming soon", not installable — until it's ready.
 * Single switch: add an id here to light it up (and guard install server-side).
 */
export const AVAILABLE_APP_IDS: ReadonlySet<string> = new Set(["mail", "n8n", "convex"]);

/** Is this catalog app installable now, or a dimmed "coming soon" placeholder? */
export function isAppAvailable(id: string): boolean {
  return AVAILABLE_APP_IDS.has(id);
}

/** Curated day-2 settings groups for an app (empty when it has none). */
export function getAppSettings(template: AppTemplate): readonly AppSettingGroup[] {
  return template.settings ?? [];
}

/**
 * How an app is managed: an explicit `management`, else "schema" when it
 * declares settings, else null (no curated surface — raw project tabs only).
 */
export function getAppManagement(template: AppTemplate): AppManagement | null {
  if (template.management) return template.management;
  if (template.settings && template.settings.length > 0) return { kind: "schema" };
  return null;
}
