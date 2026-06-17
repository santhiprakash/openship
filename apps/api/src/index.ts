import { serve } from "@hono/node-server";
import { app } from "./app";
import { env } from "./config/env";
import { getJobRunner } from "./lib/job-runner";
import { enforceRouteScanAtBoot } from "./lib/route-scanner";

const port = env.PORT;

// Refuse to start if any registered route is mis-tagged or any
// mutation route was mounted on a raw Hono instance (bypassing
// secureRouter). The scanner exits the process on critical errors.
enforceRouteScanAtBoot(app);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🚀 Openship API running on http://localhost:${info.port}`);
});

// WebSocket support is needed for:
//   - interactive server terminal (self-hosted only)
//   - interactive service terminal (cloud + self-hosted — adapter
//     selects Docker exec or Oblien workspace based on the service's
//     deployment platform)
// Either mode uses WS, so we always inject. Cloud-mode pays the
// @hono/node-ws cost regardless.
{
  const { injectWebSocket } = await import("./lib/ws");
  injectWebSocket(server);
}

// ─── Graceful shutdown ──────────────────────────────────────────────
//
// First time this codebase has a signal handler. Order of operations
// when SIGTERM / SIGINT arrives (typical kubectl rollout / docker stop
// / Ctrl-C scenarios):
//
//   1. Close BullMQ workers so they stop picking new jobs but FINISH
//      whatever they're processing right now. Backup runs in flight
//      get to complete — partial uploads to S3 would otherwise leave
//      orphaned multipart uploads.
//   2. Close BullMQ queues + the shared Redis connection.
//   3. Close the HTTP server so it stops accepting new connections
//      but lets in-flight ones drain.
//
// 30s deadline overall — matches Docker's default SIGKILL timeout.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);

  const deadline = setTimeout(() => {
    console.warn("Shutdown deadline exceeded — exiting forcibly");
    process.exit(1);
  }, 30_000);
  deadline.unref();

  try {
    const runner = await getJobRunner();
    await runner.shutdown(20_000);
  } catch (err) {
    console.warn("[shutdown] job runner close failed:", err);
  }

  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) console.warn("[shutdown] server close failed:", err);
      resolve();
    });
  });

  clearTimeout(deadline);
  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
