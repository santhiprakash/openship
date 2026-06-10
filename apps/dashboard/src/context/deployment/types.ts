import type { Terminal } from "@xterm/xterm";
import type { FrameworkId, EnvironmentVariable } from "@/components/import-project/types";
import type { PrepareComposeService, PrepareSingleAppCandidate } from "@/lib/api/deploy";
import { getBuildImage, STACKS, type ProjectType, type BuildStrategy, type DeployTarget, type RuntimeMode, type StackId } from "@repo/core";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";

// ─── Monorepo sub-app ────────────────────────────────────────────────────────

/**
 * One deployable sub-app inside a monorepo. Mirrors the single-app form fields
 * (rootDirectory, install/build/start commands, port) plus per-app routing/env
 * scoping. Multiple of these live under one openship project, all sharing the
 * monorepoWorkspace install at the repo root.
 */
export interface MonorepoAppConfig {
  /** Stable identifier (defaults to rootDirectory). */
  id: string;
  /** Display name (last segment of rootDirectory, or package.json name). */
  name: string;
  /** Whether this sub-app is included in the next deploy. */
  enabled: boolean;
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  productionPaths: string[];
  port: string;
  hasServer: boolean;
  hasBuild: boolean;
  envVars: EnvironmentVariable[];
  publicEndpoints: PublicEndpoint[];
}

export interface MonorepoWorkspaceConfig {
  packageManager: string;
  /** Shared install command run once at the repo root before per-app builds. */
  installCommand: string;
}

const GENERIC_MULTI_BUILD_IMAGE = "ubuntu:22.04";
const NON_APP_SINGLE_FLOW_STACKS = new Set<FrameworkId>(["docker", "docker-compose", "unknown"]);
const NODE_BUILD_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

// ─── Screenshots ─────────────────────────────────────────────────────────────

export interface Screenshot {
  url: string;
  variants: Array<{ variant: string; url: string }>;
  size: number;
  mime: string;
}

// ─── Compose service (matches API response) ─────────────────────────────────

/**
 * Compose-service shape as it travels through the dashboard's deployment
 * context. Aliased to PrepareComposeService (the API client's matching
 * type) so the two stay synchronized - same wire shape, one place to
 * change it. The dashboard's deployment context uses this name for
 * legacy reasons; new code should reach for PrepareComposeService.
 */
export type ComposeServiceInfo = PrepareComposeService;

export interface PublicEndpoint {
  id: string;
  port: string;
  targetPath: string;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
}

// ─── Per-service deployment status (live from SSE or loaded from DB) ─────────

export interface ServiceDeployStatus {
  serviceId: string;
  serviceName: string;
  status: "pending" | "building" | "built" | "deploying" | "running" | "failed";
  error?: string;
  containerId?: string;
  hostPort?: number;
  image?: string;
  build?: string;
}

// ─── Build Strategy ──────────────────────────────────────────────────────────

export type { BuildStrategy, RuntimeMode, DeployTarget } from "@repo/core";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface DeploymentOptions {
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string;
  installCommand: string;
  startCommand: string;
  productionPort: string;
  rootDirectory: string;
  hasServer: boolean;
  hasBuild: boolean;
}

export interface DeploymentModeSnapshot {
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  buildStrategy: BuildStrategy;
  runtimeMode: RuntimeMode;
  publicEndpoints: PublicEndpoint[];
  options: DeploymentOptions;
}

export interface DeploymentSingleModeSnapshot extends DeploymentModeSnapshot {
  sourceSignature: string | null;
}

export interface DeploymentModeSnapshots {
  services?: DeploymentModeSnapshot;
  single?: DeploymentSingleModeSnapshot;
}

/**
 * Resource tier IDs for Openship Cloud deploys. The label, RAM/CPU/disk
 * shape and price are placeholder values defined alongside the picker UI
 * — see `CLOUD_RESOURCE_TIERS` in `DeployTargetStep.tsx`. The backend
 * is the source of truth for what each tier actually provisions.
 */
export type CloudResourceTier = "micro" | "low" | "medium" | "high" | "custom";

/**
 * User-supplied resource values when `cloudResourceTier === "custom"`.
 * Stored in the same shape the backend's ResourceConfig uses (cores +
 * megabytes) so the handoff is a direct copy with no unit conversion.
 */
export interface CloudResourceCustom {
  /** Fractional vCPU cores (e.g. 0.25, 0.5, 1, 2). */
  cpuCores: number;
  /** RAM in megabytes. */
  memoryMb: number;
  /** Disk in megabytes. */
  diskMb: number;
}

export interface DeploymentConfig {
  /** Existing deployable environment to update/deploy, when launched from a project page. */
  projectId?: string;
  projectName: string;
  repo: string;
  owner: string;
  /** Absolute path for local projects (mutually exclusive with owner/repo git source) */
  localPath?: string;
  /** Where the build runs: "server" (default, build in cloud/workspace) or "local" (build on host machine) */
  buildStrategy: BuildStrategy;
  /** Where the app deploys to: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget: DeployTarget;
  /** Which server to deploy to when deployTarget === "server" */
  serverId?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode: RuntimeMode;
  projectType: ProjectType;
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  publicEndpoints: PublicEndpoint[];
  envVars: EnvironmentVariable[];
  /** Root .env values detected during prepare; user must import before they apply. */
  rootEnvVars: EnvironmentVariable[];
  branch: string;
  branches: string[];
  services: ComposeServiceInfo[];
  /**
   * Compose/import projects can either deploy each parsed service, or ignore the
   * service fan-out for this deployment and use the normal single-app pipeline.
   */
  serviceDeploymentMode: "services" | "single";
  singleAppCandidate?: PrepareSingleAppCandidate;
  composeDefaults?: {
    framework: FrameworkId;
    packageManager: string;
    buildImage: string;
    options: DeploymentOptions;
  };
  modeSnapshots?: DeploymentModeSnapshots;
  /** Sub-apps discovered inside a monorepo. Only populated when projectType === "monorepo". */
  monorepoApps?: MonorepoAppConfig[];
  /** Shared workspace metadata (package manager + root install) for monorepo deploys. */
  monorepoWorkspace?: MonorepoWorkspaceConfig;
  /**
   * Resource tier picked for Openship Cloud deploys. Self-hosted servers
   * inherit the host's capacity, so this field is meaningless for them
   * — kept on the config (not nested under cloud) because operators
   * sometimes preview the cost before picking the target. The backend
   * is responsible for translating the tier into a real ResourceConfig
   * (cpuCores/memoryMb/diskMb) and the corresponding billing line. See
   * `CLOUD_RESOURCE_TIERS` in the deploy-target step for placeholder
   * values; real numbers come from the pricing service later.
   */
  cloudResourceTier?: CloudResourceTier;
  /** Custom CPU/RAM/disk values, used only when cloudResourceTier === "custom". */
  cloudResourceCustom?: CloudResourceCustom;
  /** Local-only flag so env imports don't overwrite a user-edited runtime port. */
  productionPortTouched: boolean;
  /** Last runtime port auto-applied from env detection in this deploy flow. */
  lastAutoDetectedEnvPort: string | null;
  options: DeploymentOptions;
}

export const DEFAULT_CONFIG: DeploymentConfig = {
  projectId: undefined,
  projectName: "",
  repo: "",
  owner: "",
  localPath: undefined,
  buildStrategy: "server",
  deployTarget: "cloud",
  runtimeMode: "bare",
  projectType: "app",
  framework: "nextjs",
  detectedFramework: null,
  packageManager: "npm",
  buildImage: "node:22",
  publicEndpoints: [],
  branch: "main",
  branches: [],
  services: [],
  serviceDeploymentMode: "single",
  cloudResourceTier: "low",
  productionPortTouched: false,
  lastAutoDetectedEnvPort: null,
  options: {
    buildCommand: "",
    outputDirectory: "",
    productionPaths: "",
    installCommand: "",
    startCommand: "",
    productionPort: "",
    rootDirectory: "./",
    hasServer: true,
    hasBuild: true,
  },
  envVars: [],
  rootEnvVars: [],
};

function isSingleFlowAppStack(framework: string | undefined): framework is StackId {
  return Boolean(
    framework &&
    framework in STACKS &&
    !NON_APP_SINGLE_FLOW_STACKS.has(framework as FrameworkId),
  );
}

export function getRecommendedSingleAppBuildImage(
  config: Pick<DeploymentConfig, "framework" | "packageManager" | "buildImage">,
): string {
  if (isSingleFlowAppStack(config.framework)) {
    return getBuildImage(config.framework, config.packageManager);
  }

  if (config.packageManager === "bun") {
    return "oven/bun:latest";
  }

  if (NODE_BUILD_PACKAGE_MANAGERS.has(config.packageManager)) {
    return "node:22";
  }

  if (config.buildImage && config.buildImage !== GENERIC_MULTI_BUILD_IMAGE) {
    return config.buildImage;
  }

  return "node:22";
}

export function resolveBuildImageForDeploymentMode(
  config: Pick<DeploymentConfig, "projectType" | "serviceDeploymentMode" | "framework" | "packageManager" | "buildImage">,
  nextMode: DeploymentConfig["serviceDeploymentMode"] = config.serviceDeploymentMode,
): string {
  if (config.projectType !== "services") {
    return config.buildImage || getRecommendedSingleAppBuildImage(config);
  }

  const serviceStackImage = isSingleFlowAppStack(config.framework)
    ? getBuildImage(config.framework, config.packageManager)
    : GENERIC_MULTI_BUILD_IMAGE;
  const singleAppImage = getRecommendedSingleAppBuildImage(config);

  if (nextMode === "services") {
    if (!config.buildImage || config.buildImage === singleAppImage) {
      return serviceStackImage;
    }

    return config.buildImage;
  }

  if (
    !config.buildImage ||
    config.buildImage === GENERIC_MULTI_BUILD_IMAGE ||
    config.buildImage === serviceStackImage
  ) {
    return singleAppImage;
  }

  return config.buildImage;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Whether any compose service uses a managed (free) domain that requires
 * Openship Cloud. Checks by domain *type*, not by domain string -
 * works regardless of the configured cloud domain.
 */
export function servicesNeedCloud(services?: ComposeServiceInfo[]): boolean {
  if (!services?.length) return false;
  return services.some((s) => s.exposed && s.domainType !== "custom");
}

export function publicEndpointsNeedCloud(endpoints?: PublicEndpoint[]): boolean {
  if (!endpoints?.length) return false;
  return endpoints.some((endpoint) => endpoint.domainType !== "custom");
}

export function createPublicEndpoint(
  overrides: Partial<PublicEndpoint> = {},
): PublicEndpoint {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    port: overrides.port ?? "",
    targetPath: overrides.targetPath ?? "",
    domain: overrides.domain ?? "",
    customDomain: overrides.customDomain ?? "",
    domainType: overrides.domainType ?? "free",
  };
}

export function ensurePublicEndpoints(
  endpoints: PublicEndpoint[] | undefined,
  fallback?: {
    port?: string;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  },
): PublicEndpoint[] {
  if (endpoints && endpoints.length > 0) {
    return endpoints;
  }

  return [
    createPublicEndpoint({
      port: fallback?.port ?? "",
      targetPath: fallback?.targetPath ?? "",
      domain: fallback?.domain ?? "",
      customDomain: fallback?.customDomain ?? "",
      domainType: fallback?.domainType ?? "free",
    }),
  ];
}

function normalizePublicEndpointForMode(
  endpoint: PublicEndpoint,
  opts: { hasServer: boolean; runtimePort: string; isPrimary: boolean },
): PublicEndpoint {
  if (opts.hasServer) {
    return createPublicEndpoint({
      ...endpoint,
      port: opts.isPrimary
        ? (opts.runtimePort || endpoint.port || "")
        : (endpoint.port || opts.runtimePort || ""),
      targetPath: "",
    });
  }

  return createPublicEndpoint({
    ...endpoint,
    port: "",
    targetPath: endpoint.targetPath || "/",
  });
}

export function syncPublicEndpointState(
  config: DeploymentConfig,
): DeploymentConfig {
  const linkedRuntimePort = config.options.hasServer
    ? (
        config.options.productionPort ||
        config.publicEndpoints[0]?.port ||
        ""
      )
    : config.options.productionPort;
  const endpoints = ensurePublicEndpoints(
    config.publicEndpoints,
    config.options.hasServer
      ? {
          port: linkedRuntimePort,
        }
      : {
          targetPath: "/",
        },
  ).map((endpoint, index) => normalizePublicEndpointForMode(endpoint, {
    hasServer: config.options.hasServer,
    runtimePort: linkedRuntimePort,
    isPrimary: index === 0,
  }));
  const primary = endpoints[0];

  return {
    ...config,
    publicEndpoints: endpoints,
    options: {
      ...config.options,
      productionPort: config.options.hasServer
        ? (linkedRuntimePort || primary?.port || "")
        : config.options.productionPort,
    },
  };
}

export function usesServiceDeployment(
  config: Pick<DeploymentConfig, "projectType" | "serviceDeploymentMode">,
): boolean {
  return config.projectType === "services" && config.serviceDeploymentMode === "services";
}

export function getPublicEndpointHosts(
  endpoints: PublicEndpoint[] | undefined,
  baseDomain: string,
  fallbackDomain: string,
): string[] {
  return ensurePublicEndpoints(endpoints, {
    domain: fallbackDomain,
    domainType: "free",
  })
    .map((endpoint) => (
      endpoint.domainType === "custom"
        ? endpoint.customDomain
        : endpoint.domain
          ? `${endpoint.domain}.${baseDomain}`
          : fallbackDomain
            ? `${fallbackDomain}.${baseDomain}`
            : ""
    ))
    .filter((hostname, index, hostnames) => Boolean(hostname) && hostnames.indexOf(hostname) === index);
}



// ─── State ───────────────────────────────────────────────────────────────────

export interface DeploymentState {
  deploymentId: string | null;
  isDeploying: boolean;
  isStopping: boolean;
  deploymentSuccess: boolean;
  deploymentFailed: boolean;
  deploymentCanceled: boolean;
  failureMessage: string;
  warningMessage: string;
  errorCode: string;
  errorDetails: Record<string, unknown> | null;
  buildLogs: BuildLog[];
  currentProgress: number;
  currentStepIndex: number;
  screenshots: Screenshot[];
  projectId: string | null;
  /** Final build duration in ms (set when build finishes). */
  buildDurationMs: number | null;
  /** ISO timestamp when the build started (for elapsed timer). */
  buildStartedAt: string | null;
  /** Accumulated elapsed ms carried from previous failed/cancelled retries. */
  buildRetryCarryMs: number;
  /** Active pipeline prompt waiting for user response. */
  pendingPrompt: {
    promptId: string;
    title: string;
    message: string;
    actions: Array<{ id: string; label: string; variant?: string }>;
    details?: Record<string, unknown>;
  } | null;
  /** Per-service deployment statuses for compose projects. */
  serviceStatuses: ServiceDeployStatus[];
}

export const INITIAL_STATE: DeploymentState = {
  deploymentId: null,
  isDeploying: false,
  isStopping: false,
  deploymentSuccess: false,
  deploymentFailed: false,
  deploymentCanceled: false,
  failureMessage: "",
  warningMessage: "",
  errorCode: "",
  errorDetails: null,
  buildLogs: [],
  currentProgress: 0,
  currentStepIndex: 0,
  screenshots: [],
  projectId: null,
  buildDurationMs: null,
  buildStartedAt: null,
  buildRetryCarryMs: 0,
  pendingPrompt: null,
  serviceStatuses: [],
};

export function resolveBuildElapsedMs(
  state: Pick<DeploymentState, "buildDurationMs" | "buildStartedAt" | "buildRetryCarryMs">,
  now = Date.now(),
): number {
  const carry = state.buildRetryCarryMs || 0;

  if (typeof state.buildDurationMs === "number") {
    return Math.max(0, carry + state.buildDurationMs);
  }

  if (state.buildStartedAt) {
    const startedAtMs = new Date(state.buildStartedAt).getTime();
    if (Number.isFinite(startedAtMs)) {
      return Math.max(0, carry + (now - startedAtMs));
    }
  }

  return Math.max(0, carry);
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type DeploymentStatus = "building" | "deploying" | "ready" | "failed" | "cancelled";

// ─── Context type ────────────────────────────────────────────────────────────

export interface DeploymentContextType {
  // Single source of truth
  config: DeploymentConfig;
  state: DeploymentState;
  terminalRef: React.MutableRefObject<Terminal | null>;
  canStreamContainer: React.MutableRefObject<boolean>;

  // Config updates
  updateConfig: (updates: Partial<DeploymentConfig>) => void;
  updateOptions: (updates: Partial<DeploymentConfig["options"]>) => void;

  // Prepare (resolve project info)
  initializeFromRepo: (
    owner: string,
    repo: string,
    force?: string,
    context?: { branch?: string; projectId?: string },
  ) => Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }>;
  initializeFromLocal: (
    path: string,
    context?: { projectId?: string },
  ) => Promise<{ success: boolean; error?: string; errorType?: string }>;

  // Build lifecycle
  startDeployment: (overrides?: { runtimeMode?: RuntimeMode }) => Promise<string | null>;
  connectToBuild: (deploymentId?: string, startBuild?: boolean) => Promise<void>;
  loadBuildSession: (deploymentId: string) => Promise<{ success: boolean; error?: string }>;
  stopDeployment: () => Promise<void>;
  redeploy: (deploymentId: string) => Promise<string | null>;
  respondToPrompt: (action: string) => Promise<void>;
  reset: () => void;

  // Terminal
  onTerminalReady: () => void;

  // Internal
  _setContainerFailed: (message: string) => void;
  steps: { label: string; icon: string }[];
  deploymentStatus: DeploymentStatus;
}
