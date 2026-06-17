import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import {
  issueTicket,
  serviceTerminalWsHandler,
} from "./service-terminal.controller";
import { repos } from "@repo/db";

/**
 * Service-level interactive terminal routes.
 *
 * Unlike the server-terminal routes, this is NOT `localOnly` —
 * service terminals work on BOTH self-hosted (Docker exec into the
 * service's container) AND openship cloud (Oblien workspace terminal).
 * The adapter selection happens inside the controller via
 * resolveDeploymentRuntime(), driven by the deployment's meta.
 *
 *   POST /api/services/terminal/ticket       one-shot WS auth ticket
 *   GET  /api/services/terminal/ws/:serviceId WebSocket upgrade
 *
 * The WS endpoint deliberately does NOT apply authMiddleware: a normal
 * middleware that returns 401 would prevent the upgrade from completing.
 * Auth happens inside the upgradeWebSocket factory (ticket subprotocol
 * OR session-cookie fallback).
 */
export const serviceTerminalRoutes = new Hono();
const r = secureRouter(serviceTerminalRoutes, {
  module: "service-terminal",
  basePath: "/api/services/terminal",
});

// Ticket endpoint — normal HTTP auth + permission gate.
r.post("/ticket", { tag: "terminal:write" }, issueTicket);

// WS upgrade — auth happens inside upgradeWebSocket via single-use
// ticket (issued by POST /ticket under terminal:write) or session-cookie
// fallback. HTTP middleware would block the handshake, so this is
// explicitly public and documented.
r.public(
  "get",
  "/ws/:serviceId",
  {
    reason:
      "WebSocket upgrade — auth happens inside upgradeWebSocket via ticket subprotocol or session-cookie fallback (HTTP middleware blocks the handshake)",
  },
  serviceTerminalWsHandler,
);

// Boot-time sweep: any audit rows left open by a prior crash are
// finalized as 'server_error'. Their underlying PTY streams (Docker
// exec / Oblien WS) are dead with the process anyway.
void repos.serviceTerminalSession
  .closeAllActive("server_error")
  .then((n) => {
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[service-terminal] swept ${n} orphan session row(s) from previous run`,
      );
    }
  })
  .catch(() => {
    /* sweep failure is non-fatal */
  });
