/**
 * Domain service - custom domains, DNS verification, SSL certificates.
 *
 * Cloud mode  → CNAME (target from Oblien) + TXT (verification hash)
 * Self-hosted → A record (server IP)       + TXT (verification hash)
 *
 * verifyDomain checks DNS and, on success, kicks off SSL provisioning
 * + promotes the domain to primary if no other custom primary exists.
 * The SSL provisioner (nginx.ts) reads the existing HTTP-only route
 * config off disk and re-registers it with TLS once the cert lands,
 * so no route registration is needed here — the existing infra is
 * reused. SSL provisioning runs in the background; the verify response
 * stays fast and a failed cert (rate-limit, ACME outage) shows up
 * in the SSL status pill on the next read.
 */

import { createHmac } from "node:crypto";
import { repos, type Domain, type Project } from "@repo/db";
import { NotFoundError, ConflictError, ForbiddenError, ValidationError, safeErrorMessage } from "@repo/core";
import { platform, assertResourceInOrg } from "../../lib/controller-helpers";
import { manageDomainSsl } from "../../lib/domain-ssl";
import { getRoutingBaseDomain } from "../../lib/routing-domains";
import { resolveRecords } from "../../lib/dns-resolver";
import { env } from "../../config/env";
import { resolveProjectServerHost } from "../../lib/server-target";
import type { TAddDomainBody } from "./domain.schema";
import type { CloudRuntime } from "@repo/adapters";

// ─── Token ───────────────────────────────────────────────────────────────────

/**
 * Deterministic verification token for a hostname.
 * HMAC-SHA256(hostname, secret) → hex prefix. Same input always produces
 * the same output so preview and stored tokens match.
 */
function generateToken(hostname: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(hostname.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

// ─── List ────────────────────────────────────────────────────────────────────

export async function listDomains(projectId: string, organizationId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  return repos.domain.listByProject(projectId);
}

// ─── Add ─────────────────────────────────────────────────────────────────────

export async function addDomain(organizationId: string, data: TAddDomainBody) {
  const project = await repos.project.findById(data.projectId);
  assertResourceInOrg(project, "Project", organizationId, data.projectId);

  // Normalize: strip whitespace + protocol + trailing slash, lowercase.
  // Reject obviously-bogus shapes before they ever reach the DB.
  const hostname = data.hostname
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  if (!hostname) {
    throw new ValidationError("Hostname is required.");
  }

  // The TypeBox schema (route-level tbValidator) already enforces the
  // hostname regex + length, so anything reaching this point is shaped
  // like a valid DNS name. But the schema doesn't know about managed
  // hostnames — those are free *.opsh.io subdomains that belong in
  // project.publicEndpoints (with domainType="free"), not in the custom-
  // domain table. Refuse them here so users don't accidentally claim a
  // managed slug via the "add custom domain" flow and bypass the free-
  // domain slug picker.
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  if (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)) {
    throw new ValidationError(
      `${baseDomain} subdomains are free managed domains — set them in the project's public endpoints, not as a custom domain.`,
    );
  }

  // Block obvious junk: localhost / IP / unicode-only host / single-label.
  if (
    hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    !hostname.includes(".") ||
    hostname.startsWith(".") ||
    hostname.endsWith(".")
  ) {
    throw new ValidationError(`"${hostname}" is not a valid public hostname.`);
  }

  const existing = await repos.domain.findByHostname(hostname);
  if (existing) {
    throw new ConflictError(`Domain "${hostname}" is already in use`);
  }

  const token = generateToken(hostname);

  const domain = await repos.domain.create({
    projectId: data.projectId,
    hostname,
    // User-added via POST /domains is always a CUSTOM domain (free
    // managed slugs come in via publicEndpoints — see check above).
    domainType: "custom",
    // Brand-new domain — must be DNS-verified before it's active.
    // The `/verify` endpoint runs the CNAME + TXT check and flips this.
    verified: false,
    status: "pending",
    isPrimary: data.isPrimary ?? false,
    verificationToken: token,
  });

  if (data.isPrimary) {
    await repos.domain.setPrimary(data.projectId, domain.id);
  }

  const records = await buildRecords(domain.hostname, token, project);
  return { domain, records };
}

// ─── Preview records (no auth, no DB write) ──────────────────────────────────

export async function previewRecords(hostname: string) {
  const token = generateToken(hostname);
  return buildRecords(hostname, token);
}

// ─── Get DNS records (existing domain) ───────────────────────────────────────

export async function getDomainRecords(domainId: string, organizationId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, organizationId);
  const token = domain.verificationToken ?? generateToken(domain.hostname);
  return buildRecords(domain.hostname, token, project);
}

// ─── Verify ──────────────────────────────────────────────────────────────────
//
// Checks DNS records and, on success, marks verified + active, promotes
// to primary (when no other custom primary exists), and fires SSL
// provisioning in the background. The SSL provider re-registers the
// route with TLS internally, so no explicit route reconciler is needed.

export async function verifyDomain(domainId: string, organizationId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, organizationId);

  if (domain.verified) {
    return {
      verified: true,
      cnameVerified: true,
      txtVerified: true,
      message: "Already verified",
      sslStatus: domain.sslStatus,
    };
  }

  const { target } = platform();
  const token = domain.verificationToken ?? generateToken(domain.hostname);

  // 1. Routing record - cloud: CNAME via Oblien, self-hosted: A record
  const routeOk = target === "cloud"
    ? await verifyCname(domain.hostname)
    : await verifyARecord(domain.hostname, project);

  // 2. Ownership - TXT record with verification hash
  const txtOk = await verifyTxt(domain.hostname, token);

  if (routeOk && txtOk) {
    await repos.domain.markVerified(domainId);

    // Promote to primary when this is a custom domain and no other
    // custom primary exists. Free .opsh.io stays as the always-on
    // fallback but the custom domain now becomes the "real" entry point
    // for analytics and the dashboard's "Visit" link.
    if (domain.domainType === "custom") {
      const peers = await repos.domain.listByProject(domain.projectId);
      const hasOtherCustomPrimary = peers.some(
        (peer) => peer.id !== domainId && peer.isPrimary && peer.domainType === "custom",
      );
      if (!hasOtherCustomPrimary) {
        await repos.domain.setPrimary(domain.projectId, domainId);
      }
    }

    // Background SSL provisioning. Don't await — the verify response
    // stays fast and the SSL status pill updates on the next list read.
    // Failure here is non-fatal: the HTTP route is still up, the user
    // can hit Renew explicitly, and ssl-scheduler picks it up on the
    // next renewal tick once the cert lands.
    void manageDomainSsl(domain.hostname, {
      action: "provision",
      projectId: domain.projectId,
    }).catch((err) => {
      console.error(
        `[DOMAIN] Background SSL provisioning failed for ${domain.hostname}:`,
        err instanceof Error ? err.message : err,
      );
    });

    return {
      verified: true,
      cnameVerified: true,
      txtVerified: true,
      message: "Domain verified — SSL provisioning started",
      sslStatus: "provisioning",
    };
  }

  return {
    verified: false,
    cnameVerified: routeOk,
    txtVerified: txtOk,
    message: verifyMessage(domain.hostname, token, routeOk, txtOk, target),
  };
}

// ─── Remove ──────────────────────────────────────────────────────────────────

export async function removeDomain(domainId: string, organizationId: string) {
  const { domain } = await getDomainWithAuth(domainId, organizationId);

  try {
    const { routing } = platform();
    await routing.removeRoute(domain.hostname);
  } catch (err) {
    console.error(`[DOMAIN] Failed to remove route for ${domain.hostname}:`, err);
  }

  await repos.domain.remove(domainId);
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export async function renewDomainSsl(domainId: string, organizationId: string) {
  const { domain } = await getDomainWithAuth(domainId, organizationId);

  const result = await manageDomainSsl(domain.hostname, {
    action: "renew",
  });

  return {
    domain: domain.hostname,
    sslStatus: result.expiresAt ? "active" : "provisioning",
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}

export { renewExpiringCerts } from "../../lib/ssl-scheduler";

// ─── Batch pending verification ──────────────────────────────────────────────
//
// Cron / on-demand entrypoint that re-checks DNS for every domain still in
// `pending` state and old enough that the user has had time to add the
// records. Mirrors `renewExpiringCerts` but for the verification half of
// the lifecycle. Called from POST /domains/verify-pending (admin/cron) and
// safe to invoke from a Kubernetes CronJob / systemd timer / external
// scheduler — does not require an authenticated user context.

export interface PendingVerificationResult {
  verified: number;
  stillPending: number;
  failed: number;
  total: number;
  details: Array<{
    hostname: string;
    status: "verified" | "still_pending" | "failed";
    message?: string;
    error?: string;
  }>;
}

export async function verifyPendingDomains(opts?: {
  /**
   * Skip rows added within the last N minutes so a freshly-added domain
   * (still in the Verify-button click window) isn't yanked out from under
   * the user by the cron. Defaults to 10 minutes.
   */
  minAgeMinutes?: number;
  /** Cap iterations per call so a backlog doesn't lock the worker. */
  limit?: number;
}): Promise<PendingVerificationResult> {
  const minAgeMinutes = opts?.minAgeMinutes ?? 10;
  const limit = opts?.limit ?? 50;
  const cutoff = new Date(Date.now() - minAgeMinutes * 60_000);

  const pending = await repos.domain.findPendingVerification(cutoff, limit);
  const result: PendingVerificationResult = {
    verified: 0,
    stillPending: 0,
    failed: 0,
    total: pending.length,
    details: [],
  };

  for (const domain of pending) {
    const project = await repos.project.findById(domain.projectId);
    if (!project) {
      // Project may have been deleted between the find and now — skip,
      // don't fail. The orphan domain row will get cleaned up by
      // deleteByProjectId on the next cascade.
      continue;
    }

    if (!project.organizationId) {
      // Domain belongs to a project with no org binding — skip safely
      // rather than risk a cross-tenant verify.
      continue;
    }

    try {
      // Re-use verifyDomain — same DNS check, same markVerified + isPrimary
      // promotion + background SSL provisioning. Passing the project's
      // organization satisfies the auth check in getDomainWithAuth without
      // the cron needing a session.
      const verifyResult = await verifyDomain(
        domain.id,
        project.organizationId,
      );
      if (verifyResult.verified) {
        result.verified++;
        result.details.push({ hostname: domain.hostname, status: "verified" });
      } else {
        result.stillPending++;
        result.details.push({
          hostname: domain.hostname,
          status: "still_pending",
          message: verifyResult.message,
        });
      }
    } catch (err) {
      result.failed++;
      const message = safeErrorMessage(err);
      result.details.push({
        hostname: domain.hostname,
        status: "failed",
        error: message,
      });
    }
  }

  return result;
}

export async function renewOrgCerts(organizationId: string) {
  const projects = await repos.project.listByOrganization(organizationId, { page: 1, perPage: 1000 });
  const results: Array<{ domain: string; status: string; error?: string }> = [];

  for (const p of projects.rows) {
    const domains = await repos.domain.listByProject(p.id);
    for (const d of domains) {
      if (d.sslStatus !== "active" || !d.sslExpiresAt) continue;
      const daysLeft = (new Date(d.sslExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysLeft > 14) continue;
      try {
        await renewDomainSsl(d.id, organizationId);
        results.push({ domain: d.hostname, status: "renewed" });
      } catch (err) {
        results.push({ domain: d.hostname, status: "failed", error: safeErrorMessage(err) });
      }
    }
  }

  return { renewed: results.filter((r) => r.status === "renewed").length, results };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getDomainWithAuth(
  domainId: string,
  organizationId: string,
): Promise<{ domain: Domain; project: Project }> {
  const domain = await repos.domain.findById(domainId);
  if (!domain) throw new NotFoundError("Domain", domainId);

  const project = await repos.project.findById(domain.projectId);
  assertResourceInOrg(project, "Domain", organizationId, domainId);

  return { domain, project: project as Project };
}

// ── DNS resolution (Google DNS-over-HTTPS → node:dns fallback) ───────────────

// DNS resolution is shared with preflight via apps/api/src/lib/dns-resolver.ts —
// see the imported `resolveRecords` at the top of this file.

// ── DNS checks ───────────────────────────────────────────────────────────────

/** Cloud: ask Oblien if the CNAME is pointing correctly. */
async function verifyCname(hostname: string): Promise<boolean> {
  const { runtime } = platform();
  try {
    const cloud = runtime as CloudRuntime;
    const result = await cloud.verifyDomain(hostname);
    return result.cname;
  } catch {
    return false;
  }
}

/** Self-hosted: check if an A record resolves to our server IP. */
async function verifyARecord(hostname: string, project?: Project): Promise<boolean> {
  const serverIp = await resolveProjectServerHost(project);
  if (!serverIp) return false;

  const records = await resolveRecords(hostname, "A");
  return records.includes(serverIp);
}

/** Check _openship-challenge.{hostname} TXT record for verification token. */
async function verifyTxt(hostname: string, token: string): Promise<boolean> {
  const records = await resolveRecords(`_openship-challenge.${hostname}`, "TXT");
  return records.some((v) => v === token);
}

// ── Record generation ────────────────────────────────────────────────────────

type DnsRecord =
  | { type: "CNAME"; host: string; value: string }
  | { type: "A"; host: string; value: string }
  | { type: "TXT"; host: string; value: string };

/**
 * Build the DNS records the user needs to add.
 *
 * Cloud       → CNAME @ → <target from Oblien>
 * Self-hosted → A     @ → <server public IP>
 * Both        → TXT _openship-challenge → <verification hash>
 */
async function buildRecords(
  hostname: string,
  token: string,
  project?: Project,
): Promise<{ mode: "cloud" | "selfhosted"; records: DnsRecord[] }> {
  const { target, runtime } = platform();

  const txt: DnsRecord = { type: "TXT", host: "_openship-challenge", value: token };

  if (target === "cloud") {
    let cnameTarget: string | null = null;
    try {
      const cloud = runtime as CloudRuntime;
      const result = await cloud.verifyDomain(hostname);
      cnameTarget = result.requiredRecords.cname.target;
    } catch { /* Oblien unreachable */ }

    return {
      mode: "cloud",
      records: [{ type: "CNAME", host: "@", value: cnameTarget ?? "" }, txt],
    };
  }

  // Self-hosted - A record
  const serverIp = await resolveProjectServerHost(project);
  return {
    mode: "selfhosted",
    records: [{ type: "A", host: "@", value: serverIp ?? "" }, txt],
  };
}

/** Build a human-readable verification failure message. */
function verifyMessage(
  hostname: string,
  token: string,
  routeOk: boolean,
  txtOk: boolean,
  target: string,
): string {
  const parts: string[] = [];

  if (!routeOk) {
    parts.push(
      target === "cloud"
        ? `CNAME record not found for ${hostname}`
        : `A record not pointing to server for ${hostname}`,
    );
  }

  if (!txtOk) {
    parts.push(`TXT record _openship-challenge.${hostname} must equal "${token}"`);
  }

  return parts.join(". ");
}

