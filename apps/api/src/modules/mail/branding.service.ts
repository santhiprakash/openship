/**
 * Branding (white-label) - HTTP proxy to the Zero webmail server.
 *
 * The Zero server owns branding storage end-to-end: it serves
 * `/branding.json` publicly for the login page and accepts authenticated
 * `PATCH /admin/branding` writes from openship. Openship doesn't touch
 * the file directly - that's important because the Zero server may run
 * on a different host than the iRedMail VPS (Cloudflare Pages SSR
 * worker + a Bun host vs. the Postfix/Dovecot box). SSHing the iRedMail
 * VPS to write a file that lives on a different machine would silently
 * succeed and never reach the user.
 *
 * Wire path:
 *   dashboard → openship API (this file) → Zero server `/admin/branding`
 *
 * Auth: shared `MAIL_WEBMAIL_ADMIN_TOKEN` (env on openship) ===
 *       `BRANDING_ADMIN_TOKEN` (env on Zero). The token never leaves
 *       openship's process - the dashboard authenticates to openship
 *       with its normal session, openship authenticates to Zero with
 *       the token.
 *
 * The serverId argument is currently unused (single Zero deployment
 * per openship). Kept in the API for future per-server multi-tenancy
 * without changing call sites.
 */

import { env } from "../../config";
import { safeErrorMessage } from "@repo/core";

export interface Branding {
  siteTitle: string;
  siteDescription: string;
  loginHeading: string;
  loginSubtext: string;
  loginFooter: string;
  homeHtml: string | null;
}

export class BrandingUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandingUnreachableError";
  }
}

export class BrandingUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandingUnauthorizedError";
  }
}

function adminUrl(): string {
  // No trailing slash - Zero mounts `/admin/branding` directly.
  return `${env.MAIL_WEBMAIL_URL.replace(/\/$/, "")}/admin/branding`;
}

function publicUrl(): string {
  return `${env.MAIL_WEBMAIL_URL.replace(/\/$/, "")}/branding.json`;
}

function requireToken(): string {
  const t = env.MAIL_WEBMAIL_ADMIN_TOKEN;
  if (!t) {
    throw new Error(
      "MAIL_WEBMAIL_ADMIN_TOKEN is not set - branding writes require the shared admin token configured on the Zero webmail server",
    );
  }
  return t;
}

/**
 * Read current branding. Uses the public endpoint so it works even
 * if the admin token isn't set yet - useful in fresh installs where
 * the operator hasn't wired the secret across both services.
 */
export async function getBranding(_serverId: string): Promise<Branding> {
  let res: Response;
  try {
    res = await fetch(publicUrl(), { method: "GET" });
  } catch (err) {
    throw new BrandingUnreachableError(
      `Could not reach Zero webmail server at ${env.MAIL_WEBMAIL_URL}: ${
        safeErrorMessage(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new BrandingUnreachableError(
      `Zero webmail returned ${res.status} fetching branding`,
    );
  }
  return (await res.json()) as Branding;
}

export async function updateBranding(
  _serverId: string,
  patch: Partial<Branding>,
): Promise<Branding> {
  const token = requireToken();
  let res: Response;
  try {
    res = await fetch(adminUrl(), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Branding-Admin-Token": token,
      },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    throw new BrandingUnreachableError(
      `Could not reach Zero webmail server at ${env.MAIL_WEBMAIL_URL}: ${
        safeErrorMessage(err)
      }`,
    );
  }
  if (res.status === 401) {
    throw new BrandingUnauthorizedError(
      "Zero webmail rejected the admin token - check MAIL_WEBMAIL_ADMIN_TOKEN matches the server's BRANDING_ADMIN_TOKEN",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zero webmail returned ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { branding: Branding };
  return body.branding;
}
