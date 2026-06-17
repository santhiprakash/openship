import { repos, type Domain, type Project, type Service } from "@repo/db";
import type { RoutedDomainInput, SslProvider } from "@repo/adapters";
import { SYSTEM, resolveServiceHostnameLabel } from "@repo/core";
import { env } from "../config/env";
import { resolveServicePort, serviceKind } from "./deployable-service";

export interface PlannedRouteDomain {
  hostname: string;
  tls: true;
  provisionSsl: boolean;
  isCloud: boolean;
  targetPort?: number;
  targetPath?: string;
  domainType?: "free" | "custom";
  managedSubdomain?: string;
  serviceId?: string;
  isPrimary?: boolean;
  createIfMissing?: boolean;
  verified?: boolean;
}

export function getRoutingBaseDomain(): string {
  return env.HOST_DOMAIN || SYSTEM.DOMAINS.CLOUD_DOMAIN;
}

function resolveManagedHostname(hostname: string): { isManaged: boolean; subdomain?: string } {
  const baseDomain = getRoutingBaseDomain().toLowerCase();
  const normalized = hostname.trim().toLowerCase();
  const suffix = `.${baseDomain}`;

  if (!normalized.endsWith(suffix)) {
    return { isManaged: false };
  }

  const subdomain = normalized.slice(0, -suffix.length);
  return {
    isManaged: subdomain.length > 0,
    subdomain: subdomain || undefined,
  };
}

export function buildProjectRouteDomains(opts: {
  project: Project;
  projectDomains: Domain[];
  customDomain?: string;
  managedSlug?: string;
  publicEndpoints?: Array<{
    port?: number;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain[] {
  const {
    project,
    projectDomains,
    customDomain,
    managedSlug,
    publicEndpoints,
    runtimeName,
    usesManagedRouting,
  } = opts;
  const seen = new Set<string>();
  const planned: PlannedRouteDomain[] = [];

  
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );

  const add = (
    hostname: string,
    domainType: "free" | "custom",
    skipSsl = false,
    destination?: { targetPort?: number; targetPath?: string },
    isPrimary = planned.length === 0,
    verified?: boolean,
  ) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    if (!destination?.targetPath && destination?.targetPort === undefined) return;
    seen.add(normalized);

    const managed = resolveManagedHostname(normalized);
    // Free managed routes are always considered verified (we own the DNS
    // for *.opsh.io). For custom routes, fall back to the domain row if
    // the caller didn't pass an explicit value.
    const isVerified = managed.isManaged
      ? true
      : verified ?? domainByHostname.get(normalized)?.verified ?? false;

    // SSL gating: certbot is run synchronously inside route-registration
    // and a failed --webroot call would fail the whole deploy. So we
    // only provision SSL when the hostname is actually DNS-verified;
    // pending custom domains get an HTTP-only route on disk now and the
    // cert is provisioned after the user clicks Verify (see
    // domain.service.ts → verifyDomain).
    planned.push({
      hostname: normalized,
      tls: true,
      provisionSsl: runtimeName === "bare" && !managed.isManaged && !skipSsl && isVerified,
      isCloud: managed.isManaged,
      ...(destination?.targetPort !== undefined ? { targetPort: destination.targetPort } : {}),
      ...(destination?.targetPath ? { targetPath: destination.targetPath } : {}),
      domainType,
      managedSubdomain: managed.subdomain,
      isPrimary,
      createIfMissing: true,
      verified: isVerified,
    });
  };

  if (publicEndpoints?.length) {
    for (const [index, endpoint] of publicEndpoints.entries()) {
      const destination = endpoint.targetPath
        ? { targetPath: endpoint.targetPath }
        : endpoint.port !== undefined
          ? { targetPort: endpoint.port }
          : undefined;

      if (!destination) {
        continue;
      }

      // Free .opsh.io fallback FIRST. The free domain is always attached
      // when managed routing is available — it's the "deploy URL" that
      // always works, regardless of whether the user also configured a
      // custom domain (or whether that custom domain has finished DNS
      // verification). Mirrors Vercel/Netlify/CF Pages — the platform
      // URL is permanent; the custom domain is additive.
      const routeSlug = endpoint.domain || managedSlug;
      if (routeSlug && usesManagedRouting) {
        add(`${routeSlug}.${getRoutingBaseDomain()}`, "free", true, destination, index === 0);
      }

      // Custom domain SECOND. Attached as an additional route — when DNS
      // points correctly and SSL provisions, traffic flows through this
      // hostname. While DNS is pending, the HTTP-only route exists in
      // OpenResty so the user can hit the box (and so certbot --webroot
      // has a place to serve the ACME challenge from); TLS is only
      // issued *after* /verify confirms DNS. Traffic in the meantime
      // still works via the free fallback above.
      if (endpoint.domainType === "custom" && endpoint.customDomain) {
        // isPrimary stays false on the custom domain — the free route is
        // the technical primary (always-reachable). isPrimary on the
        // domain row gets flipped to the custom hostname inside
        // verifyDomain once DNS verifies, so subsequent routing decisions
        // (analytics, deploy URL surfaced in the dashboard) point at the
        // custom domain.
        add(endpoint.customDomain, "custom", false, destination, false);
      }
    }

    return planned;
  }

  // Free .opsh.io fallback FIRST so it's the primary "always works"
  // route. Custom domain (if any) is attached as an additional route;
  // SSL is only issued for it once DNS verifies (see add() — verified
  // gates provisionSsl).
  const routeSlug = managedSlug;
  if (routeSlug && usesManagedRouting) {
    add(`${routeSlug}.${getRoutingBaseDomain()}`, "free", true);
  }
  if (customDomain) add(customDomain, "custom");
  for (const domain of projectDomains) {
    if (domain.serviceId) continue;
    // We attach BOTH verified and pending custom domains — the HTTP-only
    // route is created in OpenResty / edge so the box is reachable on
    // port 80 (and certbot --webroot can serve the ACME challenge from
    // the same route). SSL is gated on domain.verified inside add(), so
    // pending domains stay covered by the free fallback above until the
    // user clicks Verify; verifyDomain then triggers cert provisioning
    // which re-registers the route with HTTPS.
    if (domain.domainType === "free" && !domain.verified) continue;
    add(
      domain.hostname,
      domain.domainType === "free" ? "free" : "custom",
      domain.domainType === "free",
      domain.targetPath
        ? { targetPath: domain.targetPath }
        : domain.targetPort !== null && domain.targetPort !== undefined
          ? { targetPort: domain.targetPort }
          : undefined,
      domain.isPrimary,
      domain.verified,
    );
  }

  return planned;
}

export function buildServiceRouteDomain(opts: {
  project: Project;
  service: Service;
  runtimeName: string;
  usesManagedRouting: boolean;
}): PlannedRouteDomain | null {
  const { project, service, runtimeName, usesManagedRouting } = opts;
  if (!service.exposed) return null;

  // Use the canonical port resolver so we honor `ports[]` too - not just
  // `exposedPort`.
  const resolvedPort = resolveServicePort(service);
  const targetPort = resolvedPort ?? undefined;

  // Monorepo sub-apps always get a namespaced hostname (`<project>-<app>`).
  // Compose services keep the "frontend"/"web"/"app" → bare-project-label
  // shortcut. See defaultServiceHostnameLabel for why.
  const hostname = service.domainType === "custom"
    ? service.customDomain?.trim().toLowerCase()
    : usesManagedRouting
      ? `${resolveServiceHostnameLabel(project.slug ?? project.name, service.name, service.domain, serviceKind(service))}.${getRoutingBaseDomain()}`
      : null;

  if (!hostname) return null;

  const managed = resolveManagedHostname(hostname);
  return {
    hostname,
    tls: true,
    provisionSsl: runtimeName === "bare" && service.domainType === "custom",
    isCloud: managed.isManaged,
    targetPort: Number.isFinite(targetPort) ? targetPort : undefined,
    domainType: service.domainType === "custom" ? "custom" : "free",
    managedSubdomain: managed.subdomain,
    serviceId: service.id,
    isPrimary: false,
    createIfMissing: true,
  };
}

export function createTrackedSslProvider(
  ssl: SslProvider,
  domainByHostname: Map<string, Domain>,
): SslProvider {
  const persistSslResult = async (hostname: string, result: Awaited<ReturnType<SslProvider["provisionCert"]>>) => {
    const domainRecord = domainByHostname.get(hostname.toLowerCase());

    if (domainRecord) {
      await repos.domain.updateSsl(domainRecord.id, {
        sslStatus: result.expiresAt ? "active" : "provisioning",
        sslIssuer: result.issuer,
        sslExpiresAt: result.expiresAt ? new Date(result.expiresAt) : undefined,
      });
    }

    return result;
  };

  return {
    provisionCert: async (hostname: string) => {
      const result = await ssl.provisionCert(hostname);
      return persistSslResult(hostname, result);
    },
    renewCert: async (hostname: string) => {
      const result = await ssl.renewCert(hostname);
      return persistSslResult(hostname, result);
    },
  };
}

export async function ensureRouteDomainRecord(opts: {
  projectId: string;
  route: PlannedRouteDomain;
  domainByHostname: Map<string, Domain>;
}): Promise<Domain | null> {
  const { projectId, route, domainByHostname } = opts;
  const key = route.hostname.toLowerCase();
  const existing = domainByHostname.get(key);
  if (existing) {
    const patch: Record<string, unknown> = {};
    const expectedDomainType = route.domainType ?? null;
    const expectedTargetPort = route.targetPort ?? null;
    const expectedTargetPath = route.targetPath ?? null;
    const expectedServiceId = route.serviceId ?? null;
    const expectedPrimary = route.isPrimary ?? existing.isPrimary;

    if ((existing.domainType ?? null) !== expectedDomainType) patch.domainType = expectedDomainType;
    if ((existing.targetPort ?? null) !== expectedTargetPort) patch.targetPort = expectedTargetPort;
    if ((existing.targetPath ?? null) !== expectedTargetPath) patch.targetPath = expectedTargetPath;
    if ((existing.serviceId ?? null) !== expectedServiceId) patch.serviceId = expectedServiceId;
    if (existing.isPrimary !== expectedPrimary) patch.isPrimary = expectedPrimary;
    if (!existing.verified) {
      patch.verified = true;
      patch.verifiedAt = new Date();
    }
    if (existing.status !== "active") patch.status = "active";

    if (Object.keys(patch).length > 0) {
      await repos.domain.update(existing.id, patch);
      const updated = { ...existing, ...patch } as Domain;
      domainByHostname.set(key, updated);
      return updated;
    }

    return existing;
  }

  if (!route.createIfMissing) {
    return null;
  }

  const created = await repos.domain.findOrCreate({
    projectId,
    serviceId: route.serviceId,
    hostname: route.hostname,
    targetPort: route.targetPort,
    targetPath: route.targetPath,
    domainType: route.domainType,
    isPrimary: route.isPrimary ?? (!route.serviceId && domainByHostname.size === 0),
    status: "active",
    verified: true,
    verifiedAt: new Date(),
  });
  domainByHostname.set(key, created);
  return created;
}

export function toRoutedDomainInputs(domains: PlannedRouteDomain[]): RoutedDomainInput[] {
  return domains.map((domain) => ({
    hostname: domain.hostname,
    tls: domain.tls,
    provisionSsl: domain.provisionSsl,
    targetPort: domain.targetPort,
    targetPath: domain.targetPath,
  }));
}
