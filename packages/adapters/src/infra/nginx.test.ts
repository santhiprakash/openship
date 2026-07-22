import { describe, expect, test } from "vitest";
import { NginxProvider } from "./nginx";
import { OPENRESTY_DEFAULT_PATHS, luaSourceAvailable, RULES_GUARD_PATH } from "./openresty-lua";
import type { CommandExecutor, RouteConfig } from "../types";

// L1 — config GENERATION. Proves NginxProvider emits the right nginx directives
// for each branch, that the injection guard holds, and that a failed
// `openresty -t` rolls the vhost back. It does NOT prove real nginx accepts the
// output — that's the L3 docker suite. (See the routing-rules test audit.)

const SITES = "/tmp/openship-nginx-test/sites-enabled";
const PATHS = { ...OPENRESTY_DEFAULT_PATHS, sitesDir: SITES };

interface FakeOpts {
  /** Simulate `openresty -t` failing inside the reload script. */
  failReload?: boolean;
  /** Domains whose Let's Encrypt fullchain exists (drives the TLS branch). */
  certDomains?: string[];
}

/** Stateful fake executor: in-memory file map + atomic-rename (`mv`) handling.
 *  Detection commands throw so reload() keeps the cached sitesDir. */
function makeExecutor(files: Map<string, string>, opts: FakeOpts, calls: string[]): CommandExecutor {
  const exec = async (command: string): Promise<string> => {
    calls.push(command);
    // openresty path detection (reload re-detects) → fail so cached paths stick.
    if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
    const mv = command.match(/^mv '([^']+)' '([^']+)'$/);
    if (mv) {
      const c = files.get(mv[1]);
      if (c !== undefined) { files.set(mv[2], c); files.delete(mv[1]); }
      return "";
    }
    // The reload script contains `-t ... -s reload`; a `-t` failure exits non-zero.
    if (command.includes("-s reload")) {
      if (opts.failReload) throw new Error("nginx: [emerg] configuration test failed");
      return "";
    }
    return "";
  };
  return {
    exec,
    writeFile: async (p: string, c: string) => { files.set(p, c); },
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) =>
      files.has(p) || (opts.certDomains ?? []).some((d) => p.startsWith(`/etc/letsencrypt/live/${d}/`)),
    mkdir: async () => {},
    rm: async (p: string) => { files.delete(p); },
  } as unknown as CommandExecutor;
}

function setup(opts: FakeOpts = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const nginx = new NginxProvider({ paths: PATHS, executor: makeExecutor(files, opts, calls) });
  return { nginx, files, calls, conf: (slug: string) => files.get(`${SITES}/${slug}.conf`) };
}

const PROXY: RouteConfig = { domain: "app.example.com", tls: true, targetUrl: "http://127.0.0.1:3009" };

describe("NginxProvider config generation", () => {
  test("proxy route with no cert yet → HTTP-only block", async () => {
    const { nginx, conf, files } = setup();
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(c).toBeDefined();
    expect(c).toContain("server_name app.example.com;");
    expect(c).toContain("listen 80;");
    expect(c).not.toContain("listen 443 ssl;"); // no cert → no TLS server
    expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
    expect(c).toContain("location /.well-known/acme-challenge/");
    // Lua rules-guard hook is emitted only when the Lua source ships (fail-safe).
    if (luaSourceAvailable()) {
      expect(c).toContain(`access_by_lua_file ${RULES_GUARD_PATH};`);
    } else {
      expect(c).not.toContain("access_by_lua_file");
    }
    // Sidecar persisted so cert re-registration reproduces the exact route.
    const sidecar = files.get(`${SITES}/app-example-com.route.json`);
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar!)).toMatchObject({ domain: "app.example.com", targetUrl: "http://127.0.0.1:3009" });
  });

  test("proxy route WITH cert → 80→443 redirect + ssl server", async () => {
    const { nginx, conf } = setup({ certDomains: ["app.example.com"] });
    await nginx.registerRoute(PROXY);
    const c = conf("app-example-com")!;
    expect(c).toContain("return 301 https://$server_name$request_uri;");
    expect(c).toContain("listen 443 ssl;");
    expect(c).toContain("ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;");
    expect(c).toContain("ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;");
    expect(c).toContain("proxy_pass http://127.0.0.1:3009;");
  });

  test("static route → root + try_files, no proxy_pass", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ domain: "site.example.com", tls: false, staticRoot: "/var/www/site" });
    const c = conf("site-example-com")!;
    expect(c).toContain("root /var/www/site;");
    expect(c).toContain("try_files $uri $uri/ /index.html;");
    expect(c).not.toContain("proxy_pass");
  });

  test("webhook proxy adds the /_openship/hooks/ location", async () => {
    const { nginx, conf } = setup();
    await nginx.registerRoute({ ...PROXY, webhookProxy: "http://127.0.0.1:4000/api/webhooks/" });
    expect(conf("app-example-com")!).toContain("location /_openship/hooks/");
  });

  test("rejects a domain with shell metacharacters (injection guard)", async () => {
    const { nginx } = setup();
    await expect(
      nginx.registerRoute({ domain: "bad;rm -rf /", tls: false, targetUrl: "http://x" }),
    ).rejects.toThrow(/Invalid domain/);
  });

  test("reload validates (-t) BEFORE -s reload", async () => {
    const { nginx, calls } = setup();
    await nginx.registerRoute(PROXY);
    const reloadCmd = calls.find((c) => c.includes("-s reload"));
    expect(reloadCmd).toBeDefined();
    expect(reloadCmd!.indexOf(" -t")).toBeGreaterThanOrEqual(0);
    expect(reloadCmd!.indexOf(" -t")).toBeLessThan(reloadCmd!.indexOf("-s reload"));
  });

  test("a failed `openresty -t` rolls the vhost back to the prior config", async () => {
    const { nginx, files, conf } = setup({ failReload: true });
    // Seed a known-good prior conf for this slug.
    files.set(`${SITES}/app-example-com.conf`, "# PRIOR GOOD CONFIG");
    await expect(nginx.registerRoute(PROXY)).rejects.toThrow();
    // Rolled back — the bad block did not persist.
    expect(conf("app-example-com")).toBe("# PRIOR GOOD CONFIG");
  });
});
