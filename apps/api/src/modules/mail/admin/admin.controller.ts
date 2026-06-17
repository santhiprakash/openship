/**
 * HTTP handlers for the mail admin panel.
 *
 * Thin layer over the service files in this folder - validates input,
 * extracts path / query params, calls the service, maps known errors to
 * 4xx responses. No business logic lives here.
 *
 * All routes are mounted under `/api/mail/admin/:serverId/…` in
 * `../mail.routes.ts` behind `localOnly` + `authMiddleware`.
 */

import type { Context } from "hono";
import { env } from "../../../config";
import { repos } from "@repo/db";
import { getActiveOrganizationId } from "../../../lib/controller-helpers";
import { permission } from "../../../lib/permission";
import {
  countDomainDependents,
  createDomain,
  deleteDomain,
  DomainExistsError,
  DomainHasDependentsError,
  DomainNotFoundError,
  getDomain,
  listDomains,
  updateDomain,
  validateDomain,
} from "./domains.service";
import {
  createMailbox,
  hardDeleteMailbox,
  getMailbox,
  listMailboxes,
  MailboxExistsError,
  MailboxNotFoundError,
  softDeleteMailbox,
  updateMailbox,
} from "./mailboxes.service";
import { getMailServerStats } from "./stats.service";
import { scanDns } from "./dns-scan.service";
import { sendTestEmail, TestEmailError } from "./test-email.service";
import { safeErrorMessage } from "@repo/core";
import {
  getComponentLogs,
  restartAllComponents,
  runComponentAction,
  UnknownComponentError,
  type ComponentAction,
} from "./components.service";
import {
  acknowledgeDomainDns,
  getDomainDnsState,
  listPendingDomainDns,
} from "./domain-dns.service";

function localOnlyGuard(c: Context): Response | null {
  if (env.CLOUD_MODE) {
    return c.json({ error: "Not available in cloud mode" }, 404);
  }
  return null;
}

function getActingAdmin(c: Context): string {
  const user = c.get("user") as { email?: string; name?: string; id?: string } | undefined;
  return user?.email || user?.name || user?.id || "unknown";
}

function requireServerId(c: Context): string {
  const id = c.req.param("serverId");
  if (!id) throw new Error("serverId is required");
  return id;
}

/**
 * Org-scoped guard: confirms the path's :serverId belongs to the caller's
 * active organization. Returns null on success; returns a 404 Response on
 * failure that handlers should pass straight back to the client. Both
 * unknown and out-of-org server ids 404 indistinguishably to prevent
 * cross-tenant existence leaks.
 *
 * Every admin handler (domains, mailboxes, components, dns, stats, etc.)
 * must call this — they all reach the iRedMail psql/SSH layer via the
 * named serverId, so an unguarded handler is a full mail-admin takeover.
 */
async function assertServerInOrg(
  c: Context,
  serverId: string,
): Promise<Response | null> {
  const organizationId = getActiveOrganizationId(c);
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) {
    return c.json({ error: "Server not found" }, 404);
  }
  return null;
}

// ─── Domains ─────────────────────────────────────────────────────────────────

export async function listDomainsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  try {
    const rows = await listDomains(serverId);
    return c.json({ domains: rows });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function getDomainHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    const row = await getDomain(serverId, domain);
    if (!row) return c.json({ error: "Domain not found" }, 404);
    return c.json({ domain: row });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function createDomainHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const body = await c.req.json().catch(() => ({}));
  try {
    const { row, dnsWarning } = await createDomain(serverId, {
      domain: String(body.domain ?? ""),
      description: body.description ? String(body.description) : undefined,
      maxMailboxes: body.maxMailboxes != null ? Number(body.maxMailboxes) : undefined,
      maxAliases: body.maxAliases != null ? Number(body.maxAliases) : undefined,
      defaultQuotaMB: body.defaultQuotaMB != null ? Number(body.defaultQuotaMB) : undefined,
    });
    return c.json({ domain: row, dnsWarning }, 201);
  } catch (err) {
    if (err instanceof DomainExistsError) {
      return c.json({ error: err.message }, 409);
    }
    return errorJson(c, err);
  }
}

export async function updateDomainHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await updateDomain(serverId, domain, {
      description: body.description != null ? String(body.description) : undefined,
      maxMailboxes: body.maxMailboxes != null ? Number(body.maxMailboxes) : undefined,
      maxAliases: body.maxAliases != null ? Number(body.maxAliases) : undefined,
      defaultQuotaMB: body.defaultQuotaMB != null ? Number(body.defaultQuotaMB) : undefined,
      active: body.active != null ? Boolean(body.active) : undefined,
    });
    return c.json({ domain: row });
  } catch (err) {
    if (err instanceof DomainNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

export async function deleteDomainHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  const cascade = c.req.query("cascade") === "true";
  try {
    await deleteDomain(serverId, domain, { cascade });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof DomainHasDependentsError) {
      return c.json(
        { error: err.message, dependents: err.dependents },
        409,
      );
    }
    return errorJson(c, err);
  }
}

// ─── Per-domain DNS (additional domains) ─────────────────────────────────────

/**
 * GET the DNS state for one domain. Returns 404 when no DNS records have
 * been generated for it (which is the case for the primary install
 * domain - its records live under /mail/status as the install-time
 * `dnsRecords`, not here).
 */
export async function getDomainDnsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    const state = await getDomainDnsState(serverId, domain.toLowerCase());
    if (!state) {
      return c.json({ error: "No DNS state for this domain" }, 404);
    }
    return c.json({ domain: domain.toLowerCase(), ...state });
  } catch (err) {
    return errorJson(c, err);
  }
}

/**
 * POST acknowledgement: operator confirmed they published the records.
 * Flips `acknowledgedAt` to now; the Domains tab stops rendering the
 * banner for this domain on the next reload.
 */
export async function acknowledgeDomainDnsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    await acknowledgeDomainDns(serverId, domain.toLowerCase());
    return c.json({ ok: true });
  } catch (err) {
    return errorJson(c, err);
  }
}

/**
 * GET every additional domain whose DNS publication is still pending
 * (acknowledgedAt == null). Lets the Domains tab render a stack of
 * banners in one round-trip instead of per-row.
 */
export async function pendingDomainDnsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  try {
    const pending = await listPendingDomainDns(serverId);
    // Flatten { domain, state } → { domain, ...state } so the shape matches
    // the dashboard's `AdditionalDomainDnsState` type.
    return c.json({
      pending: pending.map(({ domain, state }) => ({ domain, ...state })),
    });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function domainDependentsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.param("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);
  try {
    validateDomain(domain);
    const deps = await countDomainDependents(serverId, domain);
    return c.json(deps);
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Mailboxes ───────────────────────────────────────────────────────────────

export async function listMailboxesHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "domain query param required" }, 400);
  try {
    const rows = await listMailboxes(serverId, domain);
    return c.json({ mailboxes: rows });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function getMailboxHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const email = c.req.param("email");
  if (!email) return c.json({ error: "email required" }, 400);
  try {
    const row = await getMailbox(serverId, email);
    if (!row) return c.json({ error: "Mailbox not found" }, 404);
    return c.json({ mailbox: row });
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function createMailboxHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await createMailbox(serverId, {
      localPart: String(body.localPart ?? ""),
      domain: String(body.domain ?? ""),
      password: String(body.password ?? ""),
      name: body.name ? String(body.name) : undefined,
      quotaMB: body.quotaMB != null ? Number(body.quotaMB) : undefined,
    });
    return c.json({ mailbox: row }, 201);
  } catch (err) {
    if (err instanceof MailboxExistsError) {
      return c.json({ error: err.message }, 409);
    }
    return errorJson(c, err);
  }
}

export async function updateMailboxHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const email = c.req.param("email");
  if (!email) return c.json({ error: "email required" }, 400);
  const body = await c.req.json().catch(() => ({}));
  try {
    const row = await updateMailbox(serverId, email, {
      name: body.name != null ? String(body.name) : undefined,
      password: body.password ? String(body.password) : undefined,
      quotaMB: body.quotaMB != null ? Number(body.quotaMB) : undefined,
      active: body.active != null ? Boolean(body.active) : undefined,
    });
    return c.json({ mailbox: row });
  } catch (err) {
    if (err instanceof MailboxNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

export async function deleteMailboxHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const email = c.req.param("email");
  if (!email) return c.json({ error: "email required" }, 400);
  const hard = c.req.query("hard") === "true";

  try {
    if (hard) {
      await hardDeleteMailbox(serverId, email);
    } else {
      await softDeleteMailbox(serverId, email, getActingAdmin(c));
    }
    return c.json({ ok: true, mode: hard ? "hard" : "soft" });
  } catch (err) {
    if (err instanceof MailboxNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return errorJson(c, err);
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getStatsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  try {
    const stats = await getMailServerStats(serverId);
    return c.json(stats);
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Test email ──────────────────────────────────────────────────────────────

export async function sendTestEmailHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "write" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await sendTestEmail(serverId, {
      to: String(body.to ?? ""),
      fromDomain:
        typeof body.fromDomain === "string" && body.fromDomain.trim()
          ? body.fromDomain
          : undefined,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof TestEmailError) {
      return c.json({ error: err.message }, 400);
    }
    return errorJson(c, err);
  }
}

// ─── DNS health scan ─────────────────────────────────────────────────────────

export async function getDnsScanHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  try {
    const result = await scanDns(serverId);
    return c.json(result);
  } catch (err) {
    return errorJson(c, err);
  }
}

// ─── Component actions (Health tab) ──────────────────────────────────────────

export async function runComponentActionHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const key = c.req.param("key");
  if (!key) return c.json({ error: "key is required" }, 400);
  const action = c.req.param("action") as ComponentAction | undefined;
  if (!action) return c.json({ error: "action is required" }, 400);
  try {
    const result = await runComponentAction(serverId, key, action);
    return c.json(result);
  } catch (err) {
    if (err instanceof UnknownComponentError) {
      return c.json({ error: err.message }, 400);
    }
    return errorJson(c, err);
  }
}

export async function restartAllComponentsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "admin" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  try {
    const result = await restartAllComponents(serverId);
    return c.json(result);
  } catch (err) {
    return errorJson(c, err);
  }
}

export async function getComponentLogsHandler(c: Context) {
  const guard = localOnlyGuard(c);
  if (guard) return guard;
  const serverId = requireServerId(c);
  await permission.assert(c, { resourceType: "mail_server", resourceId: serverId, action: "read" });
  const orgGuard = await assertServerInOrg(c, serverId);
  if (orgGuard) return orgGuard;
  const key = c.req.param("key");
  if (!key) return c.json({ error: "key is required" }, 400);
  const linesParam = c.req.query("lines");
  const requested = linesParam ? Number(linesParam) : undefined;
  try {
    const result = await getComponentLogs(serverId, key, requested);
    return c.json(result);
  } catch (err) {
    if (err instanceof UnknownComponentError) {
      return c.json({ error: err.message }, 400);
    }
    return errorJson(c, err);
  }
}

// ─── Error mapping ───────────────────────────────────────────────────────────

function errorJson(c: Context, err: unknown) {
  const message = safeErrorMessage(err);
  // The SSH+psql layer throws plain Error for any non-shape error
  // (connection failure, SQL syntax, validation). 500 is the right default;
  // typed errors above are caught and mapped to 4xx individually.
  return c.json({ error: message }, 500);
}
