import { describe, expect, it } from "vitest";

import {
  firstServicePort,
  internalServiceAddress,
  resolvePublicUrlPlaceholders,
} from "../src/service-routing";

describe("firstServicePort", () => {
  it("reads the container-side port from compose port specs", () => {
    expect(firstServicePort(["8080"])).toBe(8080);
    expect(firstServicePort(["3000:3000"])).toBe(3000);
    expect(firstServicePort(["127.0.0.1:5432:5432"])).toBe(5432);
    expect(firstServicePort(["6379/tcp"])).toBe(6379);
    expect(firstServicePort(["53:53/udp"])).toBe(53);
  });

  it("returns undefined for empty / unparseable input", () => {
    expect(firstServicePort(undefined)).toBeUndefined();
    expect(firstServicePort([])).toBeUndefined();
    expect(firstServicePort([""])).toBeUndefined();
    expect(firstServicePort(["not-a-port"])).toBeUndefined();
  });
});

describe("internalServiceAddress", () => {
  it("is service-name:port — the address a sibling uses (NOT the public subdomain)", () => {
    expect(internalServiceAddress("db", ["5432:5432"])).toBe("db:5432");
    expect(internalServiceAddress("redis", ["6379"])).toBe("redis:6379");
  });

  it("uses the raw service name (docker alias / cloud /etc/hosts entry), unnormalized", () => {
    // A name like "My_DB" is the literal hostname siblings resolve, not a slug.
    expect(internalServiceAddress("My_DB", ["5432"])).toBe("My_DB:5432");
  });

  it("falls back to the bare name when no port is known", () => {
    expect(internalServiceAddress("worker", [])).toBe("worker");
    expect(internalServiceAddress("worker", undefined)).toBe("worker");
  });
});

describe("resolvePublicUrlPlaceholders", () => {
  // A multi-port service (Convex: API 3210, HTTP actions 3211) resolves each
  // port to its own route; a token with no port hits the primary.
  const urlForService = (name: string, port?: number): string | undefined => {
    if (name !== "backend") return undefined;
    if (port === 3211) return "https://app-backend-http.opsh.io";
    if (port === 3210 || port === undefined) return "https://app-backend.opsh.io";
    return undefined;
  };

  it("resolves a port-specific token to that port's URL", () => {
    const out = resolvePublicUrlPlaceholders(
      {
        CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
        CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
      },
      urlForService,
    );
    expect(out.CONVEX_CLOUD_ORIGIN).toBe("https://app-backend.opsh.io");
    expect(out.CONVEX_SITE_ORIGIN).toBe("https://app-backend-http.opsh.io");
  });

  it("resolves a bare (no-port) token to the primary route (back-compat)", () => {
    const out = resolvePublicUrlPlaceholders(
      { NEXT_PUBLIC_DEPLOYMENT_URL: "{{publicUrl:backend}}" },
      urlForService,
    );
    expect(out.NEXT_PUBLIC_DEPLOYMENT_URL).toBe("https://app-backend.opsh.io");
  });

  it("blanks unknown services / ports rather than leaking the placeholder", () => {
    const out = resolvePublicUrlPlaceholders(
      { A: "{{publicUrl:missing}}", B: "{{publicUrl:backend:9999}}" },
      urlForService,
    );
    expect(out.A).toBe("");
    expect(out.B).toBe("");
  });
});
