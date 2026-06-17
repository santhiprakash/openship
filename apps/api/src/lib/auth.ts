import { betterAuth, type User } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { createAccessControl } from "better-auth/plugins/access";
import { db, getDriver, repos, schema } from "@repo/db";
import { env, runtimeTarget, trustedOrigins } from "../config/env";
import { sendMail, smtpEnabled } from "./mail";
import {
  resetPasswordEmail,
  verifyEmailTemplate,
  organizationInviteEmail,
} from "./email-templates";
import { memberAudit } from "../modules/audit/member-emitter";
import { provisionUser } from "./provision-user";
import { safeErrorMessage } from "@repo/core";

/**
 * Better Auth organization-plugin access control config.
 *
 * The plugin only accepts roles declared via the access controller in
 * its `roles` option. We register a fourth role, `restricted`, with no
 * default permissions — its access is granted exclusively via
 * resource_grant rows and enforced by apps/api/src/lib/permission.ts.
 *
 * `owner | admin | member` keep their plugin defaults (the AC is only
 * registered here so Better Auth's update-member-role / invite-member
 * validators accept "restricted" as a valid role string).
 */
const ORG_ACCESS_CONTROLLER = createAccessControl(defaultStatements);
// Restricted role: explicitly no plugin-side permissions on org-management
// endpoints (member CRUD, invitation, team). Our own permission.ts
// resolver gates everything else via resource_grant rows. The `newRole`
// generic infers `K extends never` for an empty statements arg, which
// breaks the `Role<any>` constraint on `roles` — so we declare with
// `ac: []` (zero actions on a real key) to land a usable Role type.
const RESTRICTED_ROLE = ORG_ACCESS_CONTROLLER.newRole({ ac: [] });

/**
 * Per-inviter rate limit on the Better Auth organization plugin's
 * invite-member flow. Counts invitations created by this user across all
 * orgs in the last hour; rejects the create if the user is already at or
 * above the cap. Wired in `beforeCreateInvitation` below.
 */
const INVITE_RATE_LIMIT_PER_HOUR = 50;
const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Better Auth - handles registration, login, OAuth, sessions, tokens.
 *
 * Browser clients (dashboard) use httpOnly session cookies.
 * API clients (CLI, external) use Bearer tokens via the session token.
 *
 * Routes are mounted at /api/auth/* in app.ts.
 */
// Cookie prefix - distinct per mode so desktop API (port 4000) and
// SaaS API (port 4100) don't collide on localhost (cookies ignore port).
export const COOKIE_PREFIX = env.CLOUD_MODE ? "openship-cloud" : "openship";

function getSharedCookieDomain() {
  if (env.BETTER_AUTH_COOKIE_DOMAIN) {
    return env.BETTER_AUTH_COOKIE_DOMAIN;
  }

  if (!env.CLOUD_MODE) {
    return undefined;
  }

  const urls = [runtimeTarget.api, runtimeTarget.dashboard];

  for (const value of urls) {
    try {
      const hostname = new URL(value).hostname;
      if (hostname === "openship.io" || hostname.endsWith(".openship.io")) {
        return ".openship.io";
      }
    } catch {
      // Ignore invalid URLs and fall back to host-only cookies.
    }
  }

  return undefined;
}

const sharedCookieDomain = getSharedCookieDomain();
const useSessionCookieCache = getDriver() !== "pglite";

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: runtimeTarget.api,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
    },
  }),

  /* ---------- Email + Password ---------- */
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,

    /* Password reset - only functional when SMTP is configured */
    sendResetPassword: smtpEnabled
      ? async ({ user, url }: { user: User; url: string; token: string }) => {
          const email = resetPasswordEmail(user, url);
          await sendMail({ to: user.email, ...email });
        }
      : undefined,

    /* Email verification - only functional when SMTP is configured */
    requireEmailVerification: smtpEnabled,
    sendVerificationEmail: smtpEnabled
      ? async ({ user, url }: { user: User; url: string; token: string }) => {
          const email = verifyEmailTemplate(user, url);
          await sendMail({ to: user.email, ...email });
        }
      : undefined,
  },

  /* ---------- OAuth Providers ---------- */
  socialProviders: {
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            scope: ["read:user", "user:email"],
            mapProfileToUser: (profile: any) => ({
              name: profile.name || profile.login,
              email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
              image: profile.avatar_url,
            }),
          },
        }
      : {}),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },

  /* ---------- Account Linking ---------- */
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      allowDifferentEmails: true,
      trustedProviders: ["github", "google"],
    },
  },

  /* ---------- Session ---------- */
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60,            // refresh session every hour
    ...(useSessionCookieCache
      ? {
          cookieCache: {
            enabled: true,
            maxAge: 60 * 60 * 24, // cache session in cookie for 24h (avoids DB hit)
          },
        }
      : {}),
  },

  /* ---------- Custom fields on user ---------- */
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        input: false,
      },
      autoProvisioned: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },

  /* ---------- Database hooks ---------- */
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Funnel every Better Auth-mediated signup (email/password,
          // OAuth, etc.) through the same provisioning helper used by
          // the cloud-mirror and zero-auth desktop paths. provisionUser
          // is idempotent — the user already exists at this point, so
          // the upsert is a no-op; only the personal org bootstrap runs.
          await provisionUser({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
          });
        },
      },
    },
  },

  /* ---------- Security ---------- */
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins,

  /* ---------- Advanced ---------- */
  advanced: {
    cookiePrefix: COOKIE_PREFIX,
    ...(sharedCookieDomain
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: sharedCookieDomain,
          },
        }
      : {}),
  },

  /* ---------- Plugins ---------- */
  plugins: [
    /**
     * Bearer auth — accepts `Authorization: Bearer <session.token>` as
     * an alternative to the session cookie. Needed for server-to-server
     * calls into `auth.api.*` from contexts where we hold the raw
     * session token but not a signed cookie (e.g., the GitHub OAuth
     * bridge in cloud-saas.controller.ts that takes a cloud_session_token
     * and calls linkSocialAccount on behalf of the user).
     *
     * Internally signs the token to a cookie format that Better Auth's
     * session-resolver accepts. Without requireSignature=true (the
     * default), raw unsigned tokens are accepted — which is what we
     * want since the local DB stores the raw session.token.
     */
    bearer(),

    /**
     * Multi-user / multi-team via Better Auth's first-party organization
     * plugin. Adds the org/member/invitation tables + endpoints under
     * /api/auth/organization/* (create, invite-member, accept-invitation,
     * set-active, list, update-member-role, remove-member, leave).
     *
     * One user CAN belong to multiple orgs (membersLimit applies per-org).
     * Resources are scoped to organization_id by middleware in
     * apps/api/src/middleware/active-organization.ts.
     */
    organization({
      allowUserToCreateOrganization: true,
      organizationLimit: 10, // per-user cap on org creation
      membershipLimit: 100,  // per-org cap on member count
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 24 * 7, // 7 days
      /**
       * Custom role registration. Better Auth's organization plugin
       * normally only accepts owner/admin/member in update-member-role
       * + invite-member endpoints. We register a fourth role,
       * `restricted`, as a no-default-permissions baseline. Resource-
       * level access is granted via the resource_grant table + checked
       * by apps/api/src/lib/permission.ts — the Better Auth role
       * itself just carries the label.
       */
      ac: ORG_ACCESS_CONTROLLER,
      roles: {
        // The plugin's default roles still apply (owner/admin/member);
        // we only need to declare `restricted` so Better Auth's input
        // validators accept it. The actual permission policy lives in
        // permission.ts, not here.
        restricted: RESTRICTED_ROLE,
      },
      sendInvitationEmail: smtpEnabled
        ? async (data) => {
            const inviteUrl = `${runtimeTarget.dashboard}/accept-invite/${data.id}`;
            const email = organizationInviteEmail({
              invitee: { email: data.email },
              inviter: { name: data.inviter.user.name, email: data.inviter.user.email },
              organizationName: data.organization.name,
              url: inviteUrl,
            });
            await sendMail({ to: data.email, ...email });
          }
        : undefined,

      /**
       * Lifecycle hooks for the org/member/invitation tables.
       *
       * - `beforeCreateInvitation` enforces a per-inviter rate limit
       *   (50 invitations / hour across all orgs) by throwing an APIError
       *   that the plugin surfaces back to the client as a 429.
       * - The `after*` hooks emit forensic audit rows via the
       *   member-emitter wrapper. We use synchronous `audit.record` for
       *   these since losing a member-mutation row is a security gap.
       *
       * Hooks fire OUTSIDE the Hono request cycle so we can't attach
       * IP/UA — the emitter writes them as null. The `actorUserId` is
       * the user the plugin says triggered the event.
       */
      organizationHooks: {
        beforeCreateInvitation: async ({ invitation, inviter }) => {
          // Team-org gate. Personal workspaces (is_team=false) cannot
          // invite anyone, regardless of whether the request came via
          // /invite-with-grants or the raw Better Auth inviteMember
          // endpoint. Hard-fail on missing orgId so a future code path
          // calling the plugin without organization context can't
          // silently bypass the gate.
          const orgId = invitation.organizationId;
          if (!orgId) {
            throw new APIError("BAD_REQUEST", {
              message: "organizationId is required to create an invitation",
              code: "INVITE_MISSING_ORG",
            });
          }
          const isTeam = await repos.organization.isTeam(orgId);
          if (!isTeam) {
            throw new APIError("FORBIDDEN", {
              message:
                "This is a personal workspace. Create a team organization first to invite members.",
              code: "PERSONAL_ORG_NO_INVITE",
            });
          }

          const since = new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS);
          const recent = await repos.invitation.countByInviterSince(inviter.id, since);
          if (recent >= INVITE_RATE_LIMIT_PER_HOUR) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: `Invitation rate limit reached (${INVITE_RATE_LIMIT_PER_HOUR}/hour). Try again later.`,
            });
          }
          // No data override — return void to keep the plugin's defaults.
          void invitation;
        },

        afterCreateOrganization: async ({ organization, user, member }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "organization.created",
              resourceType: "organization",
              resourceId: organization.id,
              after: {
                name: organization.name,
                slug: organization.slug,
                creatorMemberId: member.id,
                creatorRole: member.role,
              },
            },
          );
        },

        afterDeleteOrganization: async ({ organization, user }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "organization.deleted",
              resourceType: "organization",
              resourceId: organization.id,
              before: {
                name: organization.name,
                slug: organization.slug,
              },
            },
          );
        },

        afterAddMember: async ({ member, user, organization }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "member.added",
              resourceType: "member",
              resourceId: member.id,
              after: {
                userId: member.userId,
                role: member.role,
              },
            },
          );
        },

        afterRemoveMember: async ({ member, user, organization }) => {
          // Revoke this member's resource_grant rows on the way out so
          // re-adding them later (e.g. as a fresh restricted member)
          // can't silently inherit prior-tenure access. The permission
          // resolver short-circuits on missing membership, so a
          // stale-grant condition is security-inert in practice — but
          // we audit cleanup failures so the condition is observable
          // instead of just console-logged.
          try {
            await repos.resourceGrant.deleteByMember(organization.id, member.userId);
          } catch (err) {
            const message = safeErrorMessage(err);
            console.error(
              "[organizationHooks.afterRemoveMember] grant cleanup failed:",
              err,
            );
            await memberAudit.emit(
              { organizationId: organization.id, actorUserId: user.id },
              {
                eventType: "member.removal.grant_cleanup_failed",
                resourceType: "member",
                resourceId: member.id,
                after: { userId: member.userId, errorMessage: message.slice(0, 500) },
              },
            );
          }

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "member.removed",
              resourceType: "member",
              resourceId: member.id,
              before: {
                userId: member.userId,
                role: member.role,
              },
            },
          );
        },

        afterUpdateMemberRole: async ({ member, previousRole, user, organization }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "member.role_changed",
              resourceType: "member",
              resourceId: member.id,
              before: { role: previousRole },
              after: { role: member.role, userId: member.userId },
            },
          );
        },

        afterCreateInvitation: async ({ invitation, inviter, organization }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: inviter.id },
            {
              eventType: "invitation.created",
              resourceType: "invitation",
              resourceId: invitation.id,
              after: {
                email: invitation.email,
                role: invitation.role,
                status: invitation.status,
              },
            },
          );
        },

        afterAcceptInvitation: async ({ invitation, user, organization, member }) => {
          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "invitation.accepted",
              resourceType: "invitation",
              resourceId: invitation.id,
              after: {
                email: invitation.email,
                role: invitation.role,
                memberId: member.id,
              },
            },
          );
        },

        afterRejectInvitation: async ({ invitation, user, organization }) => {
          // Better Auth marks the invitation status=rejected but keeps
          // the row — its CASCADE doesn't fire, so any pending grants
          // we stored for this invite would linger as zombies. Wipe them.
          await repos.invitationPendingGrant
            .deleteByInvitation(invitation.id)
            .catch((err: unknown) =>
              console.error("[afterRejectInvitation] pending-grant cleanup failed:", err),
            );

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: user.id },
            {
              eventType: "invitation.rejected",
              resourceType: "invitation",
              resourceId: invitation.id,
              before: {
                email: invitation.email,
                role: invitation.role,
              },
            },
          );
        },

        afterCancelInvitation: async ({ invitation, cancelledBy, organization }) => {
          // Same rationale as reject — pending grants on a canceled
          // invitation become zombie rows otherwise.
          await repos.invitationPendingGrant
            .deleteByInvitation(invitation.id)
            .catch((err: unknown) =>
              console.error("[afterCancelInvitation] pending-grant cleanup failed:", err),
            );

          await memberAudit.emit(
            { organizationId: organization.id, actorUserId: cancelledBy.id },
            {
              eventType: "invitation.cancelled",
              resourceType: "invitation",
              resourceId: invitation.id,
              before: {
                email: invitation.email,
                role: invitation.role,
              },
            },
          );
        },
      },
    }),
  ],
});

export type Auth = typeof auth;
