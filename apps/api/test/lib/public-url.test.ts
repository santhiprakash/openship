import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the API config so the resolver reads a controllable OPENSHIP_PUBLIC_URL
// without booting the real env module (and its INTERNAL_TOKEN guard). vi.hoisted
// lets the hoisted vi.mock factory reference these mutable objects.
const { mockEnv, mockRuntimeTarget } = vi.hoisted(() => ({
  mockEnv: { OPENSHIP_PUBLIC_URL: undefined as string | undefined },
  mockRuntimeTarget: { api: "http://localhost:4000", dashboard: "http://localhost:3001" },
}));
vi.mock("../../src/config/env", () => ({
  env: mockEnv,
  runtimeTarget: mockRuntimeTarget,
}));

import {
  resolveApiPublicUrl,
  resolveDashboardPublicUrl,
  sharedWebhookUrl,
  domainWebhookUrl,
  resolveAuthBaseUrl,
  requestPublicOrigin,
} from "../../src/lib/public-url";

afterEach(() => {
  mockEnv.OPENSHIP_PUBLIC_URL = undefined;
});

describe("public-url resolver — no OPENSHIP_PUBLIC_URL (cloud / dev)", () => {
  it("falls back to runtimeTarget (preserves today's behavior)", () => {
    expect(resolveApiPublicUrl()).toBe("http://localhost:4000");
    expect(resolveDashboardPublicUrl()).toBe("http://localhost:3001");
    expect(sharedWebhookUrl()).toBe("http://localhost:4000/api/webhooks/github");
  });
});

describe("public-url resolver — self-hosted --public-url", () => {
  it("API base is <public>/api/proxy (reachable via the dashboard same-origin proxy)", () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://ops.example.com";
    expect(resolveApiPublicUrl()).toBe("https://ops.example.com/api/proxy");
    expect(resolveDashboardPublicUrl()).toBe("https://ops.example.com");
  });

  it("shared webhook URL is the proxied, publicly-reachable callback (not localhost)", () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://ops.example.com";
    expect(sharedWebhookUrl()).toBe("https://ops.example.com/api/proxy/api/webhooks/github");
  });

  it("strips a trailing slash on the public URL", () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://ops.example.com/";
    expect(resolveApiPublicUrl()).toBe("https://ops.example.com/api/proxy");
  });
});

describe("resolveAuthBaseUrl (Better Auth baseURL)", () => {
  it("is the static runtime API URL when no public URL (cloud/dev — unchanged)", () => {
    expect(resolveAuthBaseUrl()).toBe("http://localhost:4000");
  });

  it("is a dynamic config allow-listing the public host, with a loopback fallback", () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://ops.example.com";
    expect(resolveAuthBaseUrl()).toEqual({
      allowedHosts: ["ops.example.com"],
      fallback: "http://localhost:4000",
    });
  });
});

describe("requestPublicOrigin (MCP WWW-Authenticate)", () => {
  it("uses the forwarded host/proto set by the same-origin proxy", () => {
    const req = new Request("http://127.0.0.1:4000/api/mcp", {
      method: "POST",
      headers: { "x-forwarded-host": "ops.example.com", "x-forwarded-proto": "https" },
    });
    expect(requestPublicOrigin(req)).toBe("https://ops.example.com");
  });

  it("falls back to the configured public URL when no forwarded headers", () => {
    mockEnv.OPENSHIP_PUBLIC_URL = "https://ops.example.com";
    const req = new Request("http://127.0.0.1:4000/api/mcp", { method: "POST" });
    expect(requestPublicOrigin(req)).toBe("https://ops.example.com");
  });

  it("falls back to the request origin when nothing else is available", () => {
    const req = new Request("http://127.0.0.1:4000/api/mcp", { method: "POST" });
    expect(requestPublicOrigin(req)).toBe("http://127.0.0.1:4000");
  });
});

describe("domainWebhookUrl (per-project domain strategy)", () => {
  it("builds the /_openship/hooks callback, https by default", () => {
    expect(domainWebhookUrl("hooks.example.com")).toBe(
      "https://hooks.example.com/_openship/hooks/github",
    );
  });
  it("honors an explicit http scheme (pre-TLS)", () => {
    expect(domainWebhookUrl("hooks.example.com", "http")).toBe(
      "http://hooks.example.com/_openship/hooks/github",
    );
  });
});
