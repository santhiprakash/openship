import {
  getRouteRegistry,
  isPublicSpec,
  parsePermissionTag,
  type RegisteredRoute,
} from "../../lib/route-permission";

/**
 * MCP tool generation from the HTTP route registry. Every curated route becomes
 * one tool; the tool's handler dispatches an internal request through the real
 * Hono app (see mcp-dispatch.ts), so no business logic is duplicated here.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  // Dispatch metadata (not sent to the client):
  method: string;
  path: string; // full path with :params, e.g. /api/projects/:id
  pathParams: string[];
  hasBody: boolean;
}

/** Modules whose routes are never tools (transport-incompatible or non-agentic). */
const DENY_MODULES = new Set(["webhooks", "auth", "health", "images", "mcp"]);

/** Path fragments to exclude: streaming/interactive endpoints and callback/webhook routes. */
const DENY_PATH_FRAGMENTS = [
  "/stream",
  "/logs/stream",
  "/server-logs",
  "/ws",
  "/terminal",
  "/events",
  "/webhooks",
  "/webhook",
  "/callback",
  "/oauth",
];

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function includeRoute(route: RegisteredRoute): boolean {
  if (isPublicSpec(route.spec)) return false; // no permission tag → not agentic/safe
  if (DENY_MODULES.has(route.module)) return false;
  const p = route.path.toLowerCase();
  if (DENY_PATH_FRAGMENTS.some((f) => p.includes(f))) return false;
  return true;
}

function extractPathParams(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.startsWith(":"))
    .map((s) => s.slice(1));
}

/** Stable, unique, MCP-safe tool name from method + path. */
function toolName(route: RegisteredRoute, taken: Set<string>): string {
  const segments = route.path
    .split("/")
    .filter((s) => s && s !== "api")
    .map((s) => (s.startsWith(":") ? `by_${s.slice(1)}` : s.replace(/[^a-z0-9]+/gi, "_")));
  let base = [route.method.toLowerCase(), ...segments].join("_").replace(/_+/g, "_").slice(0, 64);
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base.slice(0, 60)}_${n++}`;
  }
  taken.add(name);
  return name;
}

function inputSchema(pathParams: string[], hasBody: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of pathParams) {
    properties[p] = { type: "string", description: `Path parameter :${p}` };
  }
  properties.query = { type: "object", description: "Optional query-string parameters", additionalProperties: true };
  if (hasBody) {
    properties.body = { type: "object", description: "Request JSON body", additionalProperties: true };
  }
  return {
    type: "object",
    properties,
    required: pathParams,
    additionalProperties: false,
  };
}

function annotationsFor(route: RegisteredRoute): { readOnlyHint: boolean; destructiveHint: boolean } {
  const spec = route.spec;
  if (isPublicSpec(spec)) return { readOnlyHint: true, destructiveHint: false };
  const parsed = parsePermissionTag(spec.tag);
  const readOnlyHint = parsed.action === "read" || parsed.isList || spec.readOnly === true;
  const destructiveHint =
    route.method === "DELETE" ||
    parsed.action === "admin" ||
    /delete|teardown|destroy|remove|wipe|revoke/i.test(route.path);
  return { readOnlyHint, destructiveHint };
}

let cached: McpToolDef[] | null = null;

/** All curated tools, generated once from the route registry. */
export function getMcpTools(): McpToolDef[] {
  if (cached) return cached;
  const taken = new Set<string>();
  cached = getRouteRegistry()
    .filter(includeRoute)
    .map((route): McpToolDef => {
      const pathParams = extractPathParams(route.path);
      const hasBody = BODY_METHODS.has(route.method);
      const spec = route.spec;
      const tag = isPublicSpec(spec) ? "public" : spec.tag;
      return {
        name: toolName(route, taken),
        description: `${route.method} ${route.path} (${tag})`,
        inputSchema: inputSchema(pathParams, hasBody),
        annotations: annotationsFor(route),
        method: route.method,
        path: route.path,
        pathParams,
        hasBody,
      };
    });
  return cached;
}

/** Client-facing tool descriptor (no dispatch internals). */
export function toClientTool(t: McpToolDef) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: t.annotations.readOnlyHint,
      destructiveHint: t.annotations.destructiveHint,
    },
  };
}
