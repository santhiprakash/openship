import { getMcpTools, toClientTool } from "./mcp-tools";
import { dispatchTool } from "./mcp-dispatch";

/**
 * Minimal MCP server over JSON-RPC 2.0 (Streamable HTTP transport, stateless).
 * Implements the surface a tools-only server needs: initialize, tools/list,
 * tools/call, ping. Server-initiated messaging (SSE stream) isn't used — every
 * tool is a synchronous request/response mapped onto the real HTTP API.
 */

const SERVER_INFO = { name: "openship", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
/** Versions we can speak; `initialize` negotiates down to one of these. */
const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result: value };
}
/** JSON-RPC error envelope — shared with mcp.routes.ts so the shape stays single-sourced. */
export function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (no `id` → no reply). `bearerToken` is the caller's PAT,
 * forwarded to tool dispatch so sub-requests re-authenticate.
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  bearerToken: string,
): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;

  // Reject malformed envelopes up front (JSON-RPC 2.0 → Invalid Request).
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return jsonRpcError(msg.id, -32600, "Invalid Request");
  }

  switch (msg.method) {
    case "initialize": {
      // Negotiate: honour the client's version only if we speak it, else offer ours.
      const requested = msg.params?.protocolVersion as string | undefined;
      const protocolVersion =
        requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      return result(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case "notifications/initialized":
    case "initialized":
      return null; // ack-only notification

    case "ping":
      return result(msg.id, {});

    case "tools/list":
      return result(msg.id, { tools: getMcpTools().map(toClientTool) });

    case "tools/call": {
      const name = msg.params?.name as string | undefined;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const tool = getMcpTools().find((t) => t.name === name);
      if (!tool) return jsonRpcError(msg.id, -32602, `Unknown tool: ${name}`);

      const dispatched = await dispatchTool(tool, args, bearerToken);
      return result(msg.id, {
        content: [{ type: "text", text: JSON.stringify(dispatched.data, null, 2) }],
        isError: !dispatched.ok,
      });
    }

    default:
      return isNotification ? null : jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
