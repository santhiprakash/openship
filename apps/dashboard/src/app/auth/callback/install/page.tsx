"use client";

import { useEffect } from "react";
import { getApiOrigin } from "@/lib/api/urls";
import { GITHUB_CONNECT_ERROR_KEY } from "@/lib/github-connect-error";

/**
 * OAuth callback for cloud mode - after GitHub OAuth completes,
 * fetches the GitHub App installation URL from the API and redirects.
 *
 * Flow: GitHub OAuth → Better Auth callback → this page → GitHub App install
 */
export default function OAuthCallbackInstall() {
  useEffect(() => {
    // Better Auth appends ?error=<code> on a failed link (e.g. the GitHub
    // account is already linked to a different user). Hand it to the opener
    // via same-origin localStorage and close instead of proceeding to install.
    const linkError = new URLSearchParams(window.location.search).get("error");
    if (linkError) {
      try { localStorage.setItem(GITHUB_CONNECT_ERROR_KEY, linkError); } catch { /* storage unavailable */ }
      window.close();
      return;
    }

    async function redirect() {
      try {
        const BASE = getApiOrigin(window.location.origin);
        const res = await fetch(`${BASE}/api/github/connect`, {
          method: "POST",
          credentials: "include",
        });
        const data = await res.json();

        if (data?.url) {
          window.location.href = data.url;
          return;
        }
      } catch {
        // If fetch fails, just close - the opener will detect it
      }
      window.close();
    }

    redirect();
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">Setting up GitHub access…</p>
    </div>
  );
}
