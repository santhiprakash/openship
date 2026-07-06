/**
 * Cross-window channel for surfacing a GitHub "Connect" link failure.
 *
 * The connect popup lands on an /auth/callback page after Better Auth's OAuth
 * callback. On failure Better Auth appends `?error=<code>`; the callback page
 * stashes that code here (same-origin localStorage) and closes. The opener's
 * post-close handler reads + clears it and shows a toast — otherwise the flow
 * would just silently report "not connected".
 */
export const GITHUB_CONNECT_ERROR_KEY = "openship.github.connectError";

const MESSAGES: Record<string, string> = {
  account_already_linked_to_different_user:
    "That GitHub account is already linked to a different Openship user. Sign in as that user, or disconnect GitHub there first.",
  "email_doesn't_match":
    "Your GitHub email doesn't match this account's email. Connect a GitHub account that uses the same email.",
  email_not_found:
    "GitHub didn't share a usable email. Make your GitHub email public (or verify one) and try again.",
  unable_to_link_account: "Couldn't link your GitHub account. Please try again.",
};

export function githubConnectErrorMessage(code: string | null | undefined): string {
  if (!code) return "Couldn't connect GitHub. Please try again.";
  return MESSAGES[code] ?? `Couldn't connect GitHub (${code}).`;
}
