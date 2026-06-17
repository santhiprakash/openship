"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Container,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  Pencil,
  Power,
  Plus,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { getApiErrorMessage, projectsApi, deployApi, domainsApi, serviceKind, servicesApi, type Service, type ServiceInput } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { resolveServiceHostnameLabel } from "@repo/core";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import {
  createPublicEndpoint,
  ensurePublicEndpoints,
  type PublicEndpoint,
} from "@/context/deployment/types";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

type DomainTone = "success" | "warning" | "danger" | "neutral";

interface DomainSummaryItem {
  /** Unique key for React iteration — endpoint id OR hostname when no endpoint. */
  id: string;
  /**
   * Backing domain row id (`dom_...`). Required for POST /domains/:id/verify.
   * Undefined when the endpoint exists in publicEndpoints draft but the
   * corresponding domain row hasn't been persisted yet (pre-save state).
   */
  domainId?: string;
  title: string;
  hostname: string;
  typeLabel: string;
  mappedLabel: string;
  liveUrl: string;
  isPrimary: boolean;
  /** True when the row exists in DB but verified=false / status=pending. */
  needsVerify: boolean;
  status: { label: string; tone: DomainTone };
  ssl: { label: string; tone: DomainTone };
}

function toEditablePublicEndpoint(endpoint: any): PublicEndpoint {
  return createPublicEndpoint({
    id: typeof endpoint?.id === "string" ? endpoint.id : undefined,
    port:
      endpoint?.port !== undefined && endpoint?.port !== null
        ? String(endpoint.port)
        : "",
    targetPath: endpoint?.targetPath || "",
    domain: endpoint?.domain || "",
    customDomain: endpoint?.customDomain || "",
    domainType: endpoint?.domainType === "custom" ? "custom" : "free",
  });
}

function createProjectEndpointDrafts(
  projectData: Record<string, any>,
  hasServer: boolean,
  runtimePort: string,
): PublicEndpoint[] {
  return ensurePublicEndpoints(
    Array.isArray(projectData.publicEndpoints)
      ? projectData.publicEndpoints.map((endpoint) => toEditablePublicEndpoint(endpoint))
      : undefined,
    hasServer
      ? {
          port: runtimePort,
          domain: projectData.slug || projectData.name || "project",
          domainType: "free",
        }
      : {
          targetPath: "/",
          domain: projectData.slug || projectData.name || "project",
          domainType: "free",
        },
  );
}

function buildPublicEndpointPayload(
  endpoint: PublicEndpoint,
  hasServer: boolean,
): {
  port?: number;
  targetPath?: string;
  domain?: string;
  customDomain?: string;
  domainType: "free" | "custom";
} | null {
  const domainType: "free" | "custom" = endpoint.domainType === "custom" ? "custom" : "free";
  const freeDomain = endpoint.domain.trim().toLowerCase();
  const customDomain = endpoint.customDomain.trim().toLowerCase();

  if (domainType === "custom" && !customDomain) {
    return null;
  }

  if (domainType === "free" && !freeDomain) {
    return null;
  }

  if (hasServer) {
    const port = Number(endpoint.port.trim());
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return null;
    }

    return {
      port,
      domainType,
      ...(domainType === "custom"
        ? { customDomain }
        : { domain: freeDomain }),
    };
  }

  const targetPath = endpoint.targetPath.trim() || "/";
  return {
    targetPath,
    domainType,
    ...(domainType === "custom"
      ? { customDomain }
      : { domain: freeDomain }),
  };
}

function resolveProjectEndpointHostname(endpoint: any, baseDomain: string): string {
  if (typeof endpoint?.hostname === "string" && endpoint.hostname.trim()) {
    return endpoint.hostname.trim().toLowerCase();
  }

  if (endpoint?.domainType === "custom") {
    return endpoint?.customDomain?.trim().toLowerCase() || "";
  }

  const domain = endpoint?.domain?.trim().toLowerCase();
  return domain ? `${domain}.${baseDomain}` : "";
}

function resolveDomainStatus(domain: any): { label: string; tone: DomainTone } {
  if (domain?.verified) {
    return { label: "Verified", tone: "success" };
  }

  switch (domain?.status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "removing":
      return { label: "Removing", tone: "neutral" };
    default:
      return { label: "Pending", tone: "warning" };
  }
}

function resolveDomainSsl(hostname: string, domain: any, baseDomain: string): { label: string; tone: DomainTone } {
  if (hostname.endsWith(`.${baseDomain}`)) {
    return { label: "Included by host", tone: "success" };
  }

  switch (domain?.sslStatus) {
    case "active":
      return { label: "Active", tone: "success" };
    case "provisioning":
      return { label: "Provisioning", tone: "warning" };
    case "expired":
      return { label: "Expired", tone: "danger" };
    case "error":
      return { label: "Error", tone: "danger" };
    default:
      return { label: "Inactive", tone: "neutral" };
  }
}

export const DomainSettings = () => {
  const {
    domainsData,
    updateDomains,
    id,
    projectData,
    setProjectData,
    buildData,
    servicesData,
    refreshServices,
  } = useProjectSettings();
  const { showToast } = useToast();
  const { baseDomain, selfHosted } = usePlatform();

  const [newDomain, setNewDomain] = useState("");
  const [showCustomDomainSection, setShowCustomDomainSection] = useState(false);
  const [includeWww, setIncludeWww] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Hostname of the row currently running its Renew action. Null when no
  // renew is in flight. Per-row so multi-domain projects can renew one
  // cert without blanking the button on every other row.
  const [renewingHostname, setRenewingHostname] = useState<string | null>(null);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  // Live preview of the DNS records the user will need to apply, derived
  // from the hostname they're typing. For self-hosted projects the
  // records are fully deterministic (server's A record + HMAC-derived
  // TXT challenge) so we can render them BEFORE Connect — the user can
  // copy them into their DNS provider while we wait for them to commit
  // the row. For cloud projects, preview is skipped: the CNAME target
  // comes from Oblien, which requires a network round trip per keystroke,
  // so we keep the "Connect first" flow there.
  const [previewedRecords, setPreviewedRecords] = useState<DnsRecord[]>([]);
  // The domain row that the DNS Records panel below is currently showing
  // records for. Populated on successful connectDomain so the panel's
  // bottom CTA can re-run verify against the exact row the user just
  // created (instead of guessing by hostname).
  const [pendingVerifyDomain, setPendingVerifyDomain] = useState<{
    id: string;
    hostname: string;
  } | null>(null);
  const [editingRouteServiceId, setEditingRouteServiceId] = useState<string | null>(null);
  const [routeSavingServiceId, setRouteSavingServiceId] = useState<string | null>(null);
  const [isSavingPublicEndpoints, setIsSavingPublicEndpoints] = useState(false);
  const [isEditingDomains, setIsEditingDomains] = useState(false);
  // Tracks the per-domain Verify button state. Holds the domainId of the
  // row currently running its verify check so the button can spin and
  // disable. Null when no verify is in flight.
  const [verifyingDomainId, setVerifyingDomainId] = useState<string | null>(null);
  const services = servicesData.services;
  const servicesLoading = servicesData.isLoading;
  const hasProjectServer = projectData.options?.hasServer ?? buildData.hasServer ?? true;
  const projectRuntimePort = String(
    projectData.options?.productionPort ||
    buildData.productionPort ||
    projectData.port ||
    "",
  );
  const hasProjectLevelRouting =
    (Array.isArray(projectData.publicEndpoints) && projectData.publicEndpoints.length > 0) ||
    services.length === 0;
  const draftPublicEndpoints = useMemo(
    () => createProjectEndpointDrafts(projectData, hasProjectServer, projectRuntimePort),
    [projectData, hasProjectServer, projectRuntimePort],
  );
  const [publicEndpoints, setPublicEndpoints] = useState<PublicEndpoint[]>(draftPublicEndpoints);

  const domainSummaries = useMemo<DomainSummaryItem[]>(() => {
    const endpointSource = Array.isArray(projectData.publicEndpoints) && projectData.publicEndpoints.length > 0
      ? projectData.publicEndpoints
      : publicEndpoints;
    const domains = Array.isArray(domainsData.domains) ? domainsData.domains : [];
    const domainById = new Map(
      domains
        .filter((domain) => typeof domain?.id === "string")
        .map((domain) => [domain.id, domain]),
    );
    const domainByHostname = new Map(
      domains
        .filter((domain) => typeof domain?.hostname === "string")
        .map((domain) => [domain.hostname.toLowerCase(), domain]),
    );

    return endpointSource
      .map((endpoint: any, index: number): DomainSummaryItem | null => {
        const hostname = resolveProjectEndpointHostname(endpoint, baseDomain);
        if (!hostname) return null;

        const domain =
          (typeof endpoint?.id === "string" ? domainById.get(endpoint.id) : undefined) ||
          domainByHostname.get(hostname) ||
          null;
        const mappedPort = endpoint?.port !== undefined && endpoint?.port !== null
          ? String(endpoint.port)
          : projectRuntimePort;

        // domainId comes from the persisted domain row, NOT the endpoint
        // — the verify endpoint at POST /domains/:id/verify keys on the
        // dom_... row id. Without this, the Verify button has nothing to
        // call. needsVerify is true ONLY when the row exists in DB
        // (domain is non-null) AND verified is explicitly false.
        const domainId = typeof domain?.id === "string" ? domain.id : undefined;
        const needsVerify = !!domain && domain.verified === false;

        return {
          id: endpoint?.id || hostname,
          domainId,
          title: index === 0 ? "Primary domain" : `Domain ${index + 1}`,
          hostname,
          typeLabel: endpoint?.domainType === "custom" ? "Custom domain" : "Free subdomain",
          mappedLabel: hasProjectServer
            ? (mappedPort ? `Port ${mappedPort}` : "No port selected")
            : (endpoint?.targetPath || "/"),
          liveUrl: `https://${hostname}`,
          isPrimary: index === 0,
          needsVerify,
          status: resolveDomainStatus(domain),
          ssl: resolveDomainSsl(hostname, domain, baseDomain),
        };
      })
      .filter((domain): domain is DomainSummaryItem => domain !== null);
  }, [projectData.publicEndpoints, publicEndpoints, domainsData.domains, baseDomain, hasProjectServer, projectRuntimePort]);

  const primaryProjectDomain = domainSummaries[0] ?? null;

  const primaryDomainName = primaryProjectDomain?.hostname || "";
  const localPort = projectData.port || projectData.options?.productionPort || 3000;
  const localUrl = `localhost:${localPort}`;
  const hasDomain = !!primaryDomainName;
  const currentUrl = hasDomain ? primaryDomainName : localUrl;
  const currentHref = hasDomain ? `https://${primaryDomainName}` : `http://${localUrl}`;
  const isManagedHostDomain = hasDomain && primaryDomainName.endsWith(`.${baseDomain}`);
  useEffect(() => {
    setPublicEndpoints(draftPublicEndpoints);
  }, [draftPublicEndpoints]);

  const domainMeta = useMemo(() => {
    if (!hasDomain) {
      return {
        title: "Access URL",
        subtitle: "Local development endpoint",
        typeLabel: "Local",
        statusLabel: "Available on this machine",
        statusTone: "neutral" as const,
      };
    }

    if (isManagedHostDomain) {
      return {
        title: "Primary Domain",
        subtitle:
          domainSummaries.length > 1
            ? `Primary route across ${domainSummaries.length} domains`
            : "Host-managed production URL",
        typeLabel: primaryProjectDomain?.typeLabel || "Free subdomain",
        statusLabel: primaryProjectDomain?.status.label || "Verified",
        statusTone: primaryProjectDomain?.status.tone || ("success" as const),
      };
    }

    return {
      title: "Primary Domain",
      subtitle:
        domainSummaries.length > 1
          ? `Primary route across ${domainSummaries.length} domains`
          : "Custom production domain",
      typeLabel: primaryProjectDomain?.typeLabel || "Custom domain",
      statusLabel: primaryProjectDomain?.status.label || "Pending",
      statusTone: primaryProjectDomain?.status.tone || ("warning" as const),
    };
  }, [hasDomain, isManagedHostDomain, domainSummaries.length, primaryProjectDomain]);

  // The previous live SSL fetch (deployApi.sslStatus) only ran for the
  // primary domain — useless for multi-domain projects, redundant for
  // single-domain projects since `domain.sslStatus` on the row carries
  // the same info. Each DomainOverviewCard now reads ssl directly from
  // its own DB row via resolveDomainSsl(), so no per-page fetch is
  // needed and adding domains stays free of N extra HTTP calls.

  useEffect(() => {
    if (!editingRouteServiceId) return;
    if (!services.some((service) => service.id === editingRouteServiceId)) {
      setEditingRouteServiceId(null);
    }
  }, [editingRouteServiceId, services]);

  // Live-preview DNS records as the user types — self-hosted only.
  //
  // For a self-hosted API the verification text is fully deterministic:
  //   - A record points to env.SERVER_IP (no API call needed)
  //   - TXT challenge is HMAC(hostname, BETTER_AUTH_SECRET) — also no
  //     external call
  //
  // So we can show the records BEFORE the user clicks Connect — they
  // can copy them into their DNS provider, propagation starts ticking,
  // and Connect just commits the row to the DB. For cloud projects the
  // CNAME target comes from Oblien (one network call per keystroke),
  // so we keep the "Connect first" flow there to avoid hammering Oblien.
  //
  // Local validity guard mirrors the backend (addDomain): must have a
  // dot, not end with the managed suffix, not be an IP literal. We
  // skip preview for invalid input rather than firing a doomed request.
  useEffect(() => {
    if (!showCustomDomainSection || !selfHosted) {
      setPreviewedRecords([]);
      return;
    }
    const trimmed = newDomain.trim().toLowerCase();
    const baseLower = baseDomain.toLowerCase();
    const looksValid =
      trimmed.length > 0 &&
      trimmed.includes(".") &&
      !trimmed.startsWith(".") &&
      !trimmed.endsWith(".") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(trimmed) &&
      trimmed !== baseLower &&
      !trimmed.endsWith(`.${baseLower}`);

    if (!looksValid) {
      setPreviewedRecords([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await domainsApi.previewRecords(trimmed);
        if (cancelled) return;
        if (result?.data?.records) {
          setPreviewedRecords(result.data.records);
        } else {
          setPreviewedRecords([]);
        }
      } catch {
        // Preview is best-effort — a failed lookup just hides the panel.
        // The user can still click Connect and see records via the
        // canonical /connect path's response.
        if (!cancelled) setPreviewedRecords([]);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [newDomain, selfHosted, showCustomDomainSection, baseDomain]);

  const handleSubmitDomains = async () => {
    const trimmedDomain = newDomain.trim();
    if (!trimmedDomain) return;

    setIsSubmitting(true);

    // api.post THROWS on non-2xx (ApiError carrying body + status). Without
    // a try/catch the spinner stuck on forever when the backend rejected
    // the hostname (ValidationError on .opsh.io / IP / conflict, etc.) and
    // the user never saw a toast — they just saw the loader spin. Wrap
    // the whole flow so every exit path either toasts and clears the
    // spinner, or surfaces a generic message + clears the spinner.
    try {
      const result = await projectsApi.connectDomain(id, {
        domain: trimmedDomain,
        includeWww,
      });

      // Legacy "success: false" envelope path — some old endpoints return
      // 200 with { success: false }. Keep handling it for parity with the
      // rest of the codebase.
      if (!result.success) {
        showToast(
          result.error || "Failed to connect domain",
          "error",
          result.message || "Failed to connect domain",
        );
        return;
      }

      if (result.records?.records) {
        setDnsRecords(result.records.records);
      }

      // Remember the row the user just connected so the DNS Records panel
      // can surface a Verify CTA after they paste the records into their
      // DNS provider. We only set this when the backend returned a real
      // dom_... id — without that the Verify endpoint has nothing to call.
      if (typeof result.domain?.id === "string") {
        setPendingVerifyDomain({ id: result.domain.id, hostname: trimmedDomain });
      } else {
        setPendingVerifyDomain(null);
      }

      // The backend creates the domain row with verified=false + status=pending.
      // Reflect that locally rather than lying with `verified: true` — the
      // user still has to add the DNS records (now visible below) and click
      // Verify before the row actually goes live.
      const newDomainObj = {
        id: result.domain?.id ?? Date.now(),
        domain: trimmedDomain,
        hostname: trimmedDomain,
        primary: domainsData.domains.length === 0,
        verified: false,
        status: "pending" as const,
      };

      const updatedDomains = [
        ...domainsData.domains.map((d) => ({
          ...d,
          primary: newDomainObj.primary ? false : d.primary,
        })),
        newDomainObj,
      ];

      updateDomains(updatedDomains);
      showToast(
        `${trimmedDomain} added — apply the DNS records below, then click Verify.`,
        "success",
        "Domain pending verification",
      );
      setShowCustomDomainSection(true);
    } catch (err) {
      // 4xx/5xx path — getApiErrorMessage walks the ApiError body looking
      // for the standard {error, message} shape the API throws via
      // ValidationError/ConflictError/etc. Fall back to a generic line if
      // it can't extract anything readable.
      console.error("Failed to connect domain:", err);
      const message = getApiErrorMessage(err) || "Failed to connect domain";
      showToast(message, "error", "Connect domain failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopy = async (text: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showToast("Copied to clipboard", "success");
  };

  const handleVerifyDomain = async (domainId: string, hostname: string) => {
    // Guard: ignore re-clicks while a verify is in flight for this row.
    if (verifyingDomainId) return;
    setVerifyingDomainId(domainId);

    try {
      const result = await domainsApi.verify(domainId);

      if (result.verified) {
        // Optimistically flip the local row so the Pending pill becomes
        // Verified without waiting for the next /info refetch. The next
        // invalidateProjectCaches below catches the canonical state
        // (including sslStatus transitions from the background provision).
        const updatedDomains = domainsData.domains.map((d) =>
          d.id === domainId
            ? { ...d, verified: true, status: "active", sslStatus: result.sslStatus ?? d.sslStatus }
            : d,
        );
        updateDomains(updatedDomains);
        invalidateProjectCaches(id);
        showToast(
          result.message || `${hostname} verified — SSL is provisioning in the background.`,
          "success",
          "Domain verified",
        );
      } else {
        // 422 path. result.cnameVerified/txtVerified explain what's
        // still missing so the user knows whether DNS hasn't propagated
        // OR they forgot the TXT challenge. Surface verbatim.
        showToast(
          result.message || `${hostname} could not be verified yet.`,
          "error",
          "Verification failed",
        );
      }
    } catch (err) {
      console.error("Failed to verify domain:", err);
      showToast(
        getApiErrorMessage(err) || "Failed to verify domain.",
        "error",
        "Verification failed",
      );
    } finally {
      setVerifyingDomainId(null);
    }
  };

  const handleRenewDomainSsl = async (hostname: string) => {
    // Guard: ignore re-clicks on the same row while a renew is in flight.
    if (renewingHostname) return;
    setRenewingHostname(hostname);
    try {
      const result = await deployApi.sslRenew(hostname, false);

      if (result.success) {
        showToast(`SSL renewed for ${hostname}.`, "success");
        // Pull the canonical sslExpiresAt off the DB row by re-fetching
        // project info. The status pill flips on the next render.
        invalidateProjectCaches(id);
      } else {
        showToast(
          result.message || result.error || `Failed to renew SSL for ${hostname}.`,
          "error",
          result.message,
        );
      }
    } catch (error) {
      console.error("Failed to renew SSL:", error);
      showToast(`Failed to renew SSL for ${hostname}.`, "error");
    } finally {
      setRenewingHostname(null);
    }
  };

  const handleStartEditingDomains = () => {
    setPublicEndpoints(draftPublicEndpoints);
    setIsEditingDomains(true);
  };

  const handleCancelEditingDomains = () => {
    setPublicEndpoints(draftPublicEndpoints);
    setIsEditingDomains(false);
  };

  const handleSavePublicEndpoints = async () => {
    const payload = publicEndpoints
      .map((endpoint) => buildPublicEndpointPayload(endpoint, hasProjectServer))
      .filter((endpoint): endpoint is NonNullable<ReturnType<typeof buildPublicEndpointPayload>> => endpoint !== null);

    if (payload.length !== publicEndpoints.length || payload.length === 0) {
      showToast("Complete every domain and mapped port before saving", "error", "Domains");
      return false;
    }

    const primaryPort = hasProjectServer && "port" in payload[0]
      ? payload[0].port
      : undefined;

    setIsSavingPublicEndpoints(true);
    try {
      await projectsApi.patch(id, {
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
      });

      setProjectData((prev) => ({
        ...prev,
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
        options: {
          ...(prev.options || {}),
          ...(typeof primaryPort === "number" ? { productionPort: String(primaryPort) } : {}),
          hasServer: hasProjectServer,
        },
      }));

      await updateDomains(payload.map((endpoint, index) => {
        const hostname = endpoint.domainType === "custom"
          ? endpoint.customDomain || ""
          : `${endpoint.domain}.${baseDomain}`;
        const existing = domainsData.domains.find((domain) => (
          (typeof domain?.id === "string" && domain.id === publicEndpoints[index]?.id) ||
          domain?.hostname === hostname
        ));

        return {
          ...existing,
          id: existing?.id || publicEndpoints[index]?.id || hostname,
          hostname,
          domain: hostname,
          primary: index === 0,
          isPrimary: index === 0,
          verified: existing?.verified ?? true,
          status: existing?.status ?? "active",
          sslStatus: existing?.sslStatus ?? (endpoint.domainType === "free" ? "active" : "none"),
          targetPort: endpoint.port ?? null,
          targetPath: endpoint.targetPath ?? null,
          domainType: endpoint.domainType,
        };
      }));

      // Drop the cached project info so the next mount of Overview /
      // any hook consumer refetches with the new domain state.
      if (id) invalidateProjectCaches(id);
      showToast("Domain routing updated", "success", "Domains");
      setIsEditingDomains(false);
      return true;
    } catch (error) {
      showToast(getApiErrorMessage(error, "Failed to update domain routing"), "error", "Domains");
      return false;
    } finally {
      setIsSavingPublicEndpoints(false);
    }
  };

  const projectLabel = projectData.slug || projectData.name || "project";

  const resolveServiceHostname = (service: Service) => {
    if (service.domainType === "custom" && service.customDomain) {
      return service.customDomain;
    }
    return `${resolveServiceHostnameLabel(projectLabel, service.name, service.domain, serviceKind(service))}.${baseDomain}`;
  };

  const getServiceRouteSummary = (service: Service) => {
    const liveUrl = service.exposed ? `https://${resolveServiceHostname(service)}` : null;

    if (!service.enabled) {
      return {
        connected: false,
        statusLabel: "Disabled",
        statusClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        detail: service.exposed ? "Route paused" : "Service disabled",
        liveUrl,
      };
    }

    if (!service.exposed) {
      return {
        connected: false,
        statusLabel: "Internal",
        statusClass: "bg-muted/60 text-muted-foreground/70",
        detail: "Not exposed",
        liveUrl: null as string | null,
      };
    }

    return {
      connected: true,
      statusLabel: "Public",
      statusClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      detail: service.domainType === "custom" ? "Custom domain" : "Free subdomain",
      liveUrl,
    };
  };

  const handleServiceRouteUpdate = async (serviceId: string, patch: Partial<ServiceInput>) => {
    setRouteSavingServiceId(serviceId);
    try {
      const result = await servicesApi.update(id, serviceId, patch);
      if (!result.success) {
        throw new Error("Failed to update service route");
      }
      await refreshServices();
    } catch (error) {
      console.error("Failed to update service route:", error);
      showToast("Failed to update service route", "error");
    } finally {
      setRouteSavingServiceId(null);
    }
  };

  const editingRouteService =
    services.find((service) => service.id === editingRouteServiceId) ?? null;
  const editingRoute = editingRouteService ? getServiceRouteSummary(editingRouteService) : null;

  const hasMultipleProjectDomains = domainSummaries.length > 1;
  // Toggling "Hide setup" should also wipe in-flight connect/verify state
  // so reopening the panel starts fresh instead of resurrecting the
  // previous attempt's records and Verify button. Without this, a user
  // who closes the panel after connecting `acme.com`, then clicks Add
  // domain again, sees `acme.com`'s pending records — confusing.
  const handleToggleCustomDomain = () => {
    if (showCustomDomainSection) {
      setShowCustomDomainSection(false);
      setDnsRecords([]);
      setPreviewedRecords([]);
      setPendingVerifyDomain(null);
      setNewDomain("");
      setIncludeWww(false);
    } else {
      setShowCustomDomainSection(true);
    }
  };
  const singleDomainActions = (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <ActionButton href={currentHref} label="Visit" icon={ExternalLink} />
      {hasProjectLevelRouting ? (
        <ActionButton label="Edit domains" icon={Pencil} onClick={handleStartEditingDomains} />
      ) : null}
      <ActionButton
        label={showCustomDomainSection ? "Hide setup" : "Add domain"}
        icon={Plus}
        onClick={handleToggleCustomDomain}
      />
    </div>
  );
  const multiDomainActions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ActionButton label="Edit domains" icon={Pencil} onClick={handleStartEditingDomains} />
      <ActionButton
        label={showCustomDomainSection ? "Hide setup" : "Add domain"}
        icon={Plus}
        onClick={handleToggleCustomDomain}
      />
    </div>
  );

  // Whether the DNS Records panel is ready to render. Sources, in order:
  //   1. dnsRecords — real records from a completed Connect call (both modes)
  //   2. previewedRecords — live preview from /domains/preview (self-hosted only,
  //      derived from the hostname the user is typing)
  // Cloud users still see the panel only after Connect. Self-hosted users
  // see it the moment they type a plausible-looking domain, so they can
  // start applying records before committing the row.
  const recordsToShow = dnsRecords.length > 0 ? dnsRecords : previewedRecords;
  const hasDnsRecords = recordsToShow.length > 0;
  // True when the panel is showing preview (pre-Connect) data only. Used
  // to tweak the explainer text inside the panel.
  const isPreviewOnly = dnsRecords.length === 0 && previewedRecords.length > 0;

  return (
    <div className="space-y-5">
      {showCustomDomainSection ? (
        // Custom Domain setup sits ABOVE the existing list so the form
        // is the first thing the user sees after clicking Add domain —
        // they don't have to scroll past their existing domains to find
        // the input. DNS Records only appears next to the form once the
        // backend returns real records (post-Connect), so there's no
        // placeholder noise before the user has done anything.
        <div className={`grid grid-cols-1 gap-5 ${hasDnsRecords ? "lg:grid-cols-2" : ""}`}>
          <SectionCard
            title="Custom Domain"
            description="Attach your own domain and keep it as the production entrypoint"
            icon={Plus}
            iconTone="blue"
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground">Domain name</label>
                <input
                  placeholder="yourdomain.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40"
                />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
                <div>
                  <p className="text-[13px] font-medium text-foreground">Include www</p>
                  <p className="text-[12px] text-muted-foreground">
                    Also generate records for www.{newDomain || "yourdomain.com"}
                  </p>
                </div>
                <button
                  onClick={() => setIncludeWww((value) => !value)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${includeWww ? "bg-primary" : "bg-muted"}`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${includeWww ? "translate-x-6" : "translate-x-1"}`}
                  />
                </button>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleSubmitDomains}
                  disabled={!newDomain.trim() || isSubmitting}
                  className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {isSubmitting ? "Preparing records" : "Connect domain"}
                </button>
              </div>
            </div>
          </SectionCard>

          {hasDnsRecords ? (
            <SectionCard
              title="DNS Records"
              description={
                isPreviewOnly
                  ? "Add these records at your DNS provider, then click Connect domain to attach it"
                  : "Apply these records at your DNS provider, then wait for propagation"
              }
              icon={Link2}
              iconTone="orange"
            >
              <div className="space-y-3">
                {recordsToShow.map((record, index) => (
                  <DnsRecordRow
                    key={`${record.type}-${record.host}-${index}`}
                    record={record}
                    onCopy={handleCopy}
                  />
                ))}
              </div>

              <div className="rounded-xl bg-muted/35 px-4 py-3 text-[12px] text-muted-foreground">
                {isPreviewOnly
                  ? "Add these records first — they don't change after Connect, so propagation starts now. Then press Connect domain to attach it, and finally Verify once DNS resolves."
                  : "DNS changes can take up to 48 hours to propagate globally. Once the records resolve, click Verify below — we'll check DNS, mark the domain active, and provision SSL in the background."}
              </div>

              {pendingVerifyDomain ? (
                <div className="flex justify-end pt-1">
                  <ActionButton
                    label={
                      verifyingDomainId === pendingVerifyDomain.id
                        ? "Verifying..."
                        : `Verify ${pendingVerifyDomain.hostname}`
                    }
                    icon={verifyingDomainId === pendingVerifyDomain.id ? Loader2 : RefreshCw}
                    onClick={() =>
                      void handleVerifyDomain(pendingVerifyDomain.id, pendingVerifyDomain.hostname)
                    }
                    disabled={verifyingDomainId === pendingVerifyDomain.id}
                  />
                </div>
              ) : null}
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {!isEditingDomains && !hasDomain ? (
        // No domain attached yet — show the local URL as the access point
        // alongside the Add domain CTA. This is the cold-start state; once
        // any domain (free or custom) is attached, we render the list below.
        <SectionCard
          title={domainMeta.title}
          description={domainMeta.subtitle}
          icon={Globe}
          iconTone="primary"
          actions={singleDomainActions}
        >
          <ValueBlock label="Local URL" value={currentUrl} />
          <InfoRow label="Type" value={domainMeta.typeLabel} />
          <InfoRow
            label="Status"
            value={<StatusPill tone={domainMeta.statusTone}>{domainMeta.statusLabel}</StatusPill>}
          />
        </SectionCard>
      ) : null}

      {!isEditingDomains && hasDomain ? (
        // Always render the unified list — every domain attached to the
        // project, free OR custom, gets a row, just like the Service
        // Routing section below. The primary domain carries the "Primary"
        // badge inside its card; SSL state for the primary lives in the
        // dedicated card just below this list so renew / status info is
        // discoverable without expanding rows.
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasMultipleProjectDomains ? multiDomainActions : singleDomainActions}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {domainSummaries.map((domain) => {
              // Pending custom domains get a Verify button right next to
              // their Pending status pill so the toast's "click Verify"
              // instruction isn't a scavenger hunt. Verified rows just
              // get the Visit action. We never render Verify without a
              // domainId — without it the API call has no row to verify
              // (e.g. pre-save endpoint drafts).
              const isVerifying = !!verifyingDomainId && verifyingDomainId === domain.domainId;
              const verifyAction =
                domain.needsVerify && domain.domainId ? (
                  <ActionButton
                    label={isVerifying ? "Verifying..." : "Verify"}
                    icon={isVerifying ? Loader2 : RefreshCw}
                    onClick={() => void handleVerifyDomain(domain.domainId!, domain.hostname)}
                    disabled={isVerifying}
                  />
                ) : null;
              // Renew shows on verified custom rows only. Free .opsh.io
              // is host-managed (no Let's Encrypt cert to renew), and
              // pending rows don't have a cert yet — Verify kicks off
              // the initial provisioning. We surface Renew across every
              // multi-domain row so each cert can be poked independently;
              // single-domain projects get the same affordance inline,
              // replacing the old bottom-of-page SSL card.
              const isManagedRow = domain.hostname.toLowerCase().endsWith(`.${baseDomain}`);
              const isRenewing = renewingHostname === domain.hostname;
              const renewAction =
                !isManagedRow && !domain.needsVerify && domain.domainId ? (
                  <ActionButton
                    label={isRenewing ? "Renewing..." : "Renew SSL"}
                    icon={isRenewing ? Loader2 : ShieldAlert}
                    onClick={() => void handleRenewDomainSsl(domain.hostname)}
                    disabled={isRenewing}
                  />
                ) : null;
              const visitAction = domain.liveUrl ? (
                <ActionButton href={domain.liveUrl} label="Visit" icon={ExternalLink} />
              ) : null;
              const actions = verifyAction || renewAction || visitAction ? (
                <>
                  {verifyAction}
                  {renewAction}
                  {visitAction}
                </>
              ) : null;
              return (
                <DomainOverviewCard
                  key={domain.id}
                  domain={domain}
                  actions={actions}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {hasProjectLevelRouting && isEditingDomains ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-[14px] font-semibold text-foreground">Edit domains</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {hasProjectServer
                  ? "Edit which internal port each domain should route to."
                  : "Edit which static path each domain should serve."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCancelEditingDomains}
                disabled={isSavingPublicEndpoints}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground/[0.06] px-4 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-4" />
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSavePublicEndpoints()}
                disabled={isSavingPublicEndpoints}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingPublicEndpoints ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                {isSavingPublicEndpoints ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>

          <PublicEndpointsCard
            projectName={projectLabel}
            endpoints={publicEndpoints}
            hasServer={hasProjectServer}
            runtimePort={publicEndpoints[0]?.port || projectRuntimePort}
            onChange={(nextEndpoints) => setPublicEndpoints(nextEndpoints)}
          />
        </div>
      ) : null}

      {!hasProjectLevelRouting && (servicesLoading || services.length > 0) && (() => {
        // Only show ENABLED services (and their associated domains). When
        // the operator disables a sub-app from the Services tab, its
        // routing row hides from this Domains view automatically - the
        // domain isn't being routed to anything, so showing it as if it
        // were "available" would mislead. The disabled service is still
        // editable from the Services tab; if it's re-enabled it reappears
        // here on the next render.
        const visibleServices = services.filter((s) => s.enabled);
        const visibleExposedCount = visibleServices.filter((s) => s.exposed).length;
        return (
        <SectionCard
          title="Service Routing"
          description={`${visibleExposedCount} of ${visibleServices.length} services exposed publicly`}
          icon={Container}
          iconTone="primary"
        >
          {servicesLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading services...
            </div>
          ) : visibleServices.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {services.length === 0
                ? "No services found for this project."
                : "All services are disabled - enable one from the Services tab to see its routing."}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
              {visibleServices.map((service) => {
                const route = getServiceRouteSummary(service);
                const isServiceSaving = routeSavingServiceId === service.id;
                const routeLabel = route.liveUrl
                  ? route.liveUrl.replace("https://", "")
                  : "Internal only";

                return (
                  <div key={service.id} className="bg-card">
                    <div className="flex w-full items-center gap-4 px-4 py-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-foreground">
                            {service.name}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${route.statusClass}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${route.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                            />
                            {route.statusLabel}
                          </span>
                        </div>

                        <div className="mt-3 rounded-xl border border-border/50 bg-muted/25 px-3.5 py-3">
                          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                            Route
                          </div>
                          <div className="mt-1.5 truncate text-[13px] font-semibold text-foreground">
                            {routeLabel}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <Link2 className="size-3" />
                          <span>Port {service.exposedPort || "Auto"}</span>
                          <span className="text-muted-foreground/50">·</span>
                          <span>{route.detail}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {route.connected && route.liveUrl && (
                          <a
                            href={route.liveUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors"
                          >
                            <ExternalLink className="size-3" />
                            Open
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            handleServiceRouteUpdate(service.id, { enabled: !service.enabled })
                          }
                          disabled={isServiceSaving}
                          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            service.enabled
                              ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/15"
                              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15"
                          }`}
                        >
                          {isServiceSaving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Power className="size-3" />
                          )}
                          {service.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingRouteServiceId(service.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-foreground/[0.06] text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                        >
                          Edit route
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
        );
      })()}

      {editingRouteService && editingRoute && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
          onClick={() => setEditingRouteServiceId(null)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold text-foreground">Edit route</h3>
                <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {editingRouteService.name}
                  {editingRoute.liveUrl
                    ? ` · ${editingRoute.liveUrl.replace("https://", "")}`
                    : " · Internal only"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingRouteServiceId(null)}
                className="inline-flex min-h-9 items-center rounded-xl bg-foreground/[0.06] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                Close
              </button>
            </div>

            <div className="px-5 py-5">
              <RoutingSettingsCard
                projectName={projectLabel}
                domain={editingRouteService.domain ?? ""}
                customDomain={editingRouteService.customDomain ?? ""}
                domainType={editingRouteService.domainType === "custom" ? "custom" : "free"}
                exposed={editingRouteService.exposed}
                ports={editingRouteService.ports}
                exposedPort={editingRouteService.exposedPort ?? ""}
                disabled={routeSavingServiceId === editingRouteService.id}
                liveUrl={editingRoute.connected ? editingRoute.liveUrl : null}
                onExposedChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { exposed: value })
                }
                onDomainTypeChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { domainType: value })
                }
                onDomainChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { domain: value })
                }
                onCustomDomainChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { customDomain: value })
                }
                onExposedPortChange={(value) =>
                  handleServiceRouteUpdate(editingRouteService.id, { exposedPort: value })
                }
                saveMode="explicit"
              />
              {!editingRouteService.enabled && editingRouteService.exposed && (
                <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                  Service is disabled - routes are inactive until the service is re-enabled.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
  blue: "bg-blue-500/10 text-blue-500",
  orange: "bg-orange-500/10 text-orange-500",
} as const;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone = "primary",
  headerBadge,
  actions,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: keyof typeof ICON_TONES;
  headerBadge?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      <div className="border-b border-border/40 px-5 py-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}
          >
            <Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
          </div>
          {headerBadge ? <div className="shrink-0 self-start">{headerBadge}</div> : null}
        </div>
        {actions ? <div className="mt-4">{actions}</div> : null}
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="text-right">
        {typeof value === "string" ? (
          <span className="text-[13px] font-medium text-foreground">{value}</span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function ValueBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/25 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-2 break-all text-[14px] font-semibold text-foreground">{value}</div>
    </div>
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "neutral";
  children: React.ReactNode;
}) {
  const styles = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
    neutral: "bg-muted/60 text-muted-foreground",
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles}`}
    >
      {tone === "success" ? <CheckCircle2 className="size-3" /> : null}
      {tone === "warning" || tone === "danger" ? <ShieldAlert className="size-3" /> : null}
      {children}
    </span>
  );
}

function ActionButton({
  label,
  icon: Icon,
  href,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const className =
    "inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:cursor-not-allowed disabled:opacity-50";

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <Icon className="size-3.5" />
        {label}
      </a>
    );
  }

  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function DomainOverviewCard({
  domain,
  actions,
}: {
  domain: DomainSummaryItem;
  actions?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
      <div className="border-b border-border/40 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-foreground">{domain.title}</h3>
            {domain.isPrimary ? (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                Primary
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{domain.typeLabel}</p>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        <ValueBlock label="Domain" value={domain.hostname} />
        <InfoRow label="Mapped to" value={domain.mappedLabel} />
        <InfoRow label="Status" value={<StatusPill tone={domain.status.tone}>{domain.status.label}</StatusPill>} />
        <InfoRow label="SSL" value={<StatusPill tone={domain.ssl.tone}>{domain.ssl.label}</StatusPill>} />
      </div>

      {actions ? (
        <div className="border-t border-border/40 bg-muted/[0.14] px-5 py-3">
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        </div>
      ) : null}
    </div>
  );
}

function DnsRecordRow({
  record,
  onCopy,
}: {
  record: DnsRecord;
  onCopy: (text: string) => void | Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
            {record.type}
          </div>
          <div className="mt-1 text-[13px] font-medium text-foreground">{record.host}</div>
          <code className="mt-2 block break-all text-[12px] text-muted-foreground">
            {record.value || "-"}
          </code>
        </div>
        {record.value ? (
          <button
            onClick={() => onCopy(record.value)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            title="Copy"
          >
            <Copy className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

