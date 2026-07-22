/**
 * Parse a Caddyfile into normalized ImportedSites.
 *
 * Text-based (no `caddy adapt` dependency): scans site blocks by their address
 * header and reads `reverse_proxy` / `root * … file_server` / `tls`. Caddy
 * auto-provisions HTTPS for named hosts, so we treat named sites as TLS unless
 * the address is explicitly `http://` or `:80`.
 */

import type { CommandExecutor } from "../../types";
import type { ImportedSite, ProxyScanResult } from "../types";
import { stripComments, tryExec } from "./parse-utils";

const CADDYFILE_PATHS = ["/etc/caddy/Caddyfile", "/etc/Caddyfile"];

async function loadCaddyfile(executor: CommandExecutor): Promise<string> {
  for (const p of CADDYFILE_PATHS) {
    const out = await tryExec(executor, `cat ${p} 2>/dev/null`);
    if (out && out.trim()) return out;
  }
  return "";
}

/** Split a Caddyfile into { header, body } blocks with balanced braces. */
function caddyBlocks(text: string): Array<{ header: string; body: string }> {
  const out: Array<{ header: string; body: string }> = [];
  let i = 0;
  let headerStart = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const header = text.slice(headerStart, i).trim();
      let depth = 1;
      let j = i + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      if (depth !== 0) break; // unbalanced
      out.push({ header, body: text.slice(i + 1, j - 1) });
      i = j;
      headerStart = j;
    } else {
      i++;
    }
  }
  return out;
}

/** example.com, https://www.example.com:443 → { host, ssl } entries. */
function parseAddresses(header: string): Array<{ host: string; ssl: boolean }> {
  return header
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((addr) => {
      const httpScheme = /^http:\/\//i.test(addr);
      const host = addr.replace(/^https?:\/\//i, "").replace(/:\d+$/, "");
      const isPort80 = /:80$/.test(addr);
      return { host, ssl: !httpScheme && !isPort80 };
    })
    .filter((a) => a.host && !a.host.startsWith(":") && a.host !== "*");
}

export async function scanCaddy(executor: CommandExecutor): Promise<ProxyScanResult> {
  const raw = await loadCaddyfile(executor);
  const warnings: string[] = [];
  const sites: ImportedSite[] = [];

  if (!raw.trim()) {
    return { proxy: "caddy", sites, warnings: ["caddy: no readable Caddyfile found"] };
  }

  const text = stripComments(raw);
  let blocks = caddyBlocks(text);

  // Brace-less single-site shorthand ("example.com\n reverse_proxy …") has no
  // `{ }` — synthesize one block from the first non-empty line (address) + rest,
  // so the common single-site Caddyfile is migrated instead of silently dropped.
  if (blocks.length === 0) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      blocks = [{ header: lines[0], body: lines.slice(1).join("\n") }];
    } else {
      warnings.push("caddy: config present but no parseable site blocks");
    }
  }

  for (const { header, body } of blocks) {
    if (!header) continue; // global options block

    const addrs = parseAddresses(header);
    if (addrs.length === 0) {
      warnings.push(`caddy: skipped a block with no usable address (${header.slice(0, 40)})`);
      continue;
    }

    const proxyMatch = body.match(/(?:^|\s)reverse_proxy\s+([^\n{]+)/);
    const rootMatch = body.match(/(?:^|\s)root\s+\*?\s*([^\n\s]+)/);
    const tlsMatch = body.match(/(?:^|\s)tls\s+(\S+)\s+(\S+)/); // tls <cert> <key>

    let target: ImportedSite["target"];
    if (proxyMatch) {
      const upstream = proxyMatch[1].trim().split(/\s+/)[0];
      target = { kind: "proxy", url: /^https?:\/\//.test(upstream) ? upstream : `http://${upstream}` };
    } else if (rootMatch) {
      target = { kind: "static", root: rootMatch[1] };
    } else {
      warnings.push(`caddy: ${addrs[0].host} has no reverse_proxy or root — skipped`);
      continue;
    }

    const site: ImportedSite = {
      serverNames: addrs.map((a) => a.host),
      ssl: addrs.some((a) => a.ssl),
      target,
      source: "caddy",
    };
    if (tlsMatch && tlsMatch[1].includes("/")) {
      site.tls = { certPath: tlsMatch[1], keyPath: tlsMatch[2] };
    }
    sites.push(site);
  }

  return { proxy: "caddy", sites, warnings };
}
