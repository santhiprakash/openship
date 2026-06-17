/**
 * Single bootstrap point for every user identity in Openship.
 *
 * Every authenticated user MUST end up with:
 *   1. A row in the `user` table (Better Auth's identity record).
 *   2. A personal organization (`org_${userId}`) — so the org-scoping
 *      middleware always has an active org to resolve, even before the
 *      user joins any team.
 *   3. An owner-role `member` row binding them to that personal org.
 *
 * Three flows hit this code path:
 *   - Better Auth signup (email/password + OAuth) via the
 *     `databaseHooks.user.create.after` hook — Better Auth has already
 *     inserted the user, so the user upsert is a no-op and only the org
 *     bootstrap does work.
 *   - Cloud auth mirror (cloud-auth-proxy.mirrorCloudUser) — the user
 *     authenticated against Openship Cloud; we provision a local mirror.
 *   - Desktop zero-auth (local-user.ensureLocalUser) — the API trusts
 *     127.0.0.1 traffic and provisions an admin user lazily on first hit.
 *
 * Atomic: every row goes in via a single `db.transaction(...)`. A
 * process crash mid-flow leaves no half-state.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` on the user PK, the org PK, and
 * the `(organization_id, user_id)` unique index on member. Re-running
 * for an existing user is a clean no-op.
 *
 * Race-safe: concurrent invocations for the same user converge on a
 * single row at each table — no double-membership, no orphan org.
 */

import { db, schema } from "@repo/db";
import { generateId } from "@repo/core";

const { user, organization, member } = schema;

export interface ProvisionUserInput {
  id: string;
  name: string | null | undefined;
  email: string;
  emailVerified?: boolean;
  role?: "admin" | "user";
  autoProvisioned?: boolean;
  image?: string | null;
}

/**
 * Ensure the user row + personal org + owner membership all exist.
 * Returns the personal org id (deterministic: `org_${userId}`).
 *
 * Call from any code path that creates or first-touches a user identity.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<string> {
  const personalOrgId = `org_${input.id}`;
  const displayName = input.name?.trim() || input.email.split("@")[0];
  const slugSeed = input.email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = `ws-${slugSeed}-${input.id.slice(0, 8)}`;

  await db.transaction(async (tx) => {
    await tx
      .insert(user)
      .values({
        id: input.id,
        name: displayName,
        email: input.email,
        emailVerified: input.emailVerified ?? false,
        role: input.role ?? "user",
        autoProvisioned: input.autoProvisioned ?? false,
        image: input.image ?? null,
      })
      .onConflictDoNothing({ target: user.id });

    await tx
      .insert(organization)
      .values({
        id: personalOrgId,
        name: `${displayName}'s workspace`,
        slug,
      })
      .onConflictDoNothing({ target: organization.id });

    await tx
      .insert(member)
      .values({
        id: generateId("mem"),
        organizationId: personalOrgId,
        userId: input.id,
        role: "owner",
      })
      .onConflictDoNothing();
  });

  return personalOrgId;
}
