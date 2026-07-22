/**
 * Cloud route re-application on edit.
 *
 * Editing a route (domain/port) for a cloud project must re-apply the live
 * route, not just persist the DB row. Cloud routing is a runtime concern — the
 * public route is established by the deploy call via Oblien's page / workspace
 * primitives, NOT by the `CloudInfraProvider` routing stub (which only receives
 * `{domain,tls,targetUrl}` and has no page slug / workspace id). So this helper
 * re-runs those same primitives against the project's active deployment handle.
 *
 * Works on the SaaS and on a local instance orchestrating a cloud deploy: the
 * org-scoped token comes from `getOrgCloudToken` either way (same path the
 * deploy runtime uses). No edgeProxy — a cloud project is internal to Oblien
 * (page or workspace), so the edgeProxy ownership-verification handshake is not
 * involved.
 *
 * KNOWN LIMITATION: the workspace SDK has no clean per-domain teardown
 * primitive, so removing an old *managed* (`*.opsh.io`) subdomain on a *dynamic*
 * cloud project can't be re-applied on edit — it clears on the next
 * redeploy/destroy. Custom-domain teardown (static pages) and every apply path
 * do re-apply. `removeCloudProjectRoute` logs the unsupported case rather than
 * swallowing it.
 */

import { Oblien, PAGE_CONTAINER_PREFIX } from "@repo/adapters";
import { repos } from "@repo/db";
import { safeErrorMessage, SYSTEM } from "@repo/core";
import { getOrgCloudToken } from "./cloud/client";

/** Minimal project shape needed to locate the cloud handle. */
export interface CloudRouteProject {
  id: string;
  organizationId: string;
  cloudWorkspaceId: string | null;
  activeDeploymentId: string | null;
}

export interface CloudRouteInput {
  /** Full hostname — `slug.opsh.io` (managed) or `app.example.com` (custom). */
  hostname: string;
  /** Target port on the workspace (dynamic projects). Ignored for static pages. */
  port?: number;
  isCustomDomain: boolean;
}

interface CloudHandle {
  client: Oblien;
  /** `page:{slug}` for a static page, or the workspace id for a dynamic project. */
  containerId: string;
}

/**
 * Resolve the org-scoped Oblien client + the active deployment's cloud handle.
 * Returns null (caller no-ops) when the project isn't cloud, has no active
 * deployment/container, or no org member has linked Openship Cloud.
 */
async function resolveCloudHandle(project: CloudRouteProject): Promise<CloudHandle | null> {
  if (!project.cloudWorkspaceId || !project.activeDeploymentId) return null;

  const deployment = await repos.deployment.findById(project.activeDeploymentId);
  const containerId = deployment?.containerId;
  if (!containerId) return null;

  const tok = await getOrgCloudToken(project.organizationId);
  if (!tok) return null;

  return { client: new Oblien({ token: tok.token }), containerId };
}

function managedSlugFromHostname(hostname: string): string {
  // A cloud project's managed subdomain is always slug.<CLOUD_DOMAIN> (Oblien's
  // opsh.io) — NOT the self-hosted HOST_DOMAIN. Use the cloud constant so this
  // matches the deploy path (which exposes on the same domain).
  const base = `.${SYSTEM.DOMAINS.CLOUD_DOMAIN.toLowerCase()}`;
  const normalized = hostname.trim().toLowerCase();
  return normalized.endsWith(base) ? normalized.slice(0, -base.length) : normalized;
}

/**
 * (Re)apply a single route for a cloud project via its runtime primitives.
 * Best-effort: never throws — a failure logs and leaves the DB write intact
 * (the next deploy re-establishes the route).
 */
export async function reapplyCloudProjectRoute(
  project: CloudRouteProject,
  input: CloudRouteInput,
): Promise<void> {
  const handle = await resolveCloudHandle(project);
  if (!handle) return;
  const { client, containerId } = handle;

  try {
    if (containerId.startsWith(PAGE_CONTAINER_PREFIX)) {
      // Static page: the free *.opsh.io subdomain IS the page slug (set at
      // create time), so only a custom domain needs an explicit attach.
      if (input.isCustomDomain) {
        await client.pages.connectDomain(containerId.slice(PAGE_CONTAINER_PREFIX.length), {
          domain: input.hostname,
        });
      }
      return;
    }

    // Dynamic workspace.
    const ws = client.workspace(containerId);
    if (input.isCustomDomain) {
      // KNOWN LIMITATION (multi-port): network.update replaces ingress_ports, so
      // applying several custom-domain routes on ONE workspace one-at-a-time
      // leaves only the last port's ingress open. Managed (*.opsh.io) routes
      // don't hit this — publicAccess.expose below is additive per port, which is
      // the path multi-port apps like Convex use by default. Multi-port CUSTOM
      // domains on cloud need a live-Oblien fix to accumulate ingress_ports.
      if (input.port) await ws.network.update({ ingress_ports: [input.port] });
      await ws.domains.connect({
        domain: input.hostname,
        ...(input.port ? { port: input.port } : {}),
      });
      return;
    }

    if (!input.port) {
      console.warn(
        `[CLOUD-ROUTE] Skipping managed expose for ${input.hostname} — no target port resolved.`,
      );
      return;
    }
    await ws.publicAccess.expose({
      port: input.port,
      domain: SYSTEM.DOMAINS.CLOUD_DOMAIN,
      slug: managedSlugFromHostname(input.hostname),
    });
  } catch (err) {
    console.error(
      `[CLOUD-ROUTE] Failed to re-apply route ${input.hostname}:`,
      safeErrorMessage(err),
    );
  }
}

/**
 * Tear down a cloud route removed on edit. Best-effort. Static-page custom
 * domains disconnect cleanly; dynamic-workspace routes have no per-domain
 * teardown primitive (see file header) — logged, not silently dropped.
 */
export async function removeCloudProjectRoute(
  project: CloudRouteProject,
  input: { hostname: string; isCustomDomain: boolean },
): Promise<void> {
  const handle = await resolveCloudHandle(project);
  if (!handle) return;
  const { client, containerId } = handle;

  try {
    if (containerId.startsWith(PAGE_CONTAINER_PREFIX)) {
      if (input.isCustomDomain) {
        await client.pages.disconnectDomain(containerId.slice(PAGE_CONTAINER_PREFIX.length));
      }
      return;
    }

    console.warn(
      `[CLOUD-ROUTE] Workspace route teardown for ${input.hostname} is not supported by the cloud SDK; it clears on redeploy/destroy.`,
    );
  } catch (err) {
    console.error(
      `[CLOUD-ROUTE] Failed to remove route ${input.hostname}:`,
      safeErrorMessage(err),
    );
  }
}
