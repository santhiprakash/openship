/**
 * SSL renewal - on-demand batch renewal of expiring certificates.
 *
 * Not a background scheduler. Call `renewExpiringCerts()` from:
 *   - An admin / internal API endpoint (e.g. POST /api/domains/renew)
 *   - An external cron job (Kubernetes CronJob, systemd timer, etc.)
 *
 * In most setups renewal is handled by the infrastructure layer itself:
 *   - Docker: Traefik / Caddy auto-renew Let's Encrypt certs
 *   - Cloud:  Provider manages TLS termination
 *
 * This function exists as a fallback for setups where we provision certs
 * ourselves via the adapter's `provisionCert` / `renewCert` methods.
 */

import { repos } from "@repo/db";
import { SYSTEM } from "@repo/core";
import { platform } from "./controller-helpers";
import { notification } from "./notification-dispatcher";

// ─── Core renewal logic ──────────────────────────────────────────────────────

export interface RenewalResult {
  renewed: number;
  failed: number;
  total: number;
  details: Array<{ domain: string; status: "renewed" | "failed"; error?: string }>;
}

/**
 * Renew all SSL certificates expiring within `SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS`.
 *
 * - Batched to `SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE` per call
 * - De-duplicates project → user lookups
 * - Sends notifications on success / failure
 * - Returns a structured result for the caller to log or return to the client
 */
export async function renewExpiringCerts(): Promise<RenewalResult> {
  const { ssl } = platform();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS);

  const allDomains = await repos.domain.findExpiringSsl(cutoff);

  if (allDomains.length === 0) {
    return { renewed: 0, failed: 0, total: 0, details: [] };
  }

  const batch = allDomains.slice(0, SYSTEM.DOMAINS.SSL_RENEW_BATCH_SIZE);

  // Pre-fetch project → (org, project name) so the dispatcher knows
  // which org to fan out the notification to. Each org's members each
  // receive notifications via their configured channels.
  const projectIds = [...new Set(batch.map((d) => d.projectId))];
  const projectCache = new Map<
    string,
    { organizationId: string; projectName: string }
  >();
  for (const pid of projectIds) {
    const project = await repos.project.findById(pid);
    if (!project) continue;
    projectCache.set(pid, {
      organizationId: project.organizationId,
      projectName: project.name,
    });
  }

  const details: RenewalResult["details"] = [];
  let renewed = 0;
  let failed = 0;

  for (const domain of batch) {
    const ctx = projectCache.get(domain.projectId);

    try {
      const result = await ssl.renewCert(domain.hostname);

      await repos.domain.updateSsl(domain.id, {
        sslStatus: "active",
        sslExpiresAt: new Date(result.expiresAt),
        sslIssuer: result.issuer,
      });

      renewed++;
      details.push({ domain: domain.hostname, status: "renewed" });

      // ssl_renewed isn't a notification category (renewal success is
      // expected — only failures are noteworthy). Skip dispatch.
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      details.push({ domain: domain.hostname, status: "failed", error: message });

      await repos.domain.updateSsl(domain.id, { sslStatus: "error" }).catch(() => {});

      if (ctx) {
        const daysLeft = Math.ceil(
          ((domain.sslExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000,
        );
        notification.emit({
          organizationId: ctx.organizationId,
          eventType: "ssl.renewal_failed",
          resourceType: "domain",
          resourceId: domain.id,
          payload: {
            projectName: ctx.projectName,
            domain: domain.hostname,
            daysLeft,
            errorMessage: message,
          },
        });
      }
    }
  }

  return { renewed, failed, total: allDomains.length, details };
}
