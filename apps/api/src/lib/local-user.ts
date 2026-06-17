/**
 * Local user — auto-provisioned admin for self-hosted / desktop mode.
 *
 * In zero-auth mode the API trusts 127.0.0.1 traffic (no Better Auth
 * cookie required). Controllers still reference `userId` as a FK, so a
 * real user row must exist. This module lazily provisions one on first
 * access and caches it in-process to avoid a DB roundtrip per request.
 *
 * All user + personal-org creation flows through `provisionUser`, the
 * same helper Better Auth's signup hook + the cloud-mirror path use.
 */

import { randomUUID } from "node:crypto";
import { repos } from "@repo/db";
import { provisionUser } from "./provision-user";

const LOCAL_EMAIL = "local@openship.local";

export interface LocalUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  autoProvisioned: boolean;
}

let cached: LocalUser | null = null;

export async function ensureLocalUser(): Promise<LocalUser> {
  if (cached) return cached;

  const existing = await repos.user.findByEmail(LOCAL_EMAIL);
  const id = existing?.id ?? randomUUID();

  await provisionUser({
    id,
    name: "Local User",
    email: LOCAL_EMAIL,
    emailVerified: true,
    role: "admin",
    autoProvisioned: true,
  });

  const row = await repos.user.findById(id);
  if (!row) throw new Error("Failed to provision local user");

  cached = {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    role: row.role,
    autoProvisioned: row.autoProvisioned,
  };

  return cached;
}
