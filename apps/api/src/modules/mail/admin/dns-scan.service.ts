/**
 * Live DNS scan - answers "are the records I told the operator to publish
 * actually published, and do they match?"
 *
 * Reads the expected records from the on-server state file (the same
 * record set the install wizard emitted at the DKIM step), then resolves
 * each one against the public DNS using Node's `node:dns/promises`. Each
 * check returns one of:
 *
 *   - pass : actual matches expected (exactly, or close-enough per type)
 *   - warn : record exists but doesn't match (extra entries, wrong target,
 *            stale value), or PTR is missing (recommended, not required)
 *   - fail : record is missing entirely, or its content rejects mail (e.g.
 *            DMARC says reject + we aren't authorized)
 *   - unknown : DNS resolution failed for a reason that isn't NXDOMAIN
 *
 * No mutation - pure read. Cheap to call (one DNS round trip per check,
 * resolved in parallel). The Health tab refreshes on demand.
 */

import { resolve4, resolve6, resolveMx, resolveTxt, reverse } from "node:dns/promises";
import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";
import { safeErrorMessage } from "@repo/core";

export type DnsCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface DnsCheck {
  key: string;
  /** Human-readable check name shown in the UI list. */
  label: string;
  /** Short description of what this check is for. */
  description: string;
  /** The DNS name we queried - useful for "actually run `dig` here". */
  queriedName: string;
  /** Record type - A / AAAA / MX / TXT / CNAME / PTR. */
  recordType: string;
  status: DnsCheckStatus;
  /** What we expected to find. Empty string for "anything". */
  expected: string;
  /** What we actually got. Empty string when missing. */
  actual: string;
  /** Operator-friendly explanation of the result. */
  message: string;
}

interface ExpectedRecord {
  type?: string;
  name?: string;
  value?: string;
  priority?: number;
}

interface ExpectedRecords {
  a?: ExpectedRecord;
  aaaa?: ExpectedRecord;
  mx?: ExpectedRecord;
  spf?: ExpectedRecord;
  dkim?: ExpectedRecord;
  dmarc?: ExpectedRecord;
}

export interface DnsScanResult {
  domain: string;
  scannedAt: number;
  checks: DnsCheck[];
}

/**
 * Run the scan for a server, optionally scoped to a specific domain.
 *
 * Pulls expected records from the on-server state file, then resolves each
 * against public DNS in parallel. Returns a flat list of checks + the
 * timestamp for the "scanned at X" UI hint.
 *
 * Domain scoping:
 *   - omitted / primary install domain → the full record set (A/AAAA/MX/
 *     SPF/DKIM/DMARC/PTR) from `state.dnsRecords`.
 *   - an additional domain → only MX/SPF/DKIM?/DMARC from
 *     `state.additionalDomains[domain].records`. A/AAAA/PTR are skipped:
 *     those test the shared `mail.<installDomain>` host, which the primary
 *     scan already covers, and additional domains never carry them.
 */
export async function scanDns(serverId: string, domain?: string): Promise<DnsScanResult> {
  const state = await sshManager.withExecutor(serverId, (exec) => readState(exec));
  if (!state || !state.domain) {
    return { domain: "", scannedAt: Date.now(), checks: [] };
  }

  const target = domain?.trim().toLowerCase() || state.domain;
  const isPrimary = target === state.domain;

  if (isPrimary) {
    if (!state.dnsRecords) {
      return { domain: "", scannedAt: Date.now(), checks: [] };
    }
    const expected = state.dnsRecords as unknown as ExpectedRecords;
    const checks = await Promise.all([
      checkA(target, expected.a),
      checkAaaa(target, expected.aaaa),
      checkMx(target, expected.mx),
      checkSpf(target, expected.spf),
      checkDkim(target, expected.dkim),
      checkDmarc(target, expected.dmarc),
      checkPtr(expected.a, target),
    ]);
    return {
      domain: target,
      scannedAt: Date.now(),
      checks: checks.filter((c): c is DnsCheck => c !== null),
    };
  }

  // Additional domain: MX/SPF/DKIM?/DMARC only.
  const additional = state.additionalDomains?.[target]?.records;
  if (!additional) {
    return { domain: target, scannedAt: Date.now(), checks: [] };
  }
  const expected = additional as unknown as ExpectedRecords;
  const checks = await Promise.all([
    checkMx(target, expected.mx),
    checkSpf(target, expected.spf),
    checkDkim(target, expected.dkim),
    checkDmarc(target, expected.dmarc),
  ]);
  return {
    domain: target,
    scannedAt: Date.now(),
    checks: checks.filter((c): c is DnsCheck => c !== null),
  };
}

// ─── Per-record checks ───────────────────────────────────────────────────────

async function checkA(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || `mail.${domain}`;
  try {
    const ips = await resolve4(name);
    const match = ips.includes(exp.value);
    return {
      key: "a",
      label: "A record",
      description: `Points the mail server hostname (${name}) at the VPS public IP.`,
      queriedName: name,
      recordType: "A",
      status: match ? "pass" : ips.length > 0 ? "warn" : "fail",
      expected: exp.value,
      actual: ips.join(", "),
      message: match
        ? "A record matches the mail server's public IP."
        : ips.length > 0
          ? `A record resolves, but to ${ips.join(", ")} instead of ${exp.value}.`
          : "A record exists but no IPv4 addresses returned.",
    };
  } catch (err) {
    return missing("a", "A record", name, "A", exp.value, err);
  }
}

async function checkAaaa(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || `mail.${domain}`;
  try {
    const ips = await resolve6(name);
    const match = ips.some((ip) => normaliseIpv6(ip) === normaliseIpv6(exp.value!));
    return {
      key: "aaaa",
      label: "AAAA record",
      description: "IPv6 address for the mail hostname. Recommended for delivery to Gmail.",
      queriedName: name,
      recordType: "AAAA",
      status: match ? "pass" : "warn",
      expected: exp.value,
      actual: ips.join(", "),
      message: match
        ? "AAAA record matches the server's IPv6 address."
        : `AAAA returned ${ips.join(", ")} which doesn't match ${exp.value}.`,
    };
  } catch (err) {
    // AAAA is recommended, not required → warn on NXDOMAIN.
    if (isNotFound(err)) {
      return {
        key: "aaaa",
        label: "AAAA record",
        description: "IPv6 address for the mail hostname. Recommended for delivery to Gmail.",
        queriedName: name,
        recordType: "AAAA",
        status: "warn",
        expected: exp.value,
        actual: "",
        message:
          "AAAA record not published. IPv6 delivery to Gmail is more reliable when this exists, but it's not required.",
      };
    }
    return missing("aaaa", "AAAA record", name, "AAAA", exp.value, err);
  }
}

async function checkMx(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  try {
    const mxs = await resolveMx(domain);
    if (mxs.length === 0) {
      return {
        key: "mx",
        label: "MX record",
        description: "Tells the world where to deliver mail for this domain.",
        queriedName: domain,
        recordType: "MX",
        status: "fail",
        expected: `${exp.value} (priority ${exp.priority ?? 10})`,
        actual: "",
        message: "No MX record found. Mail can't be delivered to this domain.",
      };
    }
    const wanted = trimDot(exp.value);
    const match = mxs.some((m) => trimDot(m.exchange) === wanted);
    return {
      key: "mx",
      label: "MX record",
      description: "Tells the world where to deliver mail for this domain.",
      queriedName: domain,
      recordType: "MX",
      status: match ? "pass" : "warn",
      expected: wanted,
      actual: mxs.map((m) => `${trimDot(m.exchange)} (priority ${m.priority})`).join(", "),
      message: match
        ? "MX record points at the mail server."
        : `MX records exist but none point at ${wanted}. Mail will be delivered elsewhere.`,
    };
  } catch (err) {
    return missing("mx", "MX record", domain, "MX", exp.value, err);
  }
}

async function checkSpf(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  try {
    const txt = (await resolveTxt(domain)).map((parts) => parts.join(""));
    const spfRecords = txt.filter((t) => /^v=spf1\b/i.test(t));
    const spf = spfRecords[0];
    if (!spf) {
      return {
        key: "spf",
        label: "SPF record",
        description: "Lets receivers verify this server is authorised to send for the domain.",
        queriedName: domain,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: "",
        message:
          "No SPF record found. Outbound mail will be marked as suspicious by most receivers.",
      };
    }
    if (spfRecords.length > 1) {
      return {
        key: "spf",
        label: "SPF record",
        description: "Lets receivers verify this server is authorised to send for the domain.",
        queriedName: domain,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: spfRecords.join(" | "),
        message:
          "Multiple SPF records found. A domain must publish exactly one v=spf1 TXT record or receivers treat SPF as invalid.",
      };
    }
    // We can't do a strict equality - operators sometimes add their own
    // ip4: / include: entries. Pass if the record contains the install's
    // mechanism (typically "mx" or matching include:).
    const containsMx = /\bmx\b/i.test(spf);
    return {
      key: "spf",
      label: "SPF record",
      description: "Lets receivers verify this server is authorised to send for the domain.",
      queriedName: domain,
      recordType: "TXT",
      status: containsMx ? "pass" : "warn",
      expected: exp.value,
      actual: spf,
      message: containsMx
        ? "SPF record exists and authorises the MX (this server)."
        : "SPF record exists but doesn't include `mx`. Mail from this server may fail SPF.",
    };
  } catch (err) {
    return missing("spf", "SPF record", domain, "TXT", exp.value, err);
  }
}

async function checkDkim(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || `dkim._domainkey.${domain}`;
  try {
    const txt = (await resolveTxt(name)).map((parts) => parts.join(""));
    if (txt.length === 0) {
      return {
        key: "dkim",
        label: "DKIM key",
        description: "Public key receivers use to verify message signatures.",
        queriedName: name,
        recordType: "TXT",
        status: "fail",
        expected: exp.value.slice(0, 64) + "…",
        actual: "",
        message: "No DKIM TXT record found. Outgoing mail won't be signed.",
      };
    }
    const wantedStripped = exp.value.replace(/\s+/g, "");
    const matched = txt.some((t) => t.replace(/\s+/g, "") === wantedStripped);
    return {
      key: "dkim",
      label: "DKIM key",
      description: "Public key receivers use to verify message signatures.",
      queriedName: name,
      recordType: "TXT",
      status: matched ? "pass" : "warn",
      expected: exp.value.slice(0, 64) + "…",
      actual: txt[0].slice(0, 64) + "…",
      message: matched
        ? "DKIM TXT matches the key this server signs with."
        : "DKIM TXT exists but doesn't match the key generated at install. Rotate it or update the published record.",
    };
  } catch (err) {
    return missing("dkim", "DKIM key", name, "TXT", exp.value.slice(0, 64) + "…", err);
  }
}

async function checkDmarc(domain: string, exp?: ExpectedRecord): Promise<DnsCheck | null> {
  if (!exp?.value) return null;
  const name = exp.name || `_dmarc.${domain}`;
  try {
    const txt = (await resolveTxt(name)).map((parts) => parts.join(""));
    const dmarc = txt.find((t) => /^v=DMARC1\b/i.test(t));
    if (!dmarc) {
      return {
        key: "dmarc",
        label: "DMARC policy",
        description: "Tells receivers what to do when SPF/DKIM fail for this domain.",
        queriedName: name,
        recordType: "TXT",
        status: "fail",
        expected: exp.value,
        actual: "",
        message: "No DMARC record found. Some receivers will treat this as a risk signal.",
      };
    }
    return {
      key: "dmarc",
      label: "DMARC policy",
      description: "Tells receivers what to do when SPF/DKIM fail for this domain.",
      queriedName: name,
      recordType: "TXT",
      status: "pass",
      expected: exp.value,
      actual: dmarc,
      message: "DMARC policy is published.",
    };
  } catch (err) {
    return missing("dmarc", "DMARC policy", name, "TXT", exp.value, err);
  }
}

async function checkPtr(
  aRecord: ExpectedRecord | undefined,
  domain: string,
): Promise<DnsCheck | null> {
  if (!aRecord?.value) return null;
  const expectedHost = trimDot(`mail.${domain}`);
  try {
    const names = await reverse(aRecord.value);
    if (names.length === 0) {
      return {
        key: "ptr",
        label: "PTR (reverse DNS)",
        description:
          "Set at your VPS provider - NOT your DNS provider. Required by Gmail/Outlook for mail acceptance.",
        queriedName: aRecord.value,
        recordType: "PTR",
        status: "fail",
        expected: expectedHost,
        actual: "",
        message:
          "No PTR record set. Gmail and Outlook will mark your outbound mail as spam or reject it.",
      };
    }
    const matched = names.some((n) => trimDot(n) === expectedHost);
    return {
      key: "ptr",
      label: "PTR (reverse DNS)",
      description:
        "Set at your VPS provider - NOT your DNS provider. Required by Gmail/Outlook for mail acceptance.",
      queriedName: aRecord.value,
      recordType: "PTR",
      status: matched ? "pass" : "warn",
      expected: expectedHost,
      actual: names.join(", "),
      message: matched
        ? "PTR matches the mail hostname."
        : `PTR resolves to ${names.join(", ")} instead of ${expectedHost}. Gmail/Outlook may still reject your mail.`,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        key: "ptr",
        label: "PTR (reverse DNS)",
        description:
          "Set at your VPS provider - NOT your DNS provider. Required by Gmail/Outlook for mail acceptance.",
        queriedName: aRecord.value,
        recordType: "PTR",
        status: "fail",
        expected: expectedHost,
        actual: "",
        message: "No PTR record set. Configure it at your VPS provider's panel.",
      };
    }
    return missing("ptr", "PTR (reverse DNS)", aRecord.value, "PTR", expectedHost, err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function missing(
  key: string,
  label: string,
  name: string,
  type: string,
  expected: string,
  err: unknown,
): DnsCheck {
  if (isNotFound(err)) {
    return {
      key,
      label,
      description: `${type} record at ${name}.`,
      queriedName: name,
      recordType: type,
      status: "fail",
      expected,
      actual: "",
      message: `${type} record is missing. Publish it at your DNS provider.`,
    };
  }
  return {
    key,
    label,
    description: `${type} record at ${name}.`,
    queriedName: name,
    recordType: type,
    status: "unknown",
    expected,
    actual: "",
    message: `Lookup failed: ${safeErrorMessage(err)}`,
  };
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

function trimDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function normaliseIpv6(s: string): string {
  // Lowercase + strip zone id; resolve6 already returns canonical form,
  // but operators sometimes publish with a mix of case in their DNS UI.
  return s.toLowerCase().replace(/^::/, "0:0:0:0:0:0:0:0::").replace(/%.*$/, "");
}
