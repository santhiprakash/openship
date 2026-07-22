import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../types";
import { scanNginx } from "./nginx";
import { scanCaddy } from "./caddy";
import { scanApache } from "./apache";

function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      for (const [needle, out] of rules) if (cmd.includes(needle)) return out;
      return "";
    },
  } as unknown as CommandExecutor;
}

describe("scanNginx", () => {
  test("parses proxy + static server blocks with TLS and wildcards", async () => {
    const conf = `
      server {
        listen 80;
        server_name example.com www.example.com;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
      server {
        listen 443 ssl;
        server_name static.example.com *.wild.example.com;
        root /var/www/static;
        ssl_certificate /etc/ssl/x.crt;
        ssl_certificate_key /etc/ssl/x.key;
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites).toHaveLength(2);

    const proxy = res.sites[0];
    expect(proxy.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:3000" });
    expect(proxy.serverNames).toEqual(["example.com", "www.example.com"]);
    expect(proxy.ssl).toBe(false);

    const stat = res.sites[1];
    expect(stat.target).toEqual({ kind: "static", root: "/var/www/static" });
    expect(stat.ssl).toBe(true);
    expect(stat.tls).toEqual({ certPath: "/etc/ssl/x.crt", keyPath: "/etc/ssl/x.key" });
    // wildcard server_name is kept as a name but filtered at registration time
    expect(stat.serverNames).toContain("static.example.com");
  });

  test("warns when no config is readable", async () => {
    const res = await scanNginx(makeExecutor([]));
    expect(res.sites).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  test("resolves proxy_pass to a declared upstream, rejects an undeclared one", async () => {
    const conf = `
      upstream api { server 127.0.0.1:9000; server 127.0.0.1:9001; }
      server { server_name good.example.com; location / { proxy_pass http://api; } }
      server { server_name bad.example.com; location / { proxy_pass http://ghost; } }
      server { server_name var.example.com; location / { proxy_pass http://$backend; } }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    const good = res.sites.find((s) => s.serverNames.includes("good.example.com"));
    expect(good?.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:9000" });
    // undeclared upstream + nginx variable are NOT migrated (would break openresty -t)
    expect(res.sites.some((s) => s.serverNames.includes("bad.example.com"))).toBe(false);
    expect(res.sites.some((s) => s.serverNames.includes("var.example.com"))).toBe(false);
    expect(res.warnings.some((w) => w.includes("ghost"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("variable"))).toBe(true);
  });
});

describe("scanCaddy", () => {
  test("parses reverse_proxy and root site blocks", async () => {
    const caddyfile = `
      example.com {
        reverse_proxy localhost:8080
      }
      static.example.com {
        root * /srv/www
        file_server
      }
      http://plain.example.com {
        reverse_proxy 127.0.0.1:9000
      }
    `;
    const res = await scanCaddy(makeExecutor([["/etc/caddy/Caddyfile", caddyfile]]));
    expect(res.sites).toHaveLength(3);
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://localhost:8080" });
    expect(res.sites[0].ssl).toBe(true);
    expect(res.sites[1].target).toEqual({ kind: "static", root: "/srv/www" });
    // http:// address → not TLS
    expect(res.sites[2].ssl).toBe(false);
  });

  test("parses a brace-less single-site Caddyfile (shorthand)", async () => {
    const caddyfile = "example.com\nreverse_proxy localhost:8080\n";
    const res = await scanCaddy(makeExecutor([["/etc/caddy/Caddyfile", caddyfile]]));
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].serverNames).toEqual(["example.com"]);
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://localhost:8080" });
  });
});

describe("scanApache", () => {
  test("parses a VirtualHost with ProxyPass, aliases and SSL", async () => {
    const conf = `
      <VirtualHost *:443>
        ServerName app.example.com
        ServerAlias www.app.example.com
        ProxyPass / http://127.0.0.1:9000/
        SSLCertificateFile /etc/ssl/app.crt
        SSLCertificateKeyFile /etc/ssl/app.key
      </VirtualHost>
    `;
    const res = await scanApache(makeExecutor([["sites-enabled", conf]]));
    expect(res.sites).toHaveLength(1);
    const site = res.sites[0];
    expect(site.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:9000/" });
    expect(site.serverNames).toEqual(["app.example.com", "www.app.example.com"]);
    expect(site.ssl).toBe(true);
    expect(site.tls).toEqual({ certPath: "/etc/ssl/app.crt", keyPath: "/etc/ssl/app.key" });
  });

  test("collects aliases across multiple ServerAlias lines", async () => {
    const conf = `
      <VirtualHost *:80>
        ServerName example.com
        ServerAlias www.example.com
        ServerAlias example.net
        ServerAlias www.example.net
        ProxyPass / http://127.0.0.1:8080/
      </VirtualHost>
    `;
    const res = await scanApache(makeExecutor([["sites-enabled", conf]]));
    expect(res.sites[0].serverNames).toEqual([
      "example.com",
      "www.example.com",
      "example.net",
      "www.example.net",
    ]);
  });
});
