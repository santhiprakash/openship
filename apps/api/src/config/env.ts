import { z } from "zod";
import {
  getDashboardRuntimeTarget,
  getDashboardRuntimeOrigins,
  LOCAL_WEB_URL,
  resolveDashboardRuntimeTarget,
} from "@repo/core";

const DEFAULT_BETTER_AUTH_SECRET = "change-me-in-production";

/**
 * API configuration - loaded from environment variables.
 *
 * CLOUD_MODE=true enables billing, metering, and multi-tenant features.
 * Runtime URL/port values are hardcoded in @repo/core runtime targets.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /* ---------- Mode ---------- */
  CLOUD_MODE: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Override the cloud target's API URL. The local API normally talks
   * to `https://api.openship.io` for cloud features (App install, OAuth
   * exchange, etc.) — set this to point at a local SaaS dev instance
   * (`http://localhost:4100`) so a single machine can run both sides
   * of the connect flow.
   */
  CLOUD_API_URL: z.string().optional(),
  /** Override the cloud dashboard URL — defaults to `https://app.openship.io`. */
  CLOUD_DASHBOARD_URL: z.string().optional(),
  /**
   * Deployment mode - determines the runtime + infrastructure combination:
    *   - "docker"  (default) → Docker runtime + OpenResty routing/SSL (self-hosted)
    *   - "bare"              → Process runtime + OpenResty routing/SSL (self-hosted)
   *   - "cloud"             → Oblien cloud API for everything (auto-set when CLOUD_MODE=true)
   *   - "desktop"           → Bare runtime, no routing/SSL (desktop app)
   */
  DEPLOY_MODE: z.enum(["docker", "bare", "cloud", "desktop"]).default("docker"),

  /* ---------- Database ---------- */
  DATABASE_URL: z.string().default(""),

  /* ---------- Auth (Better Auth) ---------- */
  BETTER_AUTH_SECRET: z.string().min(1).default(DEFAULT_BETTER_AUTH_SECRET),
  BETTER_AUTH_COOKIE_DOMAIN: z.string().optional(),
  /**
   * Cloud-session IP/UA pinning policy. Applied by cloudSessionAuth
   * middleware when a local instance presents a cloud_session_token.
   *
   *   - "off"  (default) → log mismatches as warnings, allow the request.
   *                        Friendly to mobile carriers/VPN switches.
   *   - "warn"           → same as "off" but also emits an audit log
   *                        entry per mismatch (for SOC review).
   *   - "strict"         → 401 on IP OR User-Agent mismatch with the
   *                        IP/UA stored when the session was created.
   *                        Higher security, may break legit users that
   *                        change network/device.
   */
  CLOUD_SESSION_PINNING: z
    .enum(["off", "warn", "strict"])
    .default("warn"),

  /* ---------- OAuth Providers ---------- */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /* ---------- GitHub Auth Strategy ---------- */
  /**
   * Controls how the API authenticates with GitHub:
   *   - "auto"  (default) → inferred from DEPLOY_MODE / CLOUD_MODE
   *   - "app"             → GitHub App installation tokens (cloud)
   *   - "oauth"           → Better Auth OAuth flow only (self-hosted with OAuth)
   *   - "cli"             → `gh auth login` token from the machine (local/desktop)
   *   - "token"           → static GITHUB_TOKEN env var (CI, scripts)
   */
  GITHUB_AUTH_MODE: z.enum(["auto", "app", "oauth", "cli", "token"]).default("auto"),
  /** Static GitHub personal access token - used when GITHUB_AUTH_MODE="token" */
  GITHUB_TOKEN: z.string().optional(),

  /* ---------- Redis ---------- */
  REDIS_URL: z.string().default("redis://localhost:6379"),

  /* ---------- Stripe (Cloud only) ---------- */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- GitHub App ---------- */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().default("openship-io"),
  /** PEM private key - raw multi-line string */
  GITHUB_PRIVATE_KEY: z.string().optional(),
  /** PEM private key - base64-encoded (single-line, for env vars) */
  GITHUB_PRIVATE_KEY_BASE64: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Email (SMTP) ---------- */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Openship <noreply@openship.io>"),

  /* ---------- Network (self-hosted) ---------- */
  /** Public IP of the server - used for A record instructions in self-hosted mode. */
  SERVER_IP: z.string().optional(),
  /**
   * Base domain for the self-hosted instance (e.g. "example.com").
   * Deployments get a free subdomain: slug.HOST_DOMAIN (e.g. "myapp.example.com").
   * SSL is NOT auto-provisioned for these - only for custom domains.
   */
  HOST_DOMAIN: z.string().optional(),

  /* ---------- Oblien Cloud ---------- */
  OBLIEN_CLIENT_ID: z.string().optional(),
  OBLIEN_CLIENT_SECRET: z.string().optional(),

  /* ---------- Backup destinations ---------- */
  /**
   * Allow `kind: 'local'` backup destinations. Defaults OFF in CLOUD_MODE
   * (the SaaS would otherwise expose its multi-tenant filesystem to any
   * authenticated user), defaults ON for self-hosted single-operator
   * installs where the API process owns the host.
   */
  BACKUP_ALLOW_LOCAL_DESTINATION: z
    .enum(["true", "false", "1", "0", ""])
    .default("")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Absolute path that bounds every `kind: 'local'` destination.
   * Endpoints must resolve to a subpath of this root. Default
   * /var/lib/openship/backups. Symlinks are resolved before the check.
   */
  BACKUP_LOCAL_ROOT: z.string().default("/var/lib/openship/backups"),

  /**
   * Colon-separated extra roots accepted for `server.sshKeyPath`. The
   * default allowlist already includes /var/lib/openship/ssh-keys and
   * /etc/openship/ssh-keys — set this for installs that keep their
   * SSH keys somewhere else.
   */
  SSH_KEY_PATH_ROOTS: z.string().default(""),

  /* ---------- Screenshots (optional) ---------- */
  SCREENSHOT_SERVICE_URL: z.string().optional(),
  CDN_UPLOAD_URL: z.string().optional(),

  /* ---------- Internal (Electron ↔ API) ---------- */
  /** Shared secret for Electron → API calls (set by desktop app on startup) */
  INTERNAL_TOKEN: z.string().optional(),

  /* ---------- Mail webmail (Zero) ---------- */
  /**
   * Base URL of the Zero webmail server reachable from openship's API.
   * The Zero server owns its branding storage and exposes
   * `/branding.json` (public) + `/admin/branding` (token-auth). Openship
   * proxies dashboard branding writes here. Can be on the same VPS as
   * iRedMail, on a separate host, or even cross-region - wherever the
   * operator runs Zero.
   */
  MAIL_WEBMAIL_URL: z.string().default("http://localhost:3030"),
  /**
   * Shared secret matching the Zero server's `BRANDING_ADMIN_TOKEN`.
   * Sent as `X-Branding-Admin-Token` on writes. Never reaches the
   * browser; openship API holds it, dashboard talks to openship.
   */
  MAIL_WEBMAIL_ADMIN_TOKEN: z.string().optional(),

  /** Enables verbose timing logs for SSH/system checks and environment detection */
  SYSTEM_DEBUG_LOGS: z
    .enum(["true", "false", "1", "0", ""])
    .default("")
    .transform((v) => v === "true" || v === "1"),

  /* ---------- Interactive terminal (xterm over WebSocket → ssh2 PTY) ---------- */
  /**
   * Idle timeout - kill a terminal session that goes this long without
   * receiving any client input (stdin bytes). Defaults to 15 minutes.
   * Bound at 1min minimum so an operator can't accidentally disable it.
   */
  TERMINAL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(15 * 60_000),
  /**
   * Hard cap - terminate a session after this absolute wall-clock duration
   * regardless of activity. Defaults to 1 hour. Limits long-lived
   * sessions from accumulating across operator forgetting to close tabs.
   */
  TERMINAL_HARD_CAP_MS: z.coerce.number().int().min(60_000).default(60 * 60_000),
  /**
   * Maximum concurrent terminal sessions per user across all servers.
   * Enforced at handshake against the audit table (rows with endedAt IS
   * NULL). Defaults to 3.
   */
  TERMINAL_MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(50).default(3),
  /**
   * TTL for the one-shot WS handshake ticket. The dashboard requests a
   * ticket from a normal authenticated endpoint, then presents it in
   * `Sec-WebSocket-Protocol` when opening the WS. Tickets are single-use
   * and consumed by the WS server before the channel opens. Defaults to
   * 30 seconds - long enough to survive a slow handshake, short enough
   * that a leaked ticket has near-zero replay window.
   */
  TERMINAL_TICKET_TTL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  /**
   * Per-session server-side scrollback buffer cap in bytes. Every PTY
   * output chunk is appended to a ring buffer up to this size; older
   * bytes are dropped from the head when over. On resume (page reload,
   * tab swap, network blip), the WHOLE buffer is replayed to the new
   * WebSocket BEFORE any live output flows — so the user sees the
   * screen state as it was when they disconnected.
   *
   * Default 524288 bytes (512KB) ≈ 2000-3000 lines depending on width
   * and ANSI density. Bound at 16KB minimum (replay would be pointless
   * smaller) and 8MB maximum (memory budget per parked session).
   */
  TERMINAL_SCROLLBACK_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024)
    .max(8 * 1024 * 1024)
    .default(512 * 1024),
});

type ParsedEnv = z.infer<typeof envSchema>;
export type Env = ParsedEnv & { PORT: number };

function normalizeHttpOrigin(value: string, source: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }

    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${source} must be a valid http(s) origin.`);
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function validateProductionConfig(parsedEnv: Env, target: { id: string }) {
  if (parsedEnv.NODE_ENV !== "production") {
    return;
  }

  const errors: string[] = [];

  if (parsedEnv.BETTER_AUTH_SECRET === DEFAULT_BETTER_AUTH_SECRET) {
    errors.push("BETTER_AUTH_SECRET must be set to a secure value in production.");
  }

  if (parsedEnv.CLOUD_MODE && target.id !== "cloud-saas") {
    errors.push("CURRENT_SAAS_RUNTIME_TARGET_ID must be cloud-saas in production.");
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

const parsedEnv = envSchema.parse(process.env);

export const runtimeTarget = resolveDashboardRuntimeTarget({
  cloudMode: parsedEnv.CLOUD_MODE,
});

// The "cloud" target the local API talks to for OAuth exchange, App
// install URL minting, etc. Defaults to whatever the runtime config
// pins (`api.openship.io` in production) but allows an env override
// so dual-local dev (`bun dev:local` + `bun dev:saas`) can wire the
// two halves together without editing core.
const _resolvedCloudTarget = getDashboardRuntimeTarget(runtimeTarget.cloudTargetId);
export const cloudRuntimeTarget = {
  ..._resolvedCloudTarget,
  api: parsedEnv.CLOUD_API_URL || _resolvedCloudTarget.api,
  dashboard: parsedEnv.CLOUD_DASHBOARD_URL || _resolvedCloudTarget.dashboard,
};

export const env: Env = {
  ...parsedEnv,
  PORT: runtimeTarget.ports.api,
};

validateProductionConfig(env, runtimeTarget);

// ─── Self-hosted GitHub App creds are deprecated ────────────────────────────
//
// The GitHub App private key now lives exclusively in api.openship.io
// (CLOUD_MODE=true). Self-hosted instances proxy all App-scoped operations
// through cloud-client.ts. Setting these on a self-hosted instance has no
// effect but suggests the operator hasn't seen the new flow — warn so they
// know they can clean up their .env.
if (!env.CLOUD_MODE) {
  // GITHUB_APP_SLUG is intentionally NOT in this list — it IS consumed
  // on self-hosted (by getInstallUrl in github.auth.ts to build the
  // install link the dashboard shows). The other vars are App-private
  // credentials that have moved to api.openship.io exclusively.
  const stale = [
    env.GITHUB_APP_ID && "GITHUB_APP_ID",
    (env.GITHUB_PRIVATE_KEY || env.GITHUB_PRIVATE_KEY_BASE64) && "GITHUB_PRIVATE_KEY",
    env.GITHUB_WEBHOOK_SECRET && "GITHUB_WEBHOOK_SECRET",
  ].filter(Boolean);
  if (stale.length > 0) {
    console.warn(
      `[env] Self-hosted instances no longer use local GitHub App credentials. ` +
      `These env vars are ignored: ${stale.join(", ")}. ` +
      `Connect to Openship Cloud in Settings to enable App-scoped GitHub access.`,
    );
  }
}

/** Parsed trusted origins - single source of truth for CORS + Better Auth */
export const trustedOrigins = unique([
  normalizeHttpOrigin(runtimeTarget.dashboard, `runtime target ${runtimeTarget.id} dashboard`),
  normalizeHttpOrigin(runtimeTarget.api, `runtime target ${runtimeTarget.id} api`),
  ...(env.NODE_ENV === "production"
    ? []
    : [
        LOCAL_WEB_URL,
        ...getDashboardRuntimeOrigins(),
      ]),
]);

/** Internal loopback URL for the API (used by nginx webhook proxy, etc.) */
export const internalApiUrl = `http://127.0.0.1:${env.PORT}`;
