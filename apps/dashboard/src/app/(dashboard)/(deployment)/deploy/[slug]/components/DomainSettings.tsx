import React, { useCallback } from "react";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import type { PublicEndpoint } from "@/context/deployment/types";

interface DomainSettingsProps {
  projectId?: string;
  projectName: string;
  endpoints: PublicEndpoint[];
  hasServer: boolean;
  runtimePort: string;
  setEndpoints: (endpoints: PublicEndpoint[], runtimePort?: string) => void;
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
      ...(domainType === "custom" ? { customDomain } : { domain: freeDomain }),
    };
  }

  return {
    targetPath: endpoint.targetPath.trim() || "/",
    domainType,
    ...(domainType === "custom" ? { customDomain } : { domain: freeDomain }),
  };
}

const DomainSettings: React.FC<DomainSettingsProps> = ({
  projectId,
  projectName,
  endpoints,
  hasServer,
  runtimePort,
  setEndpoints,
}) => {
  const { showToast } = useToast();

  const handleChange = useCallback(async (
    nextEndpoints: PublicEndpoint[],
    nextRuntimePort?: string,
  ) => {
    setEndpoints(nextEndpoints, nextRuntimePort);

    if (!projectId) {
      return;
    }

    const payload = nextEndpoints
      .map((endpoint) => buildPublicEndpointPayload(endpoint, hasServer))
      .filter((endpoint): endpoint is NonNullable<ReturnType<typeof buildPublicEndpointPayload>> => endpoint !== null);

    if (payload.length !== nextEndpoints.length || payload.length === 0) {
      return;
    }

    const primaryPort = hasServer && "port" in payload[0] ? payload[0].port : undefined;

    try {
      await projectsApi.patch(projectId, {
        publicEndpoints: payload,
        ...(typeof primaryPort === "number" ? { port: primaryPort } : {}),
      });
    } catch (error) {
      console.error("Failed to persist deploy domains:", error);
      showToast(getApiErrorMessage(error, "Failed to save domains"), "error", "Domains");
    }
  }, [hasServer, projectId, setEndpoints, showToast]);

  return (
    <PublicEndpointsCard
      projectName={projectName}
      endpoints={endpoints}
      hasServer={hasServer}
      runtimePort={runtimePort}
      allowPortEdit={false}
      saveMode="change"
      onChange={handleChange}
    />
  );
};

export default DomainSettings;
