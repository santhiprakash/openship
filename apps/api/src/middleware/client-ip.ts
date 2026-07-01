import type { Context, Next } from "hono";
import { env } from "../config/env";
import { isLoopbackPeer, peerAddress } from "./loopback-peer";

declare module "hono" {
  interface ContextVariableMap {
    clientIp: string | null;
  }
}

/**
 * Resolve the request's client IP and stamp it on the Hono context.
 *
 * Trust rules (MEDIUM cleanup):
 *   - Loopback peers ALWAYS get header trust (local dev / docker-host
 *     networking, where the API listens on 127.0.0.1 behind a proxy on
 *     the same box).
 *   - Non-loopback peers get header trust ONLY when TRUST_PROXY=true.
 *     Otherwise the kernel-reported peer wins. Without this gate, any
 *     client could send `x-real-ip: 1.2.3.4` and forge their source IP.
 */
export async function clientIpMiddleware(c: Context, next: Next) {
  const peer = peerAddress(c);
  const xri = c.req.header("x-real-ip")?.trim() || null;

  // In-process dispatch (app.fetch — the MCP adapter calling the API itself)
  // has NO TCP peer; every external caller has one (the proxy/socket), so this
  // is unforgeable. Treat it as trusted loopback so self-calls resolve a client
  // IP — the outer request already authenticated + was rate-limited.
  if (peer === null) {
    c.set("clientIp", xri || "127.0.0.1");
    return next();
  }

  const trustHeader = isLoopbackPeer(peer) || env.TRUST_PROXY === true;
  const ip = trustHeader ? xri || peer : peer;

  c.set("clientIp", ip && ip.length > 0 ? ip : null);
  await next();
}
