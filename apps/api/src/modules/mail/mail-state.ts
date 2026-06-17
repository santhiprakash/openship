/**
 * Mail-server install state - lives on the target VPS, not in openship's DB.
 *
 * Rationale: state about "what's installed on this server" belongs with the
 * server. If the operator purges the VPS, the state file dies with it -
 * no stale "step 9 complete" rows in openship's DB to confuse the next
 * install attempt. Same model as Terraform's remote state on the resource
 * being managed, or Ansible facts living on the host.
 *
 * The file is one JSON object at a fixed path. We never lock - there's at
 * most one install per server at a time, enforced by the controller's
 * in-memory `activeSession` flag.
 *
 * Logs are persisted here as a capped ring buffer so a page refresh
 * during/after an install can rehydrate the live log panel instead of
 * showing "logs will stream once setup starts". The cap is generous
 * enough for normal installs but bounded to keep the state file small
 * (SSH-read on every getStatus).
 */
const MAX_PERSISTED_LOGS = 800;

import type { CommandExecutor } from "@repo/adapters";

/**
 * Where the state file lives on the target server. `/root/` matches
 * iRedMail's own convention (it writes `/root/.iredmail/kv/`).
 */
export const STATE_FILE_PATH = "/root/.openship-mail-state.json";

const STATE_VERSION = 1;

/**
 * Webmail (Zero) deployment record. Set after a successful deploy through
 * /mail/webmail/deploy. Absence = "not deployed" - the overview UI uses
 * this to decide between the Deploy CTA and the Open-webmail CTA.
 *
 * Webmail can live on the mail VPS (most common, `targetServerId` equal
 * to the mail server's serverId) OR on a different openship-managed
 * server. The `url` is whatever clients should open in a browser.
 *
 * `brandingToken` is the shared secret openship's API uses to PATCH the
 * Zero `/admin/branding` endpoint. Never sent to the dashboard - only
 * the API reads it.
 */
export interface MailWebmailState {
  /** True once deploy succeeded end-to-end and health check passed. */
  installed: boolean;
  /**
   * Where the webmail runs.
   *   "self"  - operator-managed server (this mail VPS or another openship server).
   *   "cloud" - Opshcloud-managed, behind an *.opsh.io URL.
   *
   * Defaults to "self" when missing.
   */
  target?: "self" | "cloud";
  /**
   * openship serverId hosting the Zero process. For target="cloud" this
   * is the empty string - there is no openship server, the workload lives
   * inside Opshcloud.
   */
  targetServerId: string;
  /** Public hostname the operator typed into the deploy modal. */
  hostname: string;
  /** Browser URL, e.g. https://mail.oblien.com/. */
  url: string;
  /**
   * For target="cloud", the *.opsh.io URL Opshcloud minted for this deploy.
   * When `hostname` is the mail server's own `mail.<domain>` subdomain (DNS
   * already pinned to the mail VPS for IMAP/SMTP), the mail server's
   * OpenResty proxies that hostname → this URL.
   */
  cloudUrl?: string;
  /** Internal port the Zero server binds to on the target host. */
  internalPort: number;
  /** Shared admin secret for openship → Zero PATCH /admin/branding. */
  brandingToken: string;
  /**
   * Hex-encoded session-cookie encryption key. Generated once at first
   * deploy and reused across redeploys so existing sessions survive - a
   * fresh key here logs every operator out.
   */
  sessionEncryptionKey: string;
  /** ISO timestamp of the last successful deploy. */
  deployedAt: string;
  /** Source revision deployed - git SHA when we read from a release, or "local" during dev copies. */
  version: string;
}

export interface MailStepResult {
  stepId: number;
  success: boolean;
  message: string;
  warning?: string;
  data?: Record<string, unknown>;
}

/**
 * One DNS record. Matches the shape `stepDkimKeys` emits and what
 * `DnsRecordsView` on the dashboard renders. Kept in the state module
 * so admin/domain-dns.service can import it without crossing module
 * boundaries.
 */
export interface PersistedDnsRecord {
  type: string;
  name: string;
  value: string;
  /** MX priority. Ignored for non-MX records. */
  priority?: number;
  /** False = optional helper, not required for mail delivery. */
  required?: boolean;
}

/**
 * Set of records published per domain. The primary install records use
 * a superset of this (plus A/AAAA host records on the mail subdomain).
 * Additional domains added through the admin panel only need MX/SPF/DMARC
 * - DKIM stays optional because we don't auto-provision a keypair for
 * every new domain; iRedMail's `amavisd genrsa` is a manual operator
 * action when the operator wants signed mail from that domain.
 */
export interface DnsRecordSet {
  mx: PersistedDnsRecord;
  spf: PersistedDnsRecord;
  dkim?: PersistedDnsRecord;
  dmarc: PersistedDnsRecord;
}

/**
 * DNS provisioning record for an additional domain (one added through
 * the admin panel after the primary install). The dashboard's Domains
 * tab uses `acknowledgedAt === null` to keep showing the
 * "publish DNS records" banner until the operator clicks
 * "I've set the records - continue".
 */
export interface AdditionalDomainDns {
  records: DnsRecordSet;
  /** ISO timestamp the operator acked the records. null = still pending. */
  acknowledgedAt: string | null;
  /** ISO timestamp the domain was added through the admin panel. */
  createdAt: string;
  /**
   * Plaintext password for `postmaster@<domain>`, auto-generated when the
   * domain is added through the admin panel. iRedMail's installer creates
   * the postmaster for the primary install (we keep that password in
   * `secrets.DOMAIN_ADMIN_PASSWD_PLAIN`); for additional domains we
   * mirror that behavior so every domain has a working SMTP-Auth account
   * out of the box - the welcome test-email and any future
   * orchestrator-driven sending both rely on it. State file lives at
   * `/root/.openship-mail-state.json` with root-only permissions, same
   * blast radius as `/etc/dovecot/dovecot-sql.conf`.
   */
  postmasterPassword?: string;
}

/** Single line of streamed output. Shape mirrors what the SSE event carries. */
export interface MailSessionLogLine {
  stepId: number;
  level: "info" | "warn" | "error";
  message: string;
  /** ms since epoch - handy for replay ordering, not displayed verbatim. */
  ts: number;
}

export interface MailServerState {
  /** Bump on schema changes - readers older than this MUST refuse the file. */
  version: number;
  /**
   * The openship serverId that owns this install. Not validated (the file is
   * trusted; openship is the only writer), but lets the dashboard cross-check.
   */
  serverId: string;
  /** Primary mail domain (`mail.<domain>` is the SMTP/IMAP host). */
  domain: string;
  startedAt: string;
  /** Last time we wrote - handy for "when was last activity" displays. */
  updatedAt: string;
  /** Set once every step finishes successfully. */
  finishedAt: string | null;
  /** Step → result. The keys are stepId as a string (JSON key constraint). */
  completedSteps: Record<string, MailStepResult>;
  /**
   * iRedMail config secrets (DB passwords, API tokens). Persisted so a
   * retry reuses the same values iRedMail already baked into its configs
   * - regenerating mid-install desyncs from what's on disk and breaks
   * the install.
   */
  secrets: Record<string, string>;
  /** DNS records emitted by the dkim_keys step. */
  dnsRecords: Record<string, unknown> | null;
  /** Flips true when the user clicks "I've set the records - continue". */
  dnsAcknowledged: boolean;
  /**
   * Flips true when the user acks the PTR (reverse DNS) gate. PTRs are
   * configured at the VPS provider's panel, not the DNS provider - separate
   * banner so the two don't get mixed up. Pauses between dnsAcknowledged
   * and step 12 (SSL).
   */
  ptrAcknowledged: boolean;
  /** Step the user should resume from (set on failure or DKIM pause). */
  resumeStep: number | null;
  errorMessage: string | null;
  /**
   * Capped ring buffer of streamed log lines. Lets the dashboard show
   * recent install output after a refresh. Trimmed to MAX_PERSISTED_LOGS
   * - older lines fall off the front.
   */
  logs?: MailSessionLogLine[];
  /**
   * Optional webmail (Zero) deployment record. Absent = not deployed.
   * Lives next to the iRedMail install state because openship treats
   * webmail as a feature of the mail server, not a standalone project.
   */
  webmail?: MailWebmailState;
  /**
   * Per-domain DNS provisioning state for additional domains added via
   * the admin panel (after the primary install). The primary install
   * domain's records live in `dnsRecords` above; this map carries the
   * record set + ack timestamp for every additional domain so the
   * Domains tab can render a "publish records" banner until the
   * operator confirms.
   */
  additionalDomains?: Record<string, AdditionalDomainDns>;
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

/**
 * Read the state file. Returns null if it doesn't exist OR fails to parse -
 * caller should treat null as "fresh install, no prior state."
 *
 * Doesn't throw on missing file (uses `|| echo` to avoid non-zero exit).
 * DOES log a warning if the file exists but is malformed so the operator
 * can investigate.
 */
export async function readState(
  exec: CommandExecutor,
): Promise<MailServerState | null> {
  let raw: string;
  try {
    raw = await exec.exec(
      `[ -f ${STATE_FILE_PATH} ] && cat ${STATE_FILE_PATH} || echo ""`,
    );
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as MailServerState;
    if (parsed.version !== STATE_VERSION) {
      console.warn(
        `mail-state: ${STATE_FILE_PATH} has version ${parsed.version}, expected ${STATE_VERSION} - ignoring`,
      );
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(
      `mail-state: failed to parse ${STATE_FILE_PATH}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Write the state file atomically: write to a sibling temp file then rename.
 * Means a kill mid-write never leaves a half-flushed JSON on disk.
 */
export async function writeState(
  exec: CommandExecutor,
  state: MailServerState,
): Promise<void> {
  const next: MailServerState = {
    ...state,
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${STATE_FILE_PATH}.tmp`;
  await exec.writeFile(tmp, JSON.stringify(next, null, 2));
  await exec.exec(
    `mv -f ${tmp} ${STATE_FILE_PATH} && chmod 0600 ${STATE_FILE_PATH}`,
  );
}

/** Wipe the state file. The next install will run as if fresh. */
export async function clearState(exec: CommandExecutor): Promise<void> {
  await exec.exec(`rm -f ${STATE_FILE_PATH} ${STATE_FILE_PATH}.tmp`);
}

// ─── Construction / mutation helpers ─────────────────────────────────────────

/**
 * Make a fresh state object for a new install. Caller writes it via
 * `writeState`. Sets timestamps + the version stamp.
 */
export function makeFreshState(
  serverId: string,
  domain: string,
): MailServerState {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    serverId,
    domain,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    completedSteps: {},
    secrets: {},
    dnsRecords: null,
    dnsAcknowledged: false,
    ptrAcknowledged: false,
    resumeStep: null,
    errorMessage: null,
    logs: [],
  };
}

/**
 * Append a log line to a mutable buffer, capping at MAX_PERSISTED_LOGS.
 * Caller passes the array directly so the controller can keep one
 * working copy in memory and persist on step boundaries.
 */
export function appendLog(
  logs: MailSessionLogLine[],
  stepId: number,
  level: MailSessionLogLine["level"],
  message: string,
): void {
  logs.push({ stepId, level, message, ts: Date.now() });
  if (logs.length > MAX_PERSISTED_LOGS) {
    logs.splice(0, logs.length - MAX_PERSISTED_LOGS);
  }
}

/** Record a step result onto the state object. Pure - caller writes. */
export function recordStep(
  state: MailServerState,
  result: MailStepResult,
): MailServerState {
  return {
    ...state,
    completedSteps: {
      ...state.completedSteps,
      [String(result.stepId)]: result,
    },
  };
}

/** Merge in newly-generated secrets without dropping existing ones. */
export function mergeSecrets(
  state: MailServerState,
  secrets: Record<string, string>,
): MailServerState {
  return { ...state, secrets: { ...state.secrets, ...secrets } };
}
