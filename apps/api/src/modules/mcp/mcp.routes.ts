/**
 * MCP endpoint — mounted at /api/mcp in app.ts. A stateless Streamable-HTTP
 * JSON-RPC endpoint. It is a PUBLIC route (no auto-injected authMiddleware):
 * it authenticates the PAT itself, and every tool call dispatches an internal
 * request that re-runs the full auth + permission stack (see mcp-dispatch.ts).
 */

import { Hono } from "hono";
import { repos } from "@repo/db";
import { secureRouter } from "../../lib/secure-router";
import { hashPatToken } from "../../lib/pat";
import { isPatToken, parseBearerToken } from "../../lib/bearer";
import { handleMcpMessage, jsonRpcError } from "./mcp-server";

const r = secureRouter(new Hono(), { module: "mcp", basePath: "/api/mcp" });

const PUBLIC_REASON =
  "MCP JSON-RPC endpoint; authenticates via PAT bearer and re-checks auth on every dispatched tool call";

// This server doesn't push server→client messages, so GET (SSE stream) is 405.
r.public("get", "/", { reason: PUBLIC_REASON }, (c) => c.body(null, 405));

// Same tight per-IP budget as the auth endpoints — unauthenticated PAT probes
// run a DB lookup, so cap them well below the default-anon rate.
r.public("post", "/", { reason: PUBLIC_REASON, rateLimit: "auth-tight" }, async (c) => {
  const token = parseBearerToken(c);
  if (!isPatToken(token)) {
    return c.json(jsonRpcError(null, -32001, "Missing access token"), 401);
  }

  // Gate the whole endpoint on a valid PAT (tool calls re-validate + apply the
  // read-only gate when they dispatch through authMiddleware).
  const pat = await repos.personalAccessToken.findActiveByHash(hashPatToken(token));
  if (!pat) {
    return c.json(jsonRpcError(null, -32001, "Invalid or expired access token"), 401);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  // 2025-06-18 removed JSON-RPC batching; accept a single message only.
  if (Array.isArray(payload)) {
    return c.json(jsonRpcError(null, -32600, "Batch requests are not supported"), 400);
  }

  const res = await handleMcpMessage(payload as Parameters<typeof handleMcpMessage>[0], token);
  // Notification (no id) → 202 Accepted with no body (per JSON-RPC).
  if (!res) return c.body(null, 202);
  return c.json(res);
});

export const mcpRoutes = r.hono;
