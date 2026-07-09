import "server-only";
import { cache } from "react";
import { serverApi, ServerApiError } from "./api";

/**
 * Session and user types returned by Better Auth's `/api/auth/get-session`.
 */
export type Session = {
  id: string;
  userId: string;
  expiresAt: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string;
  userAgent?: string;
  /**
   * The org the user is currently scoped to. The session.create.before
   * hook in apps/api/src/lib/auth.ts defaults this to the user's
   * deterministic personal org (`org_${userId}`) and Better Auth's
   * setActive endpoint updates it when the user explicitly chooses.
   * Optional in the type because some legacy / edge-case session rows
   * may not carry it through to the response shape.
   */
  activeOrganizationId?: string | null;
};

export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: string;
  updatedAt: string;
  role: string;
  autoProvisioned?: boolean;
};

export type SessionData = { session: Session; user: User };

/**
 * Get the current session from the API.
 *
 * Wrapped with `React.cache()` so multiple server components
 * calling `getSession()` in the same request share one fetch.
 *
 * Returns the session data or `null` if unauthenticated.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000; // ms

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await serverApi.get<SessionData>("auth/get-session", {
        cache: "no-store",
      });
      return data;
    } catch (err) {
      // 401 = genuinely unauthenticated - no point retrying
      if (err instanceof ServerApiError && err.status === 401) {
        return null;
      }
      // Network / timeout error - API may be restarting, retry
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
        continue;
      }
      // Exhausted retries - return null so the page shows login
      return null;
    }
  }
  return null;
});

/* ------------------------------------------------------------------ */
/*  Deployment info (fetched once, cached in module memory forever)    */
/* ------------------------------------------------------------------ */

export type DeploymentInfo = {
  selfHosted: boolean;
  deployMode: string;
  authMode: "cloud" | "local" | "none";
  cloudAuthUrl: string;
  cloudApiUrl: string;
  machineName?: string;
  hostDomain?: string;
  /**
   * Multi-user migration state. When non-default, the dashboard
   * should render a launcher screen pointing at migrationTargetUrl
   * instead of the normal UI — this instance no longer owns the
   * data and the operator should use the migrated URL.
   */
  teamMode?: "single_user" | "self_hosted_remote" | "cloud_hosted" | "tunneled";
  migrationTargetUrl?: string | null;
  /**
   * True while a migration is mid-flight. The dashboard must render
   * the in-progress launcher (not the normal UI, not the migrated
   * launcher) — the source DB is being cut over and any write would
   * 503. Flips back to false once the cutover finishes.
   */
  migrationInProgress?: boolean;
};

let _deploymentInfo: DeploymentInfo | null = null;
let _deploymentInfoFetchedAt = 0;

/**
 * Deployment info is mostly static, but during desktop onboarding
 * authMode can flip and during dev the API can restart with a
 * different cloud target. Short TTL in dev so a stale value never
 * latches for long; 30s in prod where the values truly are static.
 */
const DEPLOYMENT_INFO_TTL = process.env.NODE_ENV === "production" ? 30_000 : 2_000;

export interface GetDeploymentInfoOptions {
  /**
   * Bypass the module-level cache and re-fetch from the API. Required
   * for any caller that gates UI on `migrationInProgress` — the
   * migration lock can flip true→false (or false→true) faster than the
   * 30s TTL, and a stale cached value will route the operator to the
   * wrong screen during the cutover window. The dashboard layout uses
   * this; everywhere else the cache is fine.
   */
  skipCache?: boolean;
}

/**
 * Fetch /health/env with one short retry on a transient (rate-limit /
 * overload) status. This is a bootstrap call the whole dashboard SSR depends
 * on, so a single blip must not cascade into a login 500. `/health/env` is
 * exempt from the API rate limiter, but the retry is cheap insurance against a
 * momentary 429/503 from any layer in front of it.
 */
async function fetchDeploymentInfoWithRetry(): Promise<DeploymentInfo> {
  try {
    return await serverApi.get<DeploymentInfo>("health/env");
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 429 || status === 503) {
      await new Promise((r) => setTimeout(r, 250));
      return serverApi.get<DeploymentInfo>("health/env");
    }
    throw err;
  }
}

export async function getDeploymentInfo(
  options: GetDeploymentInfoOptions = {},
): Promise<DeploymentInfo> {
  if (
    !options.skipCache &&
    _deploymentInfo &&
    Date.now() - _deploymentInfoFetchedAt < DEPLOYMENT_INFO_TTL
  ) {
    return _deploymentInfo;
  }

  try {
    _deploymentInfo = await fetchDeploymentInfoWithRetry();
    _deploymentInfoFetchedAt = Date.now();
  } catch (err) {
    // Last-known-good beats a transient refetch failure.
    if (_deploymentInfo) {
      return _deploymentInfo;
    }

    // No cache + API unreachable. deployMode/authMode are REQUIRED and only the
    // API knows them — fabricating a value would render the wrong login flow.
    // Fail loud (same philosophy as runtime-config's invalid-target throw)
    // rather than guess; the orchestrator brings the API up before serving the
    // dashboard, so this only fires if the API is genuinely down.
    throw new Error(
      "Cannot resolve deployment info: GET /health/env is unreachable and nothing is cached. " +
        "The dashboard refuses to render with a guessed deploy/auth mode — ensure the API is running.",
      { cause: err },
    );
  }
  return _deploymentInfo;
}
