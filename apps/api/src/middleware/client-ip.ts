import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

declare module "hono" {
  interface ContextVariableMap {
    clientIp: string | null;
  }
}

const LOOPBACK = new Set<string>([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export async function clientIpMiddleware(c: Context, next: Next) {
  const peer = peerAddress(c);
  const xri = c.req.header("x-real-ip")?.trim() || null;
  const trustHeader = peer !== null && LOOPBACK.has(peer);
  const ip = trustHeader ? xri : peer;
  c.set("clientIp", ip && ip.length > 0 ? ip : null);
  await next();
}
