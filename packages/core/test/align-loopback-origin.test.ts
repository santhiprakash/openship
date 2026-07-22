import { describe, it, expect } from "vitest";
import { alignLoopbackOrigin } from "../src/runtime-config";

describe("alignLoopbackOrigin", () => {
  it("aligns the loopback host to the reference (both loopback)", () => {
    expect(alignLoopbackOrigin("http://localhost:3001", "http://127.0.0.1:4000")).toBe(
      "http://127.0.0.1:3001",
    );
    expect(alignLoopbackOrigin("http://127.0.0.1:3001", "http://localhost:4000")).toBe(
      "http://localhost:3001",
    );
  });

  it("keeps the INJECTED port + protocol — reference port/proto are ignored", () => {
    // The output origin comes from the trusted configured dashboard URL; only
    // the loopback hostname is borrowed from the request.
    expect(alignLoopbackOrigin("http://localhost:3001", "https://127.0.0.1:9999")).toBe(
      "http://127.0.0.1:3001",
    );
  });

  it("no-op when the loopback host already matches", () => {
    expect(alignLoopbackOrigin("http://localhost:3001", "http://localhost:4000")).toBe(
      "http://localhost:3001",
    );
  });

  // ── Security: a client-controlled Host header must never redirect off-box ──
  it("SECURITY: a spoofed non-loopback Host cannot move the redirect off the box", () => {
    expect(alignLoopbackOrigin("http://127.0.0.1:3001", "http://evil.com")).toBe(
      "http://127.0.0.1:3001",
    );
    expect(alignLoopbackOrigin("http://localhost:3001", "https://attacker.example:443")).toBe(
      "http://localhost:3001",
    );
  });

  it("SECURITY: a production (non-loopback) dashboard origin is never rewritten", () => {
    expect(alignLoopbackOrigin("https://app.openship.io", "http://127.0.0.1:4000")).toBe(
      "https://app.openship.io",
    );
    expect(alignLoopbackOrigin("https://app.openship.io", "http://localhost:4000")).toBe(
      "https://app.openship.io",
    );
  });

  it("passes malformed origins through untouched (never throws)", () => {
    expect(alignLoopbackOrigin("not a url", "http://localhost:3001")).toBe("not a url");
    expect(alignLoopbackOrigin("http://localhost:3001", "garbage")).toBe("http://localhost:3001");
  });
});
