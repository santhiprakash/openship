/**
 * Cached auth-mode reader.
 *
 * Auth mode is written once during onboarding and rarely changes.
 * Caching avoids a DB hit on every request through authMiddleware.
 *
 * The cache is cleared by setup.controller after any write so that
 * re-onboarding (dev reset) picks up the new value immediately.
 */

import { env } from "../config/env";

let cached: string | null = null;

/**
 * Returns the current auth mode for this instance.
 *
 *   "none"  → zero-auth (auto-provisioned local user, no login required)
 *   "cloud" → cloud-authenticated desktop (Openship Cloud session)
 *   "local" → standard Better Auth (login required)
 *
 * "none" is valid for any DEPLOY_MODE — the operator opts in via the
 * settings endpoint, which is itself gated by OPENSHIP_ALLOW_ZERO_AUTH=true.
 * The safety guardrail that restricts zero-auth to loopback connections is
 * enforced downstream in authMiddleware, not here.
 *
 * Defaults when no instanceSettings.authMode value has been written:
 *   - DEPLOY_MODE=desktop → "none"  (loopback-only Electron, safe by default)
 *   - any other mode      → "local" (require login on a fresh self-hosted install)
 */
export async function getAuthMode(): Promise<"none" | "cloud" | "local"> {
  if (cached !== null) return cached as "none" | "cloud" | "local";

  // Zero-auth ("none") is a desktop-only convenience. A CLI-managed instance
  // (OPENSHIP_REQUIRE_AUTH) or a publicly-served one (OPENSHIP_PUBLIC_URL)
  // always defaults to requiring login — the loopback zero-auth shortcut is
  // unsafe once the box is CLI-deployed / network-reachable via the proxy.
  const requireAuth = !!env.OPENSHIP_REQUIRE_AUTH || !!env.OPENSHIP_PUBLIC_URL;
  const fallback: "none" | "local" =
    env.DEPLOY_MODE === "desktop" && !requireAuth ? "none" : "local";

  try {
    const { repos } = await import("@repo/db");
    const settings = await repos.instanceSettings.get();
    cached = settings?.authMode ?? fallback;
  } catch {
    cached = fallback;
  }

  return cached as "none" | "cloud" | "local";
}

/** Clear the cached value - called after setup.controller writes. */
export function clearAuthModeCache() {
  cached = null;
}
