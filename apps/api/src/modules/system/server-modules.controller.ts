/**
 * Server native-module controller — /api/servers/:id/modules.
 *
 * Gated by the same server:read / server:write permission tags as the rest of
 * the servers surface (see system.routes.ts). Org-scoped: an out-of-org server
 * id 404s indistinguishably from missing.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import { assertNotCloud } from "../../lib/controller-helpers";
import { scanServer, applyServerModule } from "./server-modules.service";

async function resolveServer(c: Context) {
  const id = c.req.param("id")!;
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  return { id, server };
}

/** GET /servers/:id/modules — cached module drift for the server. */
export async function listServerModules(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { id, server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);
  const rows = await repos.serverModuleStatus.listByServer(id);
  return c.json(rows);
}

/** POST /servers/:id/modules/scan — refresh the drift cache now. */
export async function scanServerModules(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);
  const views = await scanServer(server).catch((err: unknown) => {
    throw new Error(`scan failed: ${(err as Error).message}`);
  });
  return c.json({ ok: true, modules: views });
}

/**
 * POST /servers/:id/modules/:module/apply — apply pending migrations. Runs in
 * "all" mode: the operator explicitly asked, so consent-tier steps apply too
 * (the UI surfaces their warning before calling this).
 */
export async function applyServerModuleUpdate(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;
  const { server } = await resolveServer(c);
  if (!server) return c.json({ error: "Server not found" }, 404);
  const moduleName = c.req.param("module")!;
  // The runner never throws — a failed step comes back as { ok:false, error }.
  // That's a completed operation with a structured outcome, so 200 either way;
  // the caller reads `ok`. (applyServerModule only throws for unknown module /
  // no verifiable catalog, which the error middleware maps to 4xx/5xx.)
  const result = await applyServerModule(server, moduleName, "all");
  return c.json(result);
}
