/**
 * Interactive setup — what runs when you type `openship` with no subcommand.
 *
 * The one-command self-deploy: ask a few questions, then reuse the exact
 * `openship up` pipeline (prebuilt API + dashboard, no build) to install
 * Openship as a boot service, create the first admin, and — reusing Openship's
 * OWN app + domain pipeline — register the control plane as an **app** (it shows
 * up under Apps) with a domain:
 *   - Free   name.opsh.io  → Openship Cloud edge (Oblien); connects Cloud in-flow
 *   - Custom your-domain   → OpenResty + a free Let's Encrypt cert on this box
 *   - BYO    your-domain   → you run your own reverse proxy in front
 *
 * No new deploy machinery — Openship deploys itself with its own tools.
 * UI is @clack/prompts (modern, keyboard-driven).
 */

import chalk from "chalk";
import open from "open";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  intro,
  outro,
  text,
  password,
  select,
  spinner,
  note,
  log,
  cancel,
  isCancel,
} from "@clack/prompts";

import { startService, ensureInternalToken, normalizeUrl } from "./up";
import { ensureDashboard } from "../lib/dashboard";
import { serviceStatus, stop as stopService, restart as restartService } from "../lib/service";
import { saveInstanceUrl, readInstanceUrl } from "../lib/ports";

declare const __CLI_VERSION__: string;

/** Exit cleanly on Ctrl-C / Esc; otherwise narrow away clack's cancel symbol. */
function ensure<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/* ── loopback API helpers (internal-token gated) ─────────────────────────── */

async function internalGet(port: string, path: string): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "X-Internal-Token": ensureInternalToken() },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function internalPost(port: string, path: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": ensureInternalToken() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, data: { error: (err as Error).message } };
  }
}

/** POST the first admin to the internal-token-gated bootstrap endpoint. */
async function bootstrapAdmin(
  apiPort: string,
  admin: { name: string; email: string; password: string },
): Promise<{ ok: boolean; message?: string }> {
  const { ok, data } = await internalPost(apiPort, "/api/system/bootstrap-admin", admin);
  if (ok) return { ok: true };
  if (data?.error === "An admin account already exists") return { ok: true, message: "already-exists" };
  return { ok: false, message: data?.error || "failed" };
}

/** Last error line from the service log — surfaced when the API won't boot so the
 *  user sees the real cause (e.g. a locked DB) instead of a bare timeout. */
function lastServiceError(): string | null {
  for (const name of ["up.err.log", "up.log"]) {
    const p = join(homedir(), ".openship", "logs", name);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf8").trim().split("\n");
      const hit = [...lines].reverse().find((l) => /error|locked|EADDRINUSE|throw|cannot/i.test(l));
      if (hit) return hit.trim().slice(0, 200);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function waitHealthy(apiPort: string, seconds = 90): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

/** Poll the dashboard port until it serves — the dist was pre-pulled, so the
 *  service only has to boot it. Best-effort: returns false on timeout (the API
 *  is already healthy; the dashboard just needs another moment). */
async function waitDashboard(dashPort: string, seconds = 45): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${dashPort}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (res.status > 0) return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

/** Best-effort public IP for the A-record hint + edge-proxy target. */
async function detectPublicIp(): Promise<string | null> {
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^[0-9.]+$/.test(ip) || ip.includes(":")) return ip;
    } catch {
      /* try next */
    }
  }
  return null;
}

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Connect the org owner to Openship Cloud via the browser PKCE handshake, then
 * finalize on the loopback API (internal-token gated). Returns the linked cloud
 * account (its email) on success, or null when not linked.
 */
async function connectOpenshipCloud(port: string): Promise<{ email: string | null } | null> {
  const already = await internalGet(port, "/api/system/cloud-status");
  if (already?.connected) {
    log.success(`Already connected to Openship Cloud${already.user?.email ? ` as ${already.user.email}` : ""}.`);
    return { email: already.user?.email ?? null };
  }

  const capsEnv = await internalGet(port, "/api/health/env");
  const cloudApiUrl: string | undefined = capsEnv?.cloudApiUrl;
  if (!cloudApiUrl) {
    log.error("Couldn't discover the Openship Cloud URL — free domain unavailable. Use a custom domain instead.");
    return null;
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  // Loopback listener captures the browser redirect (?code&state).
  const codePromise = new Promise<string | null>((resolve) => {
    // Self-contained, branded result page (this opens in the user's real
    // browser). Distinguishes success vs failure and auto-closes the tab.
    const page = (ok: boolean): string => {
      const icon = ok ? '<path d="M20 6 9 17l-5-5"/>' : '<path d="M18 6 6 18M6 6l12 12"/>';
      const title = ok ? "Connected to Openship Cloud" : "Connection didn’t complete";
      const msg = ok
        ? "Your instance is now linked to your Openship Cloud account."
        : "Something went wrong. Return to your terminal and run the connect step again.";
      return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Openship</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#e7e7ea;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}.card{width:min(92vw,420px);padding:40px 36px;text-align:center}.badge{margin:0 auto 20px;display:grid;place-items:center}svg{width:40px;height:40px}h1{margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:-.2px}p{margin:0;color:#9a9aa2;font-size:14px}.hint{margin-top:22px;font-size:12.5px;color:#6a6a72}</style></head><body><div class="card"><div class="badge"><svg viewBox="0 0 24 24" fill="none" stroke="#e7e7ea" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div><h1>${title}</h1><p>${msg}</p><div class="hint">You can close this tab and return to your terminal.</div></div><script>setTimeout(function(){try{window.close()}catch(e){}},1200)</script></body></html>`;
    };
    const server = createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (!u.pathname.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      const ok = !!(code && gotState === state);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(ok));
      server.close();
      resolve(ok ? code : null);
    });
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const cbPort = (server.address() as AddressInfo).port;
      const redirect = `http://127.0.0.1:${cbPort}/callback`;
      const handoff =
        `${cloudApiUrl.replace(/\/$/, "")}/api/cloud/connect-handoff` +
        `?redirect=${encodeURIComponent(redirect)}&state=${state}&code_challenge=${challenge}`;
      note(handoff, "Open this URL to authorize (opening your browser…)");
      void open(handoff).catch(() => {});
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(null);
    }, 300_000);
  });

  const s = spinner();
  s.start("Waiting for Openship Cloud authorization in your browser");
  const code = await codePromise;
  if (!code) {
    s.stop("Openship Cloud wasn't authorized.", 1);
    return null;
  }
  s.message("Linking this instance to Openship Cloud");
  const res = await internalPost(port, "/api/system/cloud-connect", { code, codeVerifier: verifier });
  if (!res.ok) {
    s.stop(`Couldn't link Openship Cloud: ${res.data?.error || "failed"}`, 1);
    return null;
  }
  s.stop(`Connected to Openship Cloud${res.data?.email ? ` as ${res.data.email}` : ""}.`);
  return { email: res.data?.email ?? null };
}

/** Prompt for a local admin (name / email / password). Used for the self-hosted
 *  paths and as the cloud-path fallback when the browser connect is declined. */
async function promptLocalAdmin(): Promise<{ name: string; email: string; password: string }> {
  const name = ensure(await text({ message: "Your name", validate: (v) => (v?.trim() ? undefined : "Required") })).trim();
  const email = ensure(
    await text({
      message: "Email",
      placeholder: "you@example.com",
      validate: (v) => (v?.includes("@") ? undefined : "Enter a valid email"),
    }),
  )
    .trim()
    .toLowerCase();
  const pw = ensure(
    await password({ message: "Password", validate: (v) => (v && v.length >= 8 ? undefined : "At least 8 characters") }),
  );
  ensure(await password({ message: "Confirm password", validate: (v) => (v === pw ? undefined : "Passwords don't match") }));
  return { name, email, password: pw };
}

/** Consume the self-register SSE stream, driving the spinner until done. */
async function streamProvision(port: string, sessionId: string, s: ReturnType<typeof spinner>): Promise<boolean> {
  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/self-register/stream?id=${sessionId}`, {
      headers: { "X-Internal-Token": ensureInternalToken() },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok || !res.body) return false;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = /event:\s*(.*)/.exec(frame)?.[1]?.trim();
        const dataRaw = /data:\s*([\s\S]*)/.exec(frame)?.[1]?.trim();
        if (!event) continue;
        if (event === "log" && dataRaw) {
          try {
            const d = JSON.parse(dataRaw);
            if (d.message) s.message(String(d.message).replace(/\s+/g, " ").slice(0, 68));
          } catch {
            /* ignore */
          }
        } else if (event === "complete" && dataRaw) {
          try {
            ok = JSON.parse(dataRaw).status === "completed";
          } catch {
            /* ignore */
          }
        } else if (event === "end") {
          return ok;
        }
      }
    }
  } catch {
    return ok;
  }
  return ok;
}

export async function runWizard(): Promise<void> {
  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" setup")}`);
  log.message(
    chalk.dim(
      "Deploy Openship on this machine — a few questions, then it installs itself\nas a service, registers as an app, and prints the URL to log in.",
    ),
  );

  // 1. First-time admin — ALWAYS a local email + password, and the FIRST thing we
  //    ask. This is your instance login; the domain, Openship Cloud link, and every
  //    setting configured afterwards hang off this account. (Connecting Openship
  //    Cloud later only attaches the free domain + mail — it never becomes sign-in.)
  log.message(chalk.dim("First, your instance login (email + password) — this is how you sign in. Domain and Openship Cloud come next and never replace it."));
  const admin = await promptLocalAdmin();
  // Openship Cloud account attached for the free domain — display only, never the login.
  let cloudEmail: string | null = null;

  let publicUrl: string | undefined;
  let behindProxy = false;
  let managedEdge = false;
  // Domain wiring executed AFTER the service + admin are up.
  let domainPlan:
    | { type: "free"; slug: string; publicHost: string }
    | { type: "custom"; hostname: string }
    | { type: "byo"; hostname: string }
    | { type: "none" } = { type: "none" };

  // 2. Reachability + domain (settings that hang off the admin created above) — a
  //    small back-navigable state machine. Clack has no native "back", so each
  //    select offers "← Back" and captured inputs survive re-entry. Produces
  //    publicUrl / behindProxy / managedEdge / domainPlan.
  const canManage = process.platform === "linux";
  const BACK = "__back__";
  let slug = "";
  let customDomainInput = "";
  let byoDomainInput = "";
  let publicHost: string | null = null;

  // The server's public address — edge-proxy target + A-record hint. Auto-detect,
  // and PROMPT when that fails: the free/custom paths REQUIRE it (without it the
  // free registration 400s with "Could not resolve this server's public address").
  async function resolvePublicHost(): Promise<string> {
    if (publicHost) return publicHost;
    const sp = spinner();
    sp.start("Detecting this server's public IP");
    const detected = await detectPublicIp();
    if (detected) {
      sp.stop(`Public IP: ${chalk.bold(detected)}`);
      publicHost = detected;
      return detected;
    }
    sp.stop("Couldn't detect the public IP automatically.", 1);
    publicHost = ensure(
      await text({
        message: "This server's public IP or hostname",
        placeholder: "203.0.113.10",
        validate: (v) => (v?.trim() ? undefined : "Required — the edge proxy routes traffic to this address"),
      }),
    ).trim();
    return publicHost;
  }

  type DomainStage = "reach" | "type" | "free" | "custom" | "byo";
  let stage: DomainStage = "reach";

  log.message(chalk.dim("These are just starting choices — domain, Cloud, team, and the rest are all editable later in Settings."));

  planning: while (true) {
    if (stage === "reach") {
      const reach = ensure(
        await select({
          message: "How should this instance be reachable?",
          // Default to public — most people setting up on a server/VPS want a
          // domain + HTTPS; localhost-only is the deliberate opt-out.
          initialValue: "public",
          options: [
            { value: "public", label: "Public (server / VPS)", hint: "a domain + HTTPS, reachable from anywhere" },
            { value: "private", label: "This machine only", hint: "localhost — no domain, log in on this box" },
          ],
        }),
      );
      if (reach === "private") {
        domainPlan = { type: "none" };
        publicUrl = undefined;
        behindProxy = false;
        managedEdge = false;
        break planning;
      }
      stage = "type";
      continue;
    }

    if (stage === "type") {
      const domainType = ensure(
        await select({
          message: "How do you want a domain + HTTPS?",
          initialValue: "free",
          options: [
            { value: "free", label: "Free domain", hint: "name.opsh.io via Openship Cloud — HTTPS handled for you" },
            ...(canManage
              ? [{ value: "custom", label: "Custom domain", hint: "your domain + free Let's Encrypt on this box" }]
              : []),
            { value: "byo", label: "Bring your own", hint: "your domain, behind your own reverse proxy" },
            { value: BACK, label: "← Back" },
          ],
        }),
      );
      if (domainType === BACK) {
        stage = "reach";
        continue;
      }
      stage = domainType as DomainStage;
      continue;
    }

    if (stage === "free") {
      slug = ensure(
        await text({
          message: "Choose your subdomain",
          placeholder: "my-openship",
          initialValue: slug || undefined,
          validate: (v) => (v && SLUG_RE.test(v.trim().toLowerCase()) ? undefined : "Lowercase letters, digits, hyphens"),
        }),
      )
        .trim()
        .toLowerCase();
      const host = await resolvePublicHost();
      note(
        `${chalk.cyan(`https://${slug}.opsh.io`)}\n\n` +
          `  ${chalk.dim("served via")}  Openship Cloud edge  ${chalk.dim("→")}  ${chalk.cyan(host)}\n\n` +
          chalk.dim("Openship Cloud terminates HTTPS and forwards to this server."),
        "Confirm free domain",
      );
      const go = ensure(
        await select({
          message: "Create this free domain?",
          options: [
            { value: "go", label: "Create it" },
            { value: BACK, label: "← Back", hint: "change subdomain or IP" },
          ],
        }),
      );
      if (go === BACK) {
        stage = "type";
        continue;
      }
      publicUrl = `https://${slug}.opsh.io`;
      behindProxy = true; // Oblien's edge sets a trusted XFF
      domainPlan = { type: "free", slug, publicHost: host };
      break planning;
    }

    if (stage === "custom") {
      const raw = ensure(
        await text({
          message: "Your domain",
          placeholder: "ops.example.com",
          initialValue: customDomainInput || undefined,
          validate: (v) => (v && normalizeUrl(v) ? undefined : "Enter a valid domain"),
        }),
      );
      customDomainInput = raw;
      const url = normalizeUrl(raw)!.replace(/^http:/i, "https:");
      const hostname = new URL(url).hostname;
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        log.warn("Managed HTTPS installs OpenResty + certbot — that needs root. Re-run with sudo if it can't install.");
      }
      const host = await resolvePublicHost();
      note(
        `Add a DNS ${chalk.bold("A record")}:\n\n` +
          `  ${chalk.cyan(hostname)}  →  ${chalk.cyan(host)}\n\n` +
          chalk.dim("HTTPS is issued automatically once DNS resolves (it retries for a couple minutes)."),
        "DNS",
      );
      const go = ensure(
        await select({
          message: "A record added?",
          options: [
            { value: "go", label: "Continue", hint: "HTTPS provisions once DNS resolves — it retries" },
            { value: BACK, label: "← Back", hint: "change the domain" },
          ],
        }),
      );
      if (go === BACK) {
        stage = "type";
        continue;
      }
      publicUrl = url;
      managedEdge = true;
      behindProxy = true; // OpenResty terminates TLS + sets a trusted XFF
      domainPlan = { type: "custom", hostname };
      break planning;
    }

    // stage === "byo"
    const raw = ensure(
      await text({
        message: "Your domain (served behind your proxy)",
        placeholder: "ops.example.com",
        initialValue: byoDomainInput || undefined,
        validate: (v) => (v && normalizeUrl(v) ? undefined : "Enter a valid domain"),
      }),
    );
    byoDomainInput = raw;
    const url = normalizeUrl(raw)!;
    const hostname = new URL(url).hostname;
    if (url.startsWith("http://")) {
      log.warn("Serving over plain HTTP sends passwords in cleartext — put HTTPS in front before real use.");
    }
    note(
      `${chalk.cyan(url)}\n\n` + chalk.dim("Point your reverse proxy at the dashboard port shown at the end."),
      "Confirm",
    );
    const go = ensure(
      await select({
        message: "Continue?",
        options: [
          { value: "go", label: "Continue" },
          { value: BACK, label: "← Back", hint: "change the domain" },
        ],
      }),
    );
    if (go === BACK) {
      stage = "type";
      continue;
    }
    publicUrl = url;
    behindProxy = true;
    domainPlan = { type: "byo", hostname };
    break planning;
  }

  // 3. Deploy Openship as an app — pull the prebuilt DIST from GitHub (no build),
  //    then run it through the SAME `up` service pipeline. The dist pull happens
  //    LIVE here (not hidden in the background service) so you see it; the service
  //    then reuses this exact cached bundle (matched by tag).
  const uiTag = `v${__CLI_VERSION__}`;
  const dl = spinner();
  dl.start("Pulling the Openship dist from GitHub");
  try {
    await ensureDashboard({
      tag: uiTag,
      onProgress: (received, total) => {
        if (total) dl.message(`Pulling the Openship dist from GitHub — ${Math.round((received / total) * 100)}%`);
      },
    });
    dl.stop("Openship dist ready.");
  } catch (e) {
    dl.stop(`Couldn't pull the Openship dist: ${(e as Error).message}`, 1);
    log.info("Check your network / that this release published its dashboard asset, then re-run `openship`.");
    process.exit(1);
  }

  const s = spinner();
  s.start("Installing Openship as a service");
  let started: { port: string; dashPort: string; publicUrl?: string };
  try {
    started = await startService(
      { publicUrl, trustProxy: behindProxy, managedEdge, acmeEmail: managedEdge ? admin.email : undefined, uiVersion: uiTag },
      { quiet: true },
    );
  } catch (e) {
    s.stop("Couldn't install the service.", 1);
    log.error((e as Error).message);
    log.info("Run `openship up --foreground` to run it attached and see the error.");
    process.exit(1);
  }

  s.message("Waiting for the Openship API");
  if (!(await waitHealthy(started.port))) {
    s.stop("Openship didn't become healthy in time.", 1);
    const reason = lastServiceError();
    if (reason) log.error(reason);
    if (reason && /lock/i.test(reason)) {
      log.info("The database is locked by another instance — run `openship stop`, then re-run `openship`.");
    } else {
      log.info("Check logs: `openship logs` (or `openship up --foreground`).");
    }
    process.exit(1);
  }

  // Always create the local admin now — before any cloud connect — so the instance
  // login is the email + password you set, never derived from Openship Cloud.
  s.message("Creating your admin account");
  const adminRes = await bootstrapAdmin(started.port, admin);
  if (!adminRes.ok) {
    s.stop(`Couldn't create the admin account: ${adminRes.message}`, 1);
    process.exit(1);
  }
  if (adminRes.message === "already-exists") {
    // This data dir already had an admin (a re-run, or a prior cloud/dirty setup).
    // bootstrap-admin is one-shot and won't touch it, so force the box to LOCAL
    // login with the credentials just entered — reset sets the password, revokes
    // stale sessions, and flips authMode back to local. Without this, a box that
    // was previously cloud-linked keeps showing "Sign in with Openship" instead of
    // the email + password form.
    s.message("Applying your admin login");
    const rr = await internalPost(started.port, "/api/system/reset-admin-password", {
      email: admin.email,
      name: admin.name,
      password: admin.password,
    });
    if (!rr.ok) {
      s.stop(`Couldn't set your admin login: ${rr.data?.error || "failed"}`, 1);
      process.exit(1);
    }
  }
  s.message(`Admin ready for ${admin.email}`);

  // The dist is already cached, so the dashboard only has to boot. Wait for it so
  // "live" is truthful (best-effort — the API already serves regardless).
  s.message("Starting the Openship dashboard");
  await waitDashboard(started.dashPort);
  s.stop("Deployed.");

  // 4. Register the control plane as an app + attach its domain (reuse Openship's
  //    own app + domain pipeline). Runs for every mode so it shows under Apps.
  let liveUrl = publicUrl ?? `http://localhost:${started.dashPort}`;
  const port = started.port;

  if (domainPlan.type === "free") {
    // Connect Openship Cloud — a SEPARATE step from login. Authorize in the browser
    // (link printed on the terminal); it only attaches the free .opsh.io domain +
    // mail. The backend links it to the local admin already created above WITHOUT
    // changing the login method. If declined, the box still works on your local
    // login — we just skip the free domain.
    const cloud = await connectOpenshipCloud(port);
    if (!cloud) {
      log.warn("Openship Cloud wasn't connected — skipping the free domain. Your local admin login still works; add the domain later in Settings → Cloud.");
      await internalPost(port, "/api/system/self-register", { domainType: "byo" });
    } else {
      cloudEmail = cloud.email;
      // Availability is only knowable now (cloud is connected) — so surface it
      // here: on a taken/invalid subdomain, re-prompt and retry instead of
      // dead-ending. The public host is guaranteed set (resolvePublicHost).
      let regSlug = domainPlan.slug;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const s2 = spinner();
        s2.start(`Registering ${chalk.bold(`${regSlug}.opsh.io`)} with Openship Cloud`);
        const res = await internalPost(port, "/api/system/self-register", {
          domainType: "free",
          slug: regSlug,
          publicHost: domainPlan.publicHost,
          dashPort: Number(started.dashPort),
        });
        if (res.ok && res.data?.url) {
          liveUrl = res.data.url;
          s2.stop(`Free domain live: ${res.data.url}`);
          break;
        }
        s2.stop(`Couldn't register ${regSlug}.opsh.io: ${res.data?.error || "failed"}`, 1);
        const next = ensure(
          await select({
            message: "Try a different subdomain?",
            options: [
              { value: "retry", label: "Pick another subdomain" },
              { value: "skip", label: "Skip for now", hint: "log in on this server; add a domain later in Settings → Cloud" },
            ],
          }),
        );
        if (next === "skip") break;
        regSlug = ensure(
          await text({
            message: "Choose your subdomain",
            placeholder: "my-openship",
            initialValue: regSlug,
            validate: (v) => (v && SLUG_RE.test(v.trim().toLowerCase()) ? undefined : "Lowercase letters, digits, hyphens"),
          }),
        )
          .trim()
          .toLowerCase();
      }
    }
  } else if (domainPlan.type === "custom") {
    // Managed HTTPS needs ports 80/443. If an existing proxy already owns them,
    // ask before taking over — never silently kill someone's running service.
    let edgeTakeover = false;
    let edgeMigrate = false;
    let proceedCustom = true;
    const pf = await internalPost(port, "/api/system/self-edge/preflight", {});
    const status = pf.ok
      ? (pf.data?.status as
          | { classification: string; canProceedClean: boolean; occupants: Array<{ command?: string; port: number }> }
          | undefined)
      : undefined;
    const importable = pf.ok && Array.isArray(pf.data?.sites) ? (pf.data.sites as unknown[]).length : 0;
    if (status && !status.canProceedClean && status.occupants?.length) {
      const owner = status.occupants.map((o) => o.command ?? `port ${o.port}`).join(", ");
      const known = status.classification === "known";
      const choice = ensure(
        await select({
          message: known
            ? `An existing reverse proxy (${owner}) is serving ports 80/443.`
            : `Ports 80/443 are in use by ${owner}, which we couldn't identify.`,
          options: [
            ...(importable > 0
              ? [{
                  value: "migrate",
                  label: `Migrate ${importable} site${importable === 1 ? "" : "s"} & take over`,
                  hint: "import the existing sites into Openship, then take 80/443",
                }]
              : []),
            {
              value: "override",
              label: "Stop it & take over 80/443",
              hint: known ? "the existing sites stop being served" : "may interrupt a running service",
            },
            { value: "cancel", label: "Cancel — leave it running" },
          ],
          // Per product decision: unknown owner pre-selects takeover; a known
          // proxy defaults to cancel so the user chooses deliberately.
          initialValue: known ? "cancel" : "override",
        }),
      );
      if (choice === "cancel") proceedCustom = false;
      else if (choice === "migrate") edgeMigrate = true;
      else edgeTakeover = true;
    }

    if (!proceedCustom) {
      log.warn(
        "Left the existing proxy on 80/443 running. Registering Openship without managed HTTPS — " +
          "front it with your proxy, or re-run setup to take over.",
      );
      await internalPost(port, "/api/system/self-register", {
        domainType: "byo",
        hostname: domainPlan.hostname,
      });
      liveUrl = `https://${domainPlan.hostname}`;
    } else {
      const res = await internalPost(port, "/api/system/self-register", {
        domainType: "custom",
        hostname: domainPlan.hostname,
        dashPort: Number(started.dashPort),
        acmeEmail: admin?.email,
        edgeTakeover,
        edgeMigrate,
      });
      if (res.ok && res.data?.sessionId) {
        const s2 = spinner();
        s2.start("Issuing HTTPS certificate (OpenResty + Let's Encrypt)");
        const done = await streamProvision(port, res.data.sessionId, s2);
        liveUrl = res.data.url ?? liveUrl;
        if (done) s2.stop(`HTTPS ready: ${liveUrl}`);
        else s2.stop("HTTPS isn't ready yet — it retries on reboot; the site serves over HTTP meanwhile.", 1);
      } else {
        log.warn(`Couldn't start domain provisioning: ${res.data?.error || "failed"}`);
      }
    }
  } else if (domainPlan.type === "byo") {
    const res = await internalPost(port, "/api/system/self-register", {
      domainType: "byo",
      hostname: domainPlan.hostname,
    });
    if (res.ok && res.data?.url) liveUrl = res.data.url;
  } else {
    // Private — still register as an app so it appears under Apps.
    await internalPost(port, "/api/system/self-register", { domainType: "byo" });
  }

  // Remember the access URL so `openship` (control panel) can show/open it later.
  saveInstanceUrl(liveUrl);

  // Borderless summary (left rail only). A boxed note() sizes to the longest
  // line and doesn't wrap, so long lines (Cloud / the help text) spill past the
  // right border on narrow terminals — the rail-only log.* flows cleanly.
  const pad = (label: string) => chalk.dim(label.padEnd(11));
  log.success(chalk.bold("Openship is live"));
  log.message(
    `${pad("URL")}${chalk.bold(liveUrl)}\n` +
      `${pad("Dashboard")}http://localhost:${started.dashPort}\n` +
      `${pad("API")}http://localhost:${started.port}\n` +
      `${pad("Login")}${admin.email} ${chalk.dim("(email + password you set)")}\n` +
      (cloudEmail
        ? `${pad("Cloud")}${chalk.dim("connected as ")}${cloudEmail}${chalk.dim(" — free domain + mail only")}\n`
        : "") +
      `${pad("Status")}${chalk.green("running")} ${chalk.dim("· service (restarts on boot)")}`,
  );
  log.message(
    chalk.dim("Sign in with the email + password you just set. Openship appears under your Apps.\n") +
      chalk.dim("Change the domain, Openship Cloud, team, and everything else anytime in Settings.\n") +
      chalk.dim(`Locked out? Run ${chalk.reset("openship reset-admin-password")}${chalk.dim(" on this machine — resets your login without signing in.")}`),
  );
  outro(
    domainPlan.type === "byo"
      ? chalk.dim("Point your reverse proxy at the dashboard port above.")
      : chalk.green("Happy shipping."),
  );
}

/** The resolved API/dashboard ports the service last used. */
function storedPorts(): { api?: number; dashboard?: number } {
  const p = join(homedir(), ".openship", "ports.json");
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * Control panel for an ALREADY-SET-UP box — what bare `openship` shows instead of
 * re-running setup once a service is installed. Manage the running instance
 * (open / status / start-stop-restart / reset login / reconfigure) rather than
 * starting over.
 */
export async function runControl(): Promise<void> {
  const svc = serviceStatus();
  const ports = storedPorts();
  const apiPort = String(ports.api ?? 4000);
  const dashUrl = `http://localhost:${ports.dashboard ?? 3001}`;
  const publicUrl = readInstanceUrl();
  // The real front door: the public domain if one was set, else the local dashboard.
  const primaryUrl = publicUrl && !/^https?:\/\/localhost/i.test(publicUrl) ? publicUrl : dashUrl;

  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" control")}`);
  note(
    `${chalk.dim("URL".padEnd(11))}${chalk.bold(primaryUrl)}\n` +
      `${chalk.dim("Service".padEnd(11))}${svc.running ? chalk.green("running") : chalk.yellow("stopped")}\n` +
      `${chalk.dim("Dashboard".padEnd(11))}${dashUrl}\n` +
      (ports.api ? `${chalk.dim("API".padEnd(11))}http://localhost:${ports.api}\n` : "") +
      `${chalk.dim("Manager".padEnd(11))}${svc.kind === "unsupported" ? "none" : svc.kind}`,
    "Openship is already set up",
  );

  const action = ensure(
    await select({
      message: "What would you like to do?",
      options: [
        { value: "open", label: "Open the dashboard" },
        svc.running
          ? { value: "restart", label: "Restart the service" }
          : { value: "start", label: "Start the service" },
        { value: "stop", label: "Stop the service", hint: "won't restart on boot" },
        { value: "reset", label: "Reset admin password", hint: "sets a local email + password login" },
        { value: "reconfigure", label: "Re-run setup", hint: "reconfigure domain / cloud / admin" },
        { value: "quit", label: "Quit" },
      ],
    }),
  );

  switch (action) {
    case "open":
      await open(primaryUrl).catch(() => {});
      outro(chalk.dim(`Opening ${primaryUrl}`));
      return;
    case "start":
      await startService({});
      return;
    case "restart": {
      const r = restartService();
      outro(r.restarted ? chalk.green("Restarted.") : chalk.yellow(r.detail));
      return;
    }
    case "stop": {
      const r = stopService();
      outro(chalk.green(`Stopped. ${chalk.dim(r.detail)}`));
      return;
    }
    case "reset": {
      const pw = ensure(
        await password({ message: "New admin password", validate: (v) => (v && v.length >= 8 ? undefined : "At least 8 characters") }),
      );
      const rr = await internalPost(apiPort, "/api/system/reset-admin-password", { password: pw });
      outro(
        rr.ok
          ? chalk.green(`Password reset. Sign in at ${dashUrl} with your email + new password.`)
          : chalk.red(`Couldn't reset: ${rr.data?.error || "failed"}`),
      );
      return;
    }
    case "reconfigure":
      await runWizard();
      return;
    default:
      outro(chalk.dim("Nothing changed."));
  }
}
