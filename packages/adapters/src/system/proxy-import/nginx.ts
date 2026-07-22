/**
 * Parse an existing nginx config into normalized ImportedSites.
 *
 * Prefers `nginx -T` (dumps the fully-resolved config with all includes),
 * falling back to catting sites-enabled + conf.d. Best-effort: anything we
 * can't interpret is returned as a warning, never silently dropped.
 */

import type { CommandExecutor } from "../../types";
import type { ImportedSite, ProxyScanResult } from "../types";
import { extractBlocks, stripComments, tryExec } from "./parse-utils";

async function loadNginxConfig(executor: CommandExecutor): Promise<string> {
  const dumped = await tryExec(executor, "nginx -T 2>/dev/null");
  if (dumped && /server\s*\{/.test(dumped)) return dumped;
  // Fallback: concatenate the usual include targets.
  const cat = await tryExec(
    executor,
    "cat /etc/nginx/nginx.conf /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null",
  );
  return cat ?? "";
}

function firstDirective(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${name}\\s+([^;]+);`));
  return m?.[1]?.trim();
}

/** Parse `upstream <name> { server <host:port>; ... }` → name → first host:port. */
function parseUpstreams(config: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:^|[\s;}])upstream\s+(\S+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(config)) !== null) {
    const name = m[1];
    const server = m[2].match(/(?:^|[\s;{])server\s+([^;\s]+)/);
    if (name && server?.[1]) map.set(name, server[1].trim());
  }
  return map;
}

/**
 * Turn a raw proxy_pass value into a concrete Openship route target, or reject
 * it (so the caller warns and skips) when it can't be resolved to a real
 * host:port — an unknown/undeclared upstream, an nginx variable, or a unix
 * socket would otherwise produce a vhost that fails `openresty -t`.
 */
function resolveProxyTarget(
  proxyPass: string,
  upstreams: Map<string, string>,
): { url: string } | { reason: string } {
  const raw = proxyPass.replace(/;$/, "").trim();
  if (raw.includes("$")) return { reason: `proxy_pass "${raw}" uses an nginx variable` };
  if (/\/\/unix:/i.test(raw)) return { reason: `proxy_pass "${raw}" targets a unix socket` };
  const m = raw.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
  if (!m) return { reason: `unrecognized proxy_pass "${raw}"` };
  const scheme = m[1];
  const authority = m[2];
  const host = authority.replace(/:\d+$/, "");
  if (upstreams.has(host)) return { url: `${scheme}${upstreams.get(host)}` };
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIp || host === "localhost" || host.includes(".")) return { url: raw };
  return { reason: `proxy_pass host "${host}" is an undeclared upstream — not migratable` };
}

function parseServer(
  body: string,
  source: string,
  upstreams: Map<string, string>,
): ImportedSite | { warning: string } {
  const names = firstDirective(body, "server_name")
    ?.split(/\s+/)
    .filter((n) => n && n !== "_" && !n.startsWith("~"))
    ?? [];

  // ssl if any `listen ... ssl` or `listen 443`
  const listens = [...body.matchAll(/(?:^|[;{\s])listen\s+([^;]+);/g)].map((m) => m[1]);
  const ssl = listens.some((l) => /\bssl\b/.test(l) || /\b443\b/.test(l));

  const proxyPass = firstDirective(body, "proxy_pass");
  const root = firstDirective(body, "root");
  const certPath = firstDirective(body, "ssl_certificate");
  const keyPath = firstDirective(body, "ssl_certificate_key");

  if (names.length === 0) {
    return { warning: `nginx: skipped a server block with no usable server_name (${source})` };
  }

  let target: ImportedSite["target"];
  if (proxyPass) {
    const resolved = resolveProxyTarget(proxyPass, upstreams);
    if ("reason" in resolved) {
      return { warning: `nginx: ${names[0]} — ${resolved.reason} (skipped)` };
    }
    target = { kind: "proxy", url: resolved.url };
  } else if (root) {
    target = { kind: "static", root: root.replace(/;$/, "") };
  } else {
    return { warning: `nginx: ${names[0]} has neither proxy_pass nor root — skipped (${source})` };
  }

  const site: ImportedSite = { serverNames: names, ssl, target, source };
  if (certPath && keyPath) site.tls = { certPath, keyPath };
  return site;
}

export async function scanNginx(executor: CommandExecutor): Promise<ProxyScanResult> {
  const raw = await loadNginxConfig(executor);
  const warnings: string[] = [];
  const sites: ImportedSite[] = [];

  if (!raw.trim()) {
    return { proxy: "nginx", sites, warnings: ["nginx: no readable configuration found"] };
  }

  // `nginx -T` prefixes each file with `# configuration file <path>:` — track it
  // for traceability; strip comments before brace-matching.
  const config = stripComments(raw);
  const upstreams = parseUpstreams(config);
  const blocks = extractBlocks(config, "server");
  if (blocks.length === 0) {
    warnings.push("nginx: no server blocks found");
  }

  for (const body of blocks) {
    const parsed = parseServer(body, "nginx", upstreams);
    if ("warning" in parsed) warnings.push(parsed.warning);
    else sites.push(parsed);
  }

  return { proxy: "nginx", sites, warnings };
}
