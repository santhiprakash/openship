import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env, trustedOrigins } from "./config/env";
import { errorHandler, handleApiError } from "./middleware/error-handler";
import { rateLimiter } from "./middleware/rate-limiter";
import { clientIpMiddleware } from "./middleware/client-ip";
import { betterAuthShield } from "./middleware/better-auth-shield";
import { bootstrapPlatform } from "./lib/controller-helpers";

import { authRoutes } from "./modules/auth/auth.routes";
import { projectRoutes } from "./modules/projects/project.routes";
import { deploymentRoutes } from "./modules/deployments/deployment.routes";
import { domainRoutes } from "./modules/domains/domain.routes";
import { serviceRoutes } from "./modules/services/service.routes";
import { analyticsRoutes } from "./modules/analytics/analytics.routes";
import { billingPlansRoutes } from "./modules/billing/billing.routes";
import { webhookRoutes } from "./modules/webhooks/webhook.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { githubRoutes } from "./modules/github";
import * as githubAuth from "./modules/github/github.auth";
import { settingsRoutes } from "./modules/settings/settings.routes";
import { notificationsRoutes } from "./modules/notifications/notifications.routes";
import { imageRoutes } from "./modules/images/images.routes";
import { backupRoutes } from "./modules/backups/backup.routes";
import { auditRoutes } from "./modules/audit/audit.routes";
import { permissionsRoutes } from "./modules/permissions/permissions.routes";
import { backupWebhookRoutes } from "./modules/backups/webhook.routes";
import { backupDestinationRoutes } from "./modules/backup-destinations/destination.routes";
import { reconcileAllSchedules } from "./modules/backups/triggers/cron";
import { scheduleRetentionPrune } from "./modules/backups/retention-prune";
import { scheduleAuditPrune } from "./modules/audit/audit-prune-schedule";
import { schedulePendingGrantPrune } from "./modules/permissions/pending-grant-prune-schedule";
import { backupOrchestrator } from "./modules/backups/backup.orchestrator";
import { getJobRunner } from "./lib/job-runner";
import { repos } from "@repo/db";

/* ---------- Initialize platform (runtime + infra + system) ---------- */
await bootstrapPlatform();

export const app = new Hono();

/* ---------- Global middleware ---------- */
app.use(
  "*",
  cors({
    origin: trustedOrigins,
    credentials: true,
  }),
);
app.use("*", errorHandler);
app.use("*", logger());
app.use("*", clientIpMiddleware);

// Primary error path: Hono's compose() catches thrown errors at each
// dispatch level and routes them to `this.errorHandler`, NOT up through
// middleware. So try/catch-around-next middleware never sees downstream
// throws — only an explicit `app.onError(...)` does. Register one here so
// AppError / ZodError get serialized with their statusCode and code.
app.onError(handleApiError);

app.use("/api/auth/*", rateLimiter);

// Shield Better Auth's organization-plugin reads (list-members,
// list-invitations, get-active-member-role) — they leak admin-tier
// data to restricted/member roles otherwise. Must register BEFORE the
// /api/auth catch-all route mount so Hono runs it first.
app.use("/api/auth/organization/*", betterAuthShield);

/* ---------- Shared routes (self-hosted + cloud + desktop) ---------- */
app.route("/api/health", healthRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/projects/:id/services", serviceRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/domains", domainRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/github", githubRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/billing", billingPlansRoutes);
app.route("/api/images", imageRoutes);
app.route("/api", backupRoutes);
app.route("/api/backup-destinations", backupDestinationRoutes);
app.route("/api/webhooks/backup", backupWebhookRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/permissions", permissionsRoutes);
app.route("/api/notifications", notificationsRoutes);

/* ---------- OAuth callback landing pages ---------- */
const authCallbackHtml = `<!DOCTYPE html><html><head><title>Success</title></head><body><script>window.close();</script><p>Authentication successful. You can close this window.</p></body></html>`;

app.get("/auth/callback/install", (c) => {
  if (githubAuth.getGitHubAuthMode() === "app") {
    return c.redirect(githubAuth.getInstallUrl());
  }
  return c.html(authCallbackHtml);
});
app.get("/auth/callback/close", (c) => c.html(authCallbackHtml));

/* ---------- WebSocket subsystem ---------- */
//
// Needed for both interactive terminal endpoints:
//   - server terminal (self-hosted only — mounted inside the `else`)
//   - service terminal (mounted unconditionally below; runtime adapter
//     decides Docker vs Cloud per-service)
//
// setupWebSocket(app) MUST run before any route module that calls
// upgradeWebSocket() at module load.
const { setupWebSocket } = await import("./lib/ws");
setupWebSocket(app);

/* ---------- Service terminal (both modes) ---------- */
//
// Cloud mode routes terminal traffic to the user's Oblien workspace
// via the Cloud runtime adapter; self-hosted mode routes to Docker
// exec via the Docker runtime adapter. The controller picks via
// resolveDeploymentRuntime() from the service's active deployment.
{
  const { serviceTerminalRoutes } = await import(
    "./modules/service-terminal/service-terminal.routes"
  );
  app.route("/api/services/terminal", serviceTerminalRoutes);
}

/* ---------- Cloud-only routes (gated by CLOUD_MODE) ---------- */
if (env.CLOUD_MODE) {
  const { cloudSaasRoutes } = await import("./modules/cloud/cloud-saas.routes");
  app.route("/api/cloud", cloudSaasRoutes);

  const { billingSaasRoutes } = await import("./modules/billing/billing.routes");
  app.route("/api/billing", billingSaasRoutes);
} else {
  /**
   * System routes - filesystem browse, instance setup, user provisioning.
   *
   * Dynamic import: in cloud mode these modules are NEVER loaded into the
   * process. The filesystem controller (node:fs), setup controller
   * (admin user creation), and all their dependencies don't exist in
   * the cloud runtime - not just "protected", but fully absent.
   */
  const { systemRoutes } = await import("./modules/system");
  app.route("/api/system", systemRoutes);

  /** Mail server setup - self-hosted iRedMail wizard */
  const { mailRoutes } = await import("./modules/mail");
  app.route("/api/mail", mailRoutes);

  /**
   * Interactive SERVER terminal (xterm.js ↔ WebSocket ↔ ssh2 PTY).
   * Self-hosted only — exposes the host's SSH-managed servers.
   * setupWebSocket(app) already ran unconditionally above; this
   * branch only mounts the SSH-flavored routes.
   */
  const { terminalRoutes } = await import("./modules/terminal/terminal.routes");
  app.route("/api/terminal", terminalRoutes);

  /** Cloud account management - connect/disconnect to Openship Cloud */
  const { cloudLocalRoutes } = await import("./modules/cloud/cloud-local.routes");
  app.route("/api/cloud", cloudLocalRoutes);

  /** Billing proxy - cloud-connected local instances proxy to SaaS */
  const { billingLocalRoutes } = await import("./modules/billing/billing-local.routes");
  app.route("/api/billing", billingLocalRoutes);

  /** Start the periodic analytics scraper for managed servers */
  const { startAnalyticsScraper } = await import("./modules/system/analytics-scraper");
  startAnalyticsScraper();
}

// ─── Backup job runner + boot reconcile ─────────────────────────────
//
// One JobRunner powers all backup work — BullMQ when Redis is
// reachable, in-process otherwise. Same code path for SaaS and
// desktop installs. The runner is module-singleton; first access
// here triggers Redis detection.
{
  const sweepStale = repos.backupRun.sweepStaleRuns(
    "API restart while backup in flight",
  );
  const sweepStaleRestores = repos.backupRestore.sweepStaleRestores(
    "API restart while restore in flight",
  );

  const runner = await getJobRunner();
  await runner.start({
    processRun: (runId) => backupOrchestrator.execute(runId),
  });
  console.log(`[boot] backup runner: ${runner.describe()}`);

  // Daily retention sweep — idempotent registration.
  void scheduleRetentionPrune().catch((err) =>
    console.warn("[boot] scheduleRetentionPrune failed:", err),
  );

  // Daily audit-log prune (per-org retention window).
  void schedulePendingGrantPrune().catch((err) =>
    console.warn("[boot] schedulePendingGrantPrune failed:", err),
  );

  void scheduleAuditPrune().catch((err) =>
    console.warn("[boot] scheduleAuditPrune failed:", err),
  );

  // Re-register every enabled cron policy with the runner.
  void reconcileAllSchedules().then((stats) =>
    console.log(
      `[boot] backup schedules: ${stats.registered} registered, ${stats.skipped} skipped`,
    ),
  );

  void Promise.all([sweepStale, sweepStaleRestores]).then(([runs, restores]) => {
    if (runs > 0 || restores > 0) {
      console.log(
        `[boot] swept ${runs} stale backup runs + ${restores} stale restores`,
      );
    }
  });
}

// ─── Notification delivery runner ───────────────────────────────────
//
// Polls notification_delivery for queued rows every few seconds and
// dispatches them to per-channel workers (email/webhook/in_app/slack).
// Lightweight in-process timer — fine for the cluster sizes we target.
{
  const { startNotificationRunner } = await import("./lib/notification-workers");
  startNotificationRunner();
  console.log("[boot] notification runner started");
}
