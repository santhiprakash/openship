/**
 * SSL service - certificate status checks and renewal via platform adapters.
 */

import { repos } from "@repo/db";
import { NotFoundError } from "@repo/core";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { manageDomainSsl } from "../../lib/domain-ssl";

/**
 * Check SSL status for a domain.
 * Returns the DB record + live cert info from the adapter.
 */
export async function getStatus(hostname: string, organizationId: string) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  // Verify ownership through project's organization
  const project = await repos.project.findById(domainRecord.projectId);
  assertResourceInOrg(project, "Project", organizationId, domainRecord.projectId);

  return {
    domain: domainRecord.hostname,
    sslStatus: domainRecord.sslStatus,
    sslIssuer: domainRecord.sslIssuer,
    sslExpiresAt: domainRecord.sslExpiresAt,
    verified: domainRecord.verified,
  };
}

/**
 * Renew (or provision) an SSL certificate for a domain.
 *
 * Org-scoped: resolves the domain to its project and refuses if the
 * project doesn't belong to the caller's org. Without this any user
 * with deployment:write in any org could trigger ACME renewal on any
 * domain — burns the shared Let's Encrypt rate-limit pool and writes
 * across tenants.
 */
export async function renew(
  hostname: string,
  organizationId: string,
  includeWww = false,
) {
  const domainRecord = await repos.domain.findByHostname(hostname);
  if (!domainRecord) throw new NotFoundError("Domain", hostname);

  const project = await repos.project.findById(domainRecord.projectId);
  assertResourceInOrg(project, "Project", organizationId, domainRecord.projectId);

  const result = await manageDomainSsl(hostname, {
    action: "renew",
    includeWww,
  });

  return {
    success: true,
    domain: hostname,
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}

