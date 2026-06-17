/**
 * Webmail-as-project bridge.
 *
 * Webmail ships through the SAME deploy pipeline every other project uses,
 * with two narrow divergences:
 *
 *   1. The source is a PRE-BUILT release directory at `apps/email/dist/`
 *      (produced by `bun run build` in `apps/email/`). The deploy just
 *      tar-ships that dir to the target. No build runs at deploy time.
 *      If the dist doesn't exist, the deploy fails fast with instructions
 *      to build it first.
 *
 *   2. Install / start commands target the release layout - `bun install`
 *      runs inside `server/` (where the runtime deps live), and start is
 *      `bun run server/src/main.ts` with `CLIENT_BUILD_DIR` pointing at
 *      the bundled `client/` next to it.
 *
 * Everything else - preflight, toolchain (bun), workspace transfer,
 * OpenResty vhost, Let's Encrypt cert, lifecycle hooks - is the standard
 * `createQueuedDeployment` → `startBuild` path. The bespoke 10-step
 * engine that used to live here is gone. The previous "build on the
 * target" flow is gone too - it OOM-killed small VPSes during the Vite
 * SSR pass; pre-building avoids that entirely.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { repos, type Project } from "@repo/db";
import { sshManager } from "../../../lib/ssh-manager";
import { assertResourceInOrg } from "../../../lib/controller-helpers";
import {
  buildConfigSnapshot,
  createQueuedDeployment,
  encryptEnvVars,
  metaWithPrevious,
  runDeploymentPreflight,
  startBuild,
} from "../../deployments/build.service";
import {
  listProjectRouteRows,
  syncProjectRouteState,
} from "../../domains/project-route.service";
import {
  readState,
  writeState,
  type MailWebmailState,
  type MailServerState,
} from "../mail-state";

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_NAME = "Webmail";

/**
 * Persistent webmail state on the target. The standard pipeline wipes the
 * per-deploy workspace on every redeploy, so anything that must survive
 * (branding config, the SQLite session DB) lives under this dir instead.
 */
const REMOTE_PERSIST_DIR = "/var/lib/openship-webmail";
const REMOTE_BRANDING_DIR = `${REMOTE_PERSIST_DIR}/branding`;
const REMOTE_SQLITE_PATH = `${REMOTE_PERSIST_DIR}/zero.db`;

/** Internal port Zero binds to behind the OpenResty vhost the pipeline creates. */
const DEFAULT_INTERNAL_PORT = 4080;

/** Where on the API host the webmail repo lives. Overridable for tests. */
function resolveWebmailRepoDir(): string {
  if (process.env.MAIL_WEBMAIL_SOURCE_DIR) {
    return process.env.MAIL_WEBMAIL_SOURCE_DIR;
  }
  return resolve(process.cwd(), "../../apps/email");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the path to the pre-built webmail dist on the API host.
 *
 * The dist is produced ONCE, ahead of deploy, by running:
 *
 *     cd apps/email && bun run build
 *
 * The client reads its backend URL from `window.location.origin` at
 * runtime, so one dist deploys to any hostname unchanged - no env
 * required at build time.
 *
 * Deploys NEVER run that build - they only tar-ship whatever is currently
 * at `apps/email/dist/`. If the dir is missing the deploy fails fast so
 * the operator knows to build first.
 */
function resolveWebmailDistDir(): string {
  const dir = resolve(resolveWebmailRepoDir(), "dist");
  if (!existsSync(dir)) {
    throw new Error(
      `Webmail release dist not found at ${dir}. ` +
        `Build it first: cd apps/email && bun run build`,
    );
  }
  return dir;
}

function deriveAcmeEmail(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  const base = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  return `admin@${base}`;
}

/**
 * The only operational concern that doesn't fit in the standard pipeline:
 * a persistent branding dir outside the workspace. The pipeline wipes the
 * workspace on every redeploy; branding config has to live somewhere else.
 *
 * Bun itself is installed by `ensureToolchain` via the standard catalog
 * (webmail stack declares `requiredTools: ["bun"]`) - no bespoke install here.
 */
async function prepareTarget(serverId: string): Promise<void> {
  await sshManager.withExecutor(serverId, async (exec) => {
    await exec.mkdir(REMOTE_PERSIST_DIR);
    await exec.exec(`chmod 0750 ${REMOTE_PERSIST_DIR}`);
    await exec.mkdir(REMOTE_BRANDING_DIR);
    await exec.exec(`chmod 0750 ${REMOTE_BRANDING_DIR}`);
    // The runtime adapter (re-)chowns these to the sandbox user on every
    // deploy, but doing it here too means a fresh server has the dirs in
    // the right shape before the first deploy starts - no permission
    // shuffle mid-pipeline that the user might see scroll past.
  });
}

async function persistWebmailBlock(
  mailServerId: string,
  block: MailWebmailState,
): Promise<void> {
  await sshManager.withExecutor(mailServerId, async (exec) => {
    const state = await readState(exec);
    if (!state) {
      throw new Error(
        "Could not persist webmail state - mail state file is missing on the server.",
      );
    }
    const next: MailServerState = { ...state, webmail: block };
    await writeState(exec, next);
  });
}

/**
 * Read the existing webmail block (if any) so a redeploy can reuse the
 * branding token + session encryption key. Returns null on any failure -
 * the caller falls back to minting fresh secrets.
 */
async function readExistingWebmailBlock(
  mailServerId: string,
): Promise<{ block: MailWebmailState | null; installDomain: string | null }> {
  try {
    let block: MailWebmailState | null = null;
    let installDomain: string | null = null;
    await sshManager.withExecutor(mailServerId, async (exec) => {
      const state = await readState(exec);
      block = state?.webmail ?? null;
      installDomain = state?.domain ?? null;
    });
    return { block, installDomain };
  } catch {
    return { block: null, installDomain: null };
  }
}

/**
 * Flip the `installed` flag on the mail-state webmail block to true.
 * Called from the deployment success hook so a failed build never leaves
 * a stale "Open webmail" CTA. Returns silently if the block is missing
 * (the deploy didn't go through `startWebmailDeploy` - nothing to flip).
 *
 * For cloud deploys to the mail server's own `mail.<install>` subdomain
 * we ALSO register an OpenResty proxy route on the mail VPS that points
 * `mail.<install>` → the Opshcloud URL. Operators can't change DNS for
 * that subdomain (it's pinned to the mail VPS for IMAP/SMTP), so the
 * mail VPS proxies it for them.
 *
 * The mailServerId is derived from the project slug (`webmail-<id>`) -
 * the slug is the only piece of webmail context that survives into the
 * generic deployment lifecycle.
 */
export async function markWebmailInstalled(
  mailServerId: string,
  deployedUrl?: string,
): Promise<void> {
  try {
    let needsProxy = false;
    let proxyHostname = "";
    let proxyUpstream = "";

    await sshManager.withExecutor(mailServerId, async (exec) => {
      const state = await readState(exec);
      if (!state?.webmail) return;

      // Detect: was this deploy on Opshcloud, targeted at the mail
      // server's own mail.<install> subdomain? If so we'll register the
      // proxy AFTER the state write below.
      const installDomain = state.domain;
      const wm = state.webmail;
      const isCloud = wm.target === "cloud";
      const isOwnMailSubdomain =
        !!installDomain && wm.hostname === `mail.${installDomain}`;
      needsProxy = isCloud && isOwnMailSubdomain && !!deployedUrl;

      if (needsProxy) {
        proxyHostname = wm.hostname;
        proxyUpstream = deployedUrl!;
      }

      const next: MailServerState = {
        ...state,
        webmail: {
          ...wm,
          installed: true,
          deployedAt: new Date().toISOString(),
          ...(deployedUrl ? { cloudUrl: isCloud ? deployedUrl : wm.cloudUrl } : {}),
        },
      };
      await writeState(exec, next);
    });

    if (needsProxy) {
      await registerWebmailCloudProxy(mailServerId, proxyHostname, proxyUpstream);
    }
  } catch (err) {
    console.warn(
      `[webmail] could not flip installed=true for ${mailServerId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Register an OpenResty proxy on the mail VPS:
 *   `https://<hostname>` → `<cloudUrl>`
 *
 * Used only for the cloud-deploy-with-mail-subdomain case (mail.<install>
 * can't be repointed via DNS, so the mail VPS proxies on the operator's
 * behalf). For every other case the standard project-pipeline routing
 * already handled the hostname.
 *
 * Provisions a Let's Encrypt cert as part of the registration. Failures
 * are non-fatal here - the proxy can be retried by a redeploy.
 */
async function registerWebmailCloudProxy(
  mailServerId: string,
  hostname: string,
  cloudUrl: string,
): Promise<void> {
  // resolveTargetPlatform gives us the mail VPS's openresty + ssl -
  // same platform that fronts IMAP/SMTP traffic for this hostname today.
  const { resolveTargetPlatform } = await import("../../../lib/deployment-runtime");
  const platform = await resolveTargetPlatform("server", "bare", mailServerId);

  await platform.routing.registerRoute({
    domain: hostname,
    tls: true,
    targetUrl: cloudUrl,
  });
  // Provision a cert for the proxy hostname. The mail VPS already has
  // certs for IMAP/SMTP STARTTLS - this adds the HTTPS-on-:443 cert
  // for the webmail UI. Reuses the existing Let's Encrypt feature.
  await platform.ssl.provisionCert(hostname);
}

/** Extract the mailServerId encoded in a `webmail-<id>` project slug. */
export function mailServerIdFromWebmailSlug(slug: string): string | null {
  const m = slug.match(/^webmail-(.+)$/);
  return m?.[1] ?? null;
}

/**
 * Webmail-specific teardown that the generic project cleanup doesn't cover:
 *
 *   - The persistent branding dir on the target host (it lives outside the
 *     deploy artifact dir, since the standard pipeline wipes the workspace
 *     on every redeploy - so the generic runtime.destroy never touches it).
 *   - The `webmail` block in mail-state.json on the mail VPS, so a future
 *     re-deploy starts fresh instead of inheriting a stale brandingToken
 *     or `installed=true` flag.
 *
 * Called from project-cleanup.service after the standard manifest cleanup
 * (containers, routes, artifacts) has finished. All failures are swallowed
 * - the project rows are already soft-deleted, so a failing branding-dir
 * remove can't strand the user; it just leaves /var/lib/openship-webmail
 * behind until the next deploy reuses it.
 */
export async function cleanupWebmailInstall(input: {
  mailServerId: string;
}): Promise<void> {
  // 1. Read the webmail block to find the target host (webmail may live on
  //    a separate server from the mail VPS) BEFORE we wipe the block.
  let targetServerId: string | null = null;
  try {
    await sshManager.withExecutor(input.mailServerId, async (exec) => {
      const state = await readState(exec);
      targetServerId = state?.webmail?.targetServerId ?? null;
    });
  } catch (err) {
    console.warn(
      `[webmail] could not read mail-state on ${input.mailServerId}: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 2. Wipe the persistent branding dir on the target host.
  if (targetServerId) {
    try {
      await sshManager.withExecutor(targetServerId, async (exec) => {
        await exec.rm(REMOTE_BRANDING_DIR);
      });
    } catch (err) {
      console.warn(
        `[webmail] could not remove branding dir on ${targetServerId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // 3. Strip the webmail block from mail-state on the mail VPS.
  try {
    await sshManager.withExecutor(input.mailServerId, async (exec) => {
      const state = await readState(exec);
      if (!state?.webmail) return;
      const next: MailServerState = { ...state };
      delete next.webmail;
      await writeState(exec, next);
    });
  } catch (err) {
    console.warn(
      `[webmail] could not clear mail-state webmail block on ${input.mailServerId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ─── Project ensure ──────────────────────────────────────────────────────────

/**
 * Find-or-create the project row for this webmail install. Keyed off the
 * mail server ID so redeploys reuse the same project. `localPath` points
 * at the freshly built release dist for this deploy - the standard
 * pipeline streams that to the target, runs install, and starts.
 *
 * The release dist already contains a pre-built client SPA and the
 * server source, so the target does NO build work. `buildCommand` is
 * intentionally empty - the pipeline detects that and skips the build
 * step entirely (see runBuildPipeline at line 211 in build-pipeline.ts).
 */
export async function ensureWebmailProject(
  organizationId: string,
  mailServerId: string,
  releaseDistPath: string,
): Promise<{ projectId: string; appId: string; project: Project }> {
  const slug = `webmail-${mailServerId}`;

  // Fixed config - the user can't edit these on the project row, and we
  // reconcile every deploy.
  //
  // Layout of the shipped dist (see apps/email/scripts/build-release.ts):
  //   <remoteDir>/
  //     package.json        ← release orchestration
  //     client/             ← pre-built SPA (no node_modules)
  //     server/
  //       package.json      ← runtime deps only
  //       src/              ← bun runs TS directly
  //       tsconfig.json
  //
  // installCommand:  `cd server && bun install --production` - only the
  //                  server has deps (client is already bundled).
  // buildCommand:    empty - there's nothing to build on the target.
  // startCommand:    `CLIENT_BUILD_DIR=...` points the server at the
  //                  bundled SPA so it can serve /* as static files.
  const WEBMAIL_CONFIG = {
    framework: "webmail",
    packageManager: "bun",
    // --frozen-lockfile fails the install if the dist's bun.lock and
    // package.json drift - better to error loudly than to silently
    // resolve to a different version on the target (we hit that exact
    // bug when shipping without a lockfile: `^0.3.4` resolved to 0.4.2
    // on the target, breaking the peer-dep contract).
    installCommand: "cd server && bun install --production --frozen-lockfile",
    buildCommand: "",
    outputDirectory: "",
    startCommand: 'CLIENT_BUILD_DIR="$PWD/client" bun run server/src/main.ts',
    productionMode: "host" as const,
    port: DEFAULT_INTERNAL_PORT,
    hasServer: true,
    // hasBuild gates BOTH install and build in the build-config factory
    // (`installCommand: hasBuild ? cmd : ""`). Webmail has no build step
    // (`buildCommand: ""`) but it DOES need an install - `bun install`
    // resolves runtime deps in `server/` against the shipped lockfile.
    // So we set hasBuild=true to let install through. buildCommand="" is
    // honored downstream and the build step is cleanly skipped.
    hasBuild: true,
    buildImage: "oven/bun:latest",
    localPath: releaseDistPath,
  };

  // Webmail slug is `webmail-<mailServerId>` which is deterministically
  // unique per mail server, but the row must also be scoped to the active
  // org so a different org redeploying webmail against its own mail server
  // creates a fresh project row instead of finding a cross-org one.
  //
  // Look up by globally-unique slug, then assert org ownership. If the
  // existing row belongs to a different org, treat it as "not found" and
  // create a fresh one — assertResourceInOrg throws NotFoundError for
  // out-of-org rows, which we catch and fall through to create.
  let app = await repos.projectApp.findFirstBySlug(slug);
  if (app && app.organizationId !== organizationId) {
    app = undefined;
  }
  if (!app) {
    app = await repos.projectApp.create({
      organizationId,
      name: PROJECT_NAME,
      slug,
    });
  }

  let project = await repos.project.findFirstBySlug(slug);
  if (project && project.organizationId !== organizationId) {
    project = undefined;
  }
  if (!project) {
    project = await repos.project.create({
      organizationId,
      appId: app.id,
      name: PROJECT_NAME,
      slug,
      environmentName: "Production",
      environmentSlug: "production",
      environmentType: "production",
      ...WEBMAIL_CONFIG,
    });
  } else {
    // Defensive: confirm the row really is in this org before we mutate it.
    // findFirstBySlug is unscoped so we double-check here.
    assertResourceInOrg(project, "Project", organizationId, project.id);
    // Reconcile every deploy: fixed commands aren't user-editable, so a
    // divergence means we shipped a change since this row was created.
    const diverged = (Object.keys(WEBMAIL_CONFIG) as Array<keyof typeof WEBMAIL_CONFIG>).some(
      (k) => (project as Record<string, unknown>)[k] !== WEBMAIL_CONFIG[k],
    );
    if (diverged) {
      await repos.project.update(project.id, WEBMAIL_CONFIG);
      project = { ...project, ...WEBMAIL_CONFIG };
    }
  }

  return { projectId: project.id, appId: app.id, project };
}

// ─── Deploy lifecycle ────────────────────────────────────────────────────────

/**
 * Where to run the webmail. Discriminated union - `self` for a
 * user-managed openship server, `cloud` for Opshcloud.
 */
export type WebmailDeployTarget =
  | { kind: "self"; serverId: string }
  | { kind: "cloud" };

export interface StartWebmailDeployInput {
  userId: string;
  organizationId: string;
  mailServerId: string;
  hostname: string;
  internalPort?: number;
  target: WebmailDeployTarget;
}

export interface StartWebmailDeployResult {
  deploymentId: string;
  projectId: string;
}

/**
 * Drive a webmail deploy through the standard project pipeline.
 *
 * Flow:
 *   1. Locate the pre-built dist at `apps/email/dist/` (fail-fast if absent).
 *   2. Reconcile the project row to that dist + the fixed webmail config.
 *   3. Sync the project route (hostname → OpenResty + Let's Encrypt).
 *   4. Mint / reuse the branding token + session key in mail-state.
 *   5. Ensure persistent dirs on the target (/var/lib/openship-webmail).
 *   6. Build the env map (PORT, COOKIE_DOMAIN, IMAP/SMTP, secrets…).
 *   7. Snapshot from the project, override deploy-target picker bits,
 *      pin `buildStrategy = "server"` (the pipeline's "ship the source
 *      tree to the target as-is" mode - we're shipping the dist, not
 *      building anything).
 *   8. Preflight - port availability, hostname validity, required fields.
 *   9. `createQueuedDeployment` + `startBuild`.
 *
 * The pipeline's build step is a no-op for webmail: the project's
 * `buildCommand` is empty so `runBuildPipeline` skips it (see
 * build-pipeline.ts:211). Install runs in `server/` only (just runtime
 * deps), then start boots `bun run server/src/main.ts` which serves the
 * bundled `client/` next to it as static files.
 */
export async function startWebmailDeploy(
  input: StartWebmailDeployInput,
): Promise<StartWebmailDeployResult> {
  const internalPort = input.internalPort ?? DEFAULT_INTERNAL_PORT;
  const publicUrl = `https://${input.hostname}/`;
  const publicOrigin = `https://${input.hostname}`;

  // ── 1. Locate the pre-built webmail dist on the API host. NO build
  //       runs here - the dist must already exist (operator runs
  //       `bun run build` in apps/email/ ahead of time). If it doesn't,
  //       fail fast with a clear "build first" message. ───────────────
  const releaseDistPath = resolveWebmailDistDir();

  // ── 2. Project row carries localPath (the dist) + fixed config ──────
  const { project, projectId } = await ensureWebmailProject(
    input.organizationId,
    input.mailServerId,
    releaseDistPath,
  );

  // ── 3. Read mail-state for install domain + reuse existing branding /
  //       session-key secrets. Needed before route sync because the
  //       cloud + mail.<install> case skips custom-domain routing on
  //       the deploy target (the mail VPS proxies for it instead). ───
  const { block: existingState, installDomain: mailInstallDomain } =
    await readExistingWebmailBlock(input.mailServerId);
  if (!mailInstallDomain) {
    // Without the mail VPS's install domain we can't tell Zero where IMAP /
    // SMTP live, and every webmail sign-in would fall back to
    // `mail.<userDomain>` - broken for additional domains, and a TLS-cert
    // mismatch for any user whose domain isn't the install one. Fail fast
    // here rather than ship a webmail that can't authenticate anyone.
    throw new Error(
      "Mail server install state is missing - finish the mail install before deploying webmail.",
    );
  }

  // When the chosen hostname is the mail VPS's own `mail.<install>`
  // subdomain, the DNS A record already pins it to the mail server (for
  // IMAP / SMTP). The operator CAN'T change that record without breaking
  // mail. So if they pick Opshcloud as the target, the cloud workload
  // gets a default *.opsh.io URL and the mail server's OpenResty proxies
  // `mail.<install>` → that URL. No DNS work for the operator.
  //
  // For any OTHER hostname (e.g. `webmail.foo.com`), the operator owns
  // DNS and points it themselves - normal cloud / self-hosted custom
  // domain flow.
  const isOwnMailSubdomain = input.hostname === `mail.${mailInstallDomain}`;
  const useProxyVariant = input.target.kind === "cloud" && isOwnMailSubdomain;

  // ── 4. Project route - for the proxy variant we DON'T register the
  //       hostname against the project (the cloud workload uses opsh.io;
  //       the mail VPS handles the public hostname via its own routing).
  //       Every other case goes through the standard custom-domain path. ─
  const projectDomains = await listProjectRouteRows(project.id);
  const routeState = await syncProjectRouteState(project, {
    projectDomains,
    nextPublicEndpoints: useProxyVariant
      ? [] // no custom domain on the cloud workload - proxy lives on mail VPS
      : [
          {
            port: internalPort,
            customDomain: input.hostname,
            domainType: "custom",
          },
        ],
  });

  // ── 5. Mint / reuse secrets, persist mail-state. `installed` stays
  //       false until the deploy success hook flips it. ─────────────────
  const brandingToken =
    existingState?.brandingToken ?? randomBytes(32).toString("hex");
  const sessionEncryptionKey =
    existingState?.sessionEncryptionKey ?? randomBytes(32).toString("hex");
  const webmailState: MailWebmailState = {
    installed: false,
    target: input.target.kind === "cloud" ? "cloud" : "self",
    targetServerId: input.target.kind === "self" ? input.target.serverId : "",
    hostname: input.hostname,
    url: publicUrl,
    internalPort,
    brandingToken,
    sessionEncryptionKey,
    deployedAt: new Date().toISOString(),
    version: "local",
  };
  await persistWebmailBlock(input.mailServerId, webmailState);

  // ── 6. Persistent dirs on the target - only meaningful for self-hosted
  //       deploys. Cloud runs in an ephemeral container managed by
  //       Opshcloud; persistence there is handled by the cloud platform. ─
  if (input.target.kind === "self") {
    await prepareTarget(input.target.serverId);
  }

  // ── 7. Build the env map in memory. Webmail env vars are fixed by
  //       openship (not user-editable in the project Env Vars UI), so we
  //       bypass the project envVar table and pass them straight to the
  //       deployment - same direct path requestBuildAccess uses for
  //       caller-supplied vars. ACME_EMAIL is read by the SSL feature
  //       installer.
  //
  // IMAP / SMTP coordinates Zero uses to authenticate every sign-in.
  // Pinning to `mail.<installDomain>:993/465` here makes every user's
  // login route to the actual MTA, matching what `test-email.service.ts`
  // and `mail-credentials.service.ts` already use server-side.
  //
  // Public URLs are NOT injected here - the client reads its backend
  // URL from `window.location.origin` at runtime (see
  // client/lib/backend-url.ts). One dist, any hostname.
  //
  // SQLITE / BRANDING paths only point at the persistent host dir for
  // self-hosted deploys. Cloud writes to the container-local filesystem
  // (the cloud platform owns its own state layer); the defaults baked
  // into env.ts (`./data/...`) apply when these are omitted.
  const mailHost = `mail.${mailInstallDomain}`;
  const plainEnvMap: Record<string, string> = {
    PORT: String(internalPort),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    COOKIE_DOMAIN: input.hostname,
    TRUSTED_ORIGINS: publicOrigin,
    SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
    BRANDING_ADMIN_TOKEN: brandingToken,
    DEFAULT_IMAP_HOST: mailHost,
    DEFAULT_IMAP_PORT: "993",
    DEFAULT_SMTP_HOST: mailHost,
    DEFAULT_SMTP_PORT: "465",
    ACME_EMAIL: deriveAcmeEmail(input.hostname),
  };
  if (input.target.kind === "self") {
    plainEnvMap.SQLITE_PATH = REMOTE_SQLITE_PATH;
    plainEnvMap.BRANDING_PATH = REMOTE_BRANDING_DIR;
  }

  // ── 8. Snapshot - same helper requestBuildAccess uses. The project row
  //       owns build/install/start commands + port + localPath. We only
  //       override the deploy-target picker bits the normal UI exposes. ──
  const snapshot = buildConfigSnapshot(project, "main");
  snapshot.serviceDeploymentMode = "single";
  // `"server"` build strategy: image build happens at the deploy target
  // (target host via dockerode-over-SSH for self-hosted, or the cloud
  // platform's builder for cloud). `buildCommand` is empty so the
  // Dockerfile only runs `bun install` before EXPOSE/CMD.
  snapshot.buildStrategy = "server";

  if (input.target.kind === "cloud") {
    // Cloud uses Opshcloud's runtime (docker-in-cloud). Custom domain
    // routing is handled by the cloud platform when `useProxyVariant` is
    // false (operator-owned domain → CNAME to opsh.io). When it IS true,
    // we don't pass the hostname here - the cloud workload accepts the
    // opsh.io subdomain, and the mail VPS proxies the public hostname.
    snapshot.deployTarget = "cloud";
    snapshot.runtimeMode = "docker";
  } else {
    // Self-hosted: image built + run on the operator's server. Docker
    // is the sandbox; the existing routing/SSL pipeline handles the
    // hostname directly.
    snapshot.deployTarget = "server";
    snapshot.serverId = input.target.serverId;
    snapshot.runtimeMode = "docker";
  }

  // ── 9. Preflight - same call for both targets. The preflight dispatcher
  //       in deployments/preflight.ts branches on snapshot.deployTarget
  //       (cloud-side checks domain availability via Oblien, self-hosted
  //       checks port availability + SSH reachability). ─────────────────
  await runDeploymentPreflight(snapshot, routeState, { userId: input.userId });

  // ── 9. Encrypt + attach the env map directly to the deployment row.
  //       executeBuildAndDeploy reads dep.envVars, decrypts, and feeds
  //       them to runtime.build + runtime.deploy. ──────────────────────
  const dep = await createQueuedDeployment({
    projectId,
    userId: input.userId,
    organizationId: input.organizationId,
    branch: "main",
    environment: "production",
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptEnvVars(plainEnvMap),
    trigger: "manual",
  });

  // Fire-and-forget - the standard pipeline owns logging, SSE, lifecycle.
  await startBuild(dep.id, input.userId);

  return { deploymentId: dep.id, projectId };
}


