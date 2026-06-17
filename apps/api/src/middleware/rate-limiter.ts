import type { Context, Next } from "hono";

const requestCounts = new Map<string, { count: number; resetAt: number }>();

export async function rateLimiter(c: Context, next: Next) {
  const path = c.req.path;

  if (path === "/api/auth/get-session") {
    await next();
    return;
  }

  const ip = c.var.clientIp;
  if (!ip) {
    return c.json(
      { error: "Missing client IP — request must come through the proxy" },
      400,
    );
  }
  const now = Date.now();
  const window = 60_000; // 1 minute
  const maxRequests = 100;

  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + window });
  } else if (entry.count >= maxRequests) {
    return c.json({ error: "Too many requests" }, 429);
  } else {
    entry.count++;
  }

  await next();
}
