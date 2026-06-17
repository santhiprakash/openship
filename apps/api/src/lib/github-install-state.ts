/**
 * @module github-install-state
 *
 * One-time state tokens for the GitHub App install flow.
 *
 * Used by ONE consumer:
 *
 *   POST /api/cloud/github/install-url issues a token via issueInstallState.
 *   The token is embedded in the GitHub install URL (`?state=<token>`),
 *   GitHub preserves it through the install flow, and posts it back to
 *   the App's Setup URL → /api/cloud/github/install-callback, where
 *   peekAndConsumeInstallState recovers the userId that started the flow.
 *   The callback then writes the gitInstallation row via App-JWT lookup,
 *   without requiring a Better Auth session on the popup browser.
 *
 * SECURITY model:
 *   - Token is 16 random bytes (128 bits) → no practical brute force.
 *   - Single-use: peekAndConsumeInstallState deletes the row as part
 *     of reading it (atomic via EphemeralStore's check-and-clear).
 *   - 5-minute TTL.
 *
 * Storage: backed by EphemeralStore<InstallStateRow> — in-memory by
 * default, swappable to Redis for multi-replica SaaS without touching
 * call sites. See lib/ephemeral-store.ts.
 *
 * In the OAuth-first flow the webhook does NOT use this module any
 * more — the Connect flow runs OAuth BEFORE returning the install URL,
 * so the install webhook resolves the user via findUserByGitHubId
 * against Better Auth's account table. The previous TOFU fallback
 * (claimMostRecentInstallState) was deleted because it's no longer
 * needed and was racy under concurrent installs.
 */

import { createEphemeralStore } from "./ephemeral-store";

interface InstallStateRow {
  userId: string;
}

const INSTALL_STATE_TTL_MS = 5 * 60 * 1000;
const store = createEphemeralStore<InstallStateRow>();

/**
 * Mint a one-shot state token bound to `userId`. Caller embeds the
 * returned token in GitHub's install URL via `?state=<token>`.
 */
export async function issueInstallState(userId: string): Promise<string> {
  return store.issue({ userId }, { ttlMs: INSTALL_STATE_TTL_MS });
}

/**
 * Verify + burn a state token. Returns the row's userId if the row
 * existed and was unexpired, else null. Always deletes the row
 * (single-use).
 *
 * Used by /install-callback — the user's browser arrives anonymously
 * via github.com redirect (no SaaS session cookie), so the 16-byte
 * random state IS the entire binding.
 */
export async function peekAndConsumeInstallState(
  state: string,
): Promise<{ userId: string } | null> {
  return store.consume(state);
}

/** Test-only: clear all state. */
export function _resetInstallStateForTests(): void {
  store._reset?.();
}
