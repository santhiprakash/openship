import { createPlatform, type CloudRuntime } from "@repo/adapters";
import { getOblienClient, issueNamespaceToken } from "./openship-cloud";
import { getRoutingBaseDomain } from "./routing-domains";
import { safeErrorMessage } from "@repo/core";

export interface CloudPreflightData {
  runtime: { ok: boolean; message?: string };
  slug?: { available: boolean; message?: string };
  customDomain?: { verified: boolean; message?: string };
}

/**
 * Cloud deployment preflight.
 *
 * Runs only inside the SaaS API (mounted via `cloudSaasRoutes`), so we
 * always have master credentials on hand. Each check uses the right
 * scope:
 *
 *   - `runtime` + `getQuota`  → namespace-scoped client (quota lives
 *                               inside the user's namespace).
 *   - `slug` check            → MASTER client. Availability on the
 *                               shared `.opsh.io` zone is an
 *                               account-level read; namespace tokens
 *                               may be rejected (same scope rule that
 *                               required the `pages.create` SaaS
 *                               proxy). Hitting Oblien directly with
 *                               the master client makes this check
 *                               actually authoritative.
 *   - `customDomain`          → namespace-scoped client (DNS records
 *                               are tied to the user's namespace).
 *
 * Errors are NO LONGER silently treated as "available". If the check
 * truly fails (network blip, Oblien outage), we surface
 * `available: false` with a "couldn't verify" message — fail-closed
 * so the user picks a different slug or retries instead of investing
 * minutes in a build that ends with "slug already taken."
 */
export async function runCloudPreflight(
  userId: string,
  opts: { slug?: string; customDomain?: string },
): Promise<CloudPreflightData> {
  const baseDomain = getRoutingBaseDomain();

  // ── Namespace-scoped checks: quota + custom domain DNS ──
  let cloud: CloudRuntime | null = null;
  let runtimeError: string | null = null;
  try {
    const token = await issueNamespaceToken(userId);
    const cloudPlatform = await createPlatform({ target: "cloud", cloudToken: token.token });
    cloud = cloudPlatform.runtime as CloudRuntime;
    await cloud.getQuota();
  } catch (err) {
    runtimeError = safeErrorMessage(err);
  }

  const result: CloudPreflightData = {
    runtime: runtimeError
      ? { ok: false, message: `Cannot connect to cloud runtime: ${runtimeError}` }
      : { ok: true },
  };

  // ── Slug availability on the shared zone — MASTER client ──
  if (opts.slug) {
    try {
      const master = getOblienClient();
      const slug = await master.domain.checkSlug({ slug: opts.slug, domain: baseDomain });
      result.slug = slug.available
        ? { available: true }
        : {
            available: false,
            message: `"${opts.slug}.${baseDomain}" is already taken. Choose a different subdomain.`,
          };
    } catch (err) {
      const message = safeErrorMessage(err);
      console.error("[CLOUD] Preflight slug check failed", { slug: opts.slug, error: message });
      // Fail closed — the user should pick a different slug rather than
      // discover the conflict mid-build.
      result.slug = {
        available: false,
        message: `Couldn't verify "${opts.slug}.${baseDomain}" availability. Try again or pick a different subdomain.`,
      };
    }
  }

  // ── Custom domain DNS — namespace-scoped (skipped if runtime down) ──
  if (opts.customDomain && cloud) {
    try {
      const verified = await cloud.verifyDomain(opts.customDomain);
      result.customDomain = verified.verified
        ? { verified: true }
        : {
            verified: false,
            message: verified.errors.length > 0
              ? verified.errors.join("; ")
              : `DNS not configured for ${opts.customDomain}. Add a CNAME record pointing to ${verified.requiredRecords.cname.target}`,
          };
    } catch (err) {
      const message = safeErrorMessage(err);
      console.error("[CLOUD] Preflight custom domain check failed", { domain: opts.customDomain, error: message });
      result.customDomain = {
        verified: false,
        message: `Couldn't verify ${opts.customDomain}. Try again or fix DNS first.`,
      };
    }
  } else if (opts.customDomain && !cloud) {
    result.customDomain = {
      verified: false,
      message: "Cloud runtime unreachable — couldn't verify DNS.",
    };
  }

  return result;
}