import {
  getRouteRegistry,
  isPublicSpec,
  parsePermissionTag,
  type RegisteredRoute,
} from "../../lib/route-permission";

/**
 * MCP tool generation from the HTTP route registry. A route is exposed as a
 * tool ONLY if its spec declares an `mcp` block (opt-in allowlist) — the
 * description and body-param schema come from there, co-located with the route.
 * Each tool's handler dispatches an internal request through the real Hono app
 * (see mcp-dispatch.ts), so no business logic is duplicated here.
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

/**
 * Modules that must NEVER be tools even if a route is mistakenly annotated —
 * credential/auth surfaces. `tokens` in particular would let a full-access MCP
 * token mint a fresh PAT and escape its own scope. Everything else is gated by
 * opt-in (no `mcp` block → not a tool), so this stays minimal.
 */
const HARD_DENY = new Set(["tokens", "auth", "mcp"]);

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function includeRoute(route: RegisteredRoute): boolean {
  const spec = route.spec;
  if (isPublicSpec(spec)) return false;
  if (HARD_DENY.has(route.module)) return false;
  return spec.mcp != null; // opt-in allowlist
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
  const base = [route.method.toLowerCase(), ...segments].join("_").replace(/_+/g, "_").slice(0, 64);
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base.slice(0, 60)}_${n++}`;
  }
  taken.add(name);
  return name;
}

function inputSchema(
  pathParams: string[],
  hasBody: boolean,
  bodySchema?: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of pathParams) {
    properties[p] = { type: "string", description: `Path parameter :${p}` };
  }
  properties.query = { type: "object", description: "Optional query-string parameters", additionalProperties: true };
  if (hasBody) {
    // The route's TypeBox body schema (JSON Schema at runtime) when declared,
    // else a permissive fallback so a body can still be passed.
    properties.body = bodySchema ?? { type: "object", description: "Request JSON body", additionalProperties: true };
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
      const spec = route.spec;
      const mcp = isPublicSpec(spec) ? undefined : spec.mcp;
      const pathParams = extractPathParams(route.path);
      const hasBody = BODY_METHODS.has(route.method);
      const bodySchema = mcp?.body as Record<string, unknown> | undefined;
      return {
        name: toolName(route, taken),
        description: mcp?.description ?? `${route.method} ${route.path}`,
        inputSchema: inputSchema(pathParams, hasBody, hasBody ? bodySchema : undefined),
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
