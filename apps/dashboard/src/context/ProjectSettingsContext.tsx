"use client";
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
  useRef,
  useMemo,
} from "react";
import { projectsApi, servicesApi, type Service } from "@/lib/api";

interface BasicProjectData {
  name: string;
  description: string;
  framework: string;
  [key: string]: any;
}


interface DomainsData {
  domains: any[];
  isLoading: boolean;
  error: string | null;
}

interface EnvironmentData {
  envVars: any;
  isLoading: boolean;
  error: string | null;
}

interface GitData {
  repository: any;
  branch: string;
  recentCommits: any[];
  isLoading: boolean;
  error: string | null;
  autoDeployEnabled?: boolean;
  webhookActive?: boolean;
  webhookStrategy?: "app" | "domain" | "repo" | "none";
  webhookDomain?: string | null;
  availableStrategies?: string[];
  verifiedDomains?: Array<{ hostname: string; ssl: boolean }>;
  installationInstalled?: boolean;
  installUrl?: string;
}

interface ProjectEnvironment {
  id: string;
  name: string;
  slug: string;
  type: "production" | "preview" | "development";
  gitBranch: string;
  projectSlug: string;
  activeDeploymentId: string | null;
  latestDeploymentStatus: string | null;
  primaryDomain: string | null;
}

interface BuildData {
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string;
  installCommand: string;
  startCommand: string;
  productionPort: string;
  buildImage: string;
  rootDirectory: string;
  hasBuild: boolean;
  hasServer: boolean;
  isLoading: boolean;
  error: string | null;
}

interface TerminalLogsData {
  logs: string[];
  isStreaming: boolean;
  sseConnection: { disconnect: () => void } | null;
  xtermInstance: any | null;
}

interface ServerLogsData {
  logs: any[];
  mockInterval: NodeJS.Timeout | null;
}

interface ServicesData {
  services: Service[];
  isLoading: boolean;
  error: string | null;
}

interface ProjectSettingsContextType {
  // Project basic data
  projectData: BasicProjectData;
  setProjectData: React.Dispatch<React.SetStateAction<BasicProjectData>>;
  updateProjectData: (updates: Partial<BasicProjectData>) => Promise<void>;

  // Domains
  domainsData: DomainsData;
  updateDomains: (domains: any[]) => Promise<void>;

  // Environment
  environmentData: EnvironmentData;
  updateEnvironment: (envVars: any) => Promise<void>;
  refreshEnvironment: () => Promise<void>;

  // Git
  gitData: GitData;
  refreshGit: () => Promise<void>;

  // Build
  buildData: BuildData;
  updateBuild: (buildInfo: any) => Promise<void>;

  // Terminal Logs
  terminalLogsData: TerminalLogsData;
  addTerminalLog: (log: string) => void;
  clearTerminalLogs: () => void;
  setTerminalStreaming: (isStreaming: boolean) => void;
  setTerminalXtermInstance: (instance: any) => void;

  // Server Logs
  serverLogsData: ServerLogsData;
  addServerLog: (log: any) => void;
  mergeServerLogs: (logs: any[]) => void;
  setServerLogs: (logs: any[]) => void;
  clearServerLogs: () => void;

  // Services
  servicesData: ServicesData;
  refreshServices: () => Promise<Service[]>;
  hasMultipleServices: boolean;

  // Global state
  projectNotFound: boolean;
  errorType: "project-not-found" | "repo-not-found" | "access-denied" | null;
  id: string;
  environments: ProjectEnvironment[];
  createEnvironment: (input: {
    environmentName: string;
    environmentSlug?: string;
    environmentType?: "production" | "preview" | "development";
    gitBranch?: string;
    sourceMode?: "branch" | "manual";
  }) => Promise<ProjectEnvironment | null>;
  domain: string;
  slug?: string[]; // Optional array for catch-all routes
  activeTab: string;
  setActiveTab: (tab: string) => void;
  tabs: { id: string; label: string; icon: string }[];
}

const ProjectSettingsContext = createContext<ProjectSettingsContextType | undefined>(undefined);


interface ProviderProps {
  children: ReactNode;
  id: string;
  slug?: string[]; // Optional array for catch-all routes
  initialProjectData?: BasicProjectData;
}

export const ProjectSettingsProvider: React.FC<ProviderProps> = ({
  children,
  id,
  slug,
  initialProjectData,
}) => {
  const [projectData, setProjectData] = useState<BasicProjectData>(
    initialProjectData || {
      name: "",
      description: "",
      framework: "",
    },
  );

  // Analytics + projectInfo state moved to `@/hooks/useProjectEndpoints`.
  // The provider no longer fires those fetches — consumers call the
  // hooks directly and the module-level cache dedups across components.

  const [domainsData, setDomainsData] = useState<DomainsData>({
    domains: [],
    isLoading: false,
    error: null,
  });

  const [environmentData, setEnvironmentData] = useState<EnvironmentData>({
    envVars: {},
    isLoading: false,
    error: null,
  });

  const [gitData, setGitData] = useState<GitData>({
    repository: null,
    branch: "",
    recentCommits: [],
    isLoading: false,
    error: null,
  });

  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);

  const [buildData, setBuildData] = useState<BuildData>({
    buildCommand: "",
    outputDirectory: ".",
    productionPaths: "",
    installCommand: "bun install",
    startCommand: "npm start",
    productionPort: "3000",
    buildImage: "node:22",
    rootDirectory: "./",
    hasBuild: true,
    hasServer: true,
    isLoading: true,
    error: null,
  });

  const [terminalLogsData, setTerminalLogsData] = useState<TerminalLogsData>({
    logs: [],
    isStreaming: false,
    sseConnection: null,
    xtermInstance: null,
  });

  const [serverLogsData, setServerLogsData] = useState<ServerLogsData>({
    logs: [],
    mockInterval: null,
  });

  const [servicesData, setServicesData] = useState<ServicesData>({
    services: [],
    isLoading: false,
    error: null,
  });

  const [projectNotFound, setProjectNotFound] = useState(false);
  const [errorType, setErrorType] = useState<
    "project-not-found" | "repo-not-found" | "access-denied" | null
  >(null);
  const [domain, setDomain] = useState("");

  // Derived: do we have multi-service rendering paths to enable? The
  // assignment was accidentally stripped along with the analytics
  // refactor; restoring it here matches the original semantics —
  // projectData hint OR serviceCount > 1 OR loaded services > 1.
  const hasMultipleServices =
    projectData.hasMultipleServices === true ||
    Number(projectData.serviceCount ?? 0) > 1 ||
    servicesData.services.length > 1;

  const isLoadingEnvironmentRef = useRef(false);
  // Fetch environment
  const refreshEnvironment = useCallback(async () => {
    try {
      if (isLoadingEnvironmentRef.current) return;
      isLoadingEnvironmentRef.current = true;
      setEnvironmentData((prev) => ({ ...prev, isLoading: true, error: null }));

      if (!id) {
        setEnvironmentData((prev) => ({ ...prev, isLoading: false }));
        return;
      }

      const response = await projectsApi.getEnv(id);

      if (response.success) {
        // Convert array format to expected format
        const envVarsArray = response.data || [];
        const envVars = {
          development: envVarsArray.map((env: any, index: number) => ({
            id: Date.now() + index,
            key: env.key,
            value: env.value,
            encrypted: true,
          })),
          preview: [],
          production: [],
        };

        setEnvironmentData({
          envVars: envVars,
          isLoading: false,
          error: null,
        });
      } else {
        setEnvironmentData((prev) => ({
          ...prev,
          isLoading: false,
        }));
      }
    } catch (error) {
      console.error("Failed to fetch environment variables:", error);
      setEnvironmentData((prev) => ({
        ...prev,
        isLoading: false,
      }));
    } finally {
      isLoadingEnvironmentRef.current = false;
    }
  }, [id]);

  // Fetch git
  const isLoadingGitRef = useRef(false);
  const refreshGit = useCallback(async () => {
    try {
      if (isLoadingGitRef.current) return;
      isLoadingGitRef.current = true;
      setGitData((prev) => ({ ...prev, isLoading: true, error: null }));

      if (!id) {
        setGitData((prev) => ({ ...prev, isLoading: false }));
        return;
      }

      const response = await projectsApi.getGit(id);

      if (response.success) {
        // Map commits from API response
        const mappedCommits = (response.commits || []).map((commit: any) => ({
          id: commit.sha,
          message: commit.message || "No message",
          author: commit.author || "Unknown",
          authorAvatar: commit.author_avatar || "",
          time: commit.date ? new Date(commit.date).toLocaleString() : "",
          url: commit.url,
        }));

        setGitData({
          repository: {
            name: `${response.owner}/${response.repo}`,
            provider: "GitHub",
            url: `https://github.com/${response.owner}/${response.repo}`,
          },
          branch: response.branch || "main",
          recentCommits: mappedCommits,
          isLoading: false,
          error: null,
          autoDeployEnabled: response.auto_deploy,
          webhookActive: response.webhook_active,
          webhookStrategy: response.webhook_strategy,
          webhookDomain: response.webhook_domain,
          availableStrategies: response.available_strategies,
          verifiedDomains: response.verified_domains,
          installationInstalled: response.installation_installed,
          installUrl: response.install_url,
        });
      } else {
        // Check if it's a repo not found error
        const isRepoError =
          response.error?.toLowerCase().includes("repository") ||
          response.error?.toLowerCase().includes("repo");

        if (isRepoError) {
          setProjectNotFound(true);
          setErrorType("repo-not-found");
        }

        setGitData((prev) => ({
          ...prev,
          isLoading: false,
          error: response.error || "Failed to load git data",
          repository: null,
          recentCommits: [],
        }));
      }
    } catch (error) {
      console.error("Failed to fetch git data:", error);
      setGitData((prev) => ({
        ...prev,
        isLoading: false,
        error: "Failed to load git data",
        repository: null,
        recentCommits: [],
      }));
    } finally {
      isLoadingGitRef.current = false;
    }
  }, [id]);

  // Update functions
  const updateProjectData = async (updates: Partial<BasicProjectData>) => {
    setProjectData((prev) => ({ ...prev, ...updates }));
    // Add your API call here to persist changes
  };

  const updateDomains = async (domains: any[]) => {
    setDomainsData((prev) => ({ ...prev, domains }));
    // Add your API call here to persist changes
  };

  const updateEnvironment = async (envVars: any) => {
    setEnvironmentData((prev) => ({ ...prev, envVars }));
    // Add your API call here to persist changes
  };

  const updateBuild = async (buildInfo: any) => {
    setBuildData((prev) => ({ ...prev, ...buildInfo }));
    // Add your API call here to persist changes
  };

  const servicesRequestRef = useRef<{ projectId: string; promise: Promise<Service[]> } | null>(
    null,
  );
  const servicesRequestIdRef = useRef(0);

  const refreshServices = useCallback(async () => {
    if (!id || id === "undefined") {
      servicesRequestIdRef.current += 1;
      servicesRequestRef.current = null;
      setServicesData({ services: [], isLoading: false, error: null });
      return [];
    }

    if (servicesRequestRef.current?.projectId === id) {
      return servicesRequestRef.current.promise;
    }

    const requestId = servicesRequestIdRef.current + 1;
    servicesRequestIdRef.current = requestId;

    let promise!: Promise<Service[]>;
    promise = (async () => {
      setServicesData((prev) => ({ ...prev, isLoading: true, error: null }));

      try {
        const response = await servicesApi.list(id);
        const services = response.success ? (response.services ?? []) : [];
        if (servicesRequestIdRef.current === requestId) {
          setServicesData({
            services,
            isLoading: false,
            error: response.success ? null : "Failed to load services",
          });
        }
        return services;
      } catch (error) {
        console.error("Failed to fetch project services:", error);
        if (servicesRequestIdRef.current === requestId) {
          setServicesData({
            services: [],
            isLoading: false,
            error: "Failed to load services",
          });
        }
        return [];
      } finally {
        if (servicesRequestRef.current?.promise === promise) {
          servicesRequestRef.current = null;
        }
      }
    })();

    servicesRequestRef.current = { projectId: id, promise };
    return promise;
  }, [id]);

  const refreshEnvironments = useCallback(async () => {
    if (!id) return;
    const response = await projectsApi.getEnvironments(id);
    if (response.success) {
      setEnvironments(response.data || []);
    }
  }, [id]);

  const createEnvironment = useCallback(
    async (input: {
      environmentName: string;
      environmentSlug?: string;
      environmentType?: "production" | "preview" | "development";
      gitBranch?: string;
      sourceMode?: "branch" | "manual";
    }) => {
      if (!id) return null;
      const response = await projectsApi.createEnvironment(id, input);
      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to create environment");
      }
      await refreshEnvironments();
      return response.data as ProjectEnvironment;
    },
    [id, refreshEnvironments],
  );

  // Terminal Logs Management
  const MAX_TERMINAL_LOGS = 1000;

  const addTerminalLog = useCallback((log: string) => {
    setTerminalLogsData((prev) => ({
      ...prev,
      logs: [...prev.logs, log].slice(-MAX_TERMINAL_LOGS),
    }));
  }, []);

  const clearTerminalLogs = useCallback(() => {
    setTerminalLogsData((prev) => ({
      ...prev,
      logs: [],
    }));
  }, []);

  const setTerminalStreaming = useCallback((isStreaming: boolean) => {
    setTerminalLogsData((prev) => {
      if (prev.isStreaming === isStreaming) {
        return prev;
      }

      return {
        ...prev,
        isStreaming,
      };
    });
  }, []);

  const setTerminalXtermInstance = useCallback((instance: any) => {
    setTerminalLogsData((prev) => ({
      ...prev,
      xtermInstance: instance,
    }));
  }, []);

  // Server Logs Management
  const MAX_SERVER_LOGS = 100;

  const getServerLogKey = useCallback((log: any) => {
    if (!log || typeof log !== "object") return String(log);
    const parsedTimestamp =
      typeof log.timestamp === "string" ? Date.parse(log.timestamp) : Number.NaN;
    const timestampKey = Number.isFinite(parsedTimestamp)
      ? Math.floor(parsedTimestamp / 1000)
      : String(log.timestamp ?? "");

    return [
      timestampKey,
      log.ip,
      log.method,
      log.path,
      log.statusCode,
      log.responseTime,
      log.requestSize,
      log.responseSize,
    ].join("|");
  }, []);

  const dedupeServerLogs = useCallback(
    (logs: any[]) => {
      const seen = new Set<string>();
      const merged: any[] = [];

      for (const log of logs) {
        const key = getServerLogKey(log);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(log);
        if (merged.length >= MAX_SERVER_LOGS) break;
      }

      return merged;
    },
    [getServerLogKey],
  );

  const addServerLog = useCallback(
    (log: any) => {
      setServerLogsData((prev) => ({
        ...prev,
        logs: dedupeServerLogs([log, ...prev.logs]),
      }));
    },
    [dedupeServerLogs],
  );

  const mergeServerLogs = useCallback(
    (logs: any[]) => {
      setServerLogsData((prev) => ({
        ...prev,
        logs: dedupeServerLogs([...prev.logs, ...logs]),
      }));
    },
    [dedupeServerLogs],
  );

  const setServerLogs = useCallback(
    (logs: any[]) => {
      setServerLogsData((prev) => ({
        ...prev,
        logs: dedupeServerLogs(logs),
      }));
    },
    [dedupeServerLogs],
  );

  const clearServerLogs = useCallback(() => {
    setServerLogsData((prev) => ({
      ...prev,
      logs: [],
    }));
  }, []);

  // Cleanup on unmount - use refs to avoid re-running on data changes
  const terminalSSERef = useRef(terminalLogsData.sseConnection);
  const serverIntervalRef = useRef(serverLogsData.mockInterval);

  // Keep refs in sync
  useEffect(() => {
    terminalSSERef.current = terminalLogsData.sseConnection;
  }, [terminalLogsData.sseConnection]);

  useEffect(() => {
    serverIntervalRef.current = serverLogsData.mockInterval;
  }, [serverLogsData.mockInterval]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      // Cleanup terminal SSE connection
      if (terminalSSERef.current) {
        terminalSSERef.current.disconnect();
      }
      // Cleanup server mock interval
      if (serverIntervalRef.current) {
        clearInterval(serverIntervalRef.current);
      }
    };
  }, []); // Empty deps - only run on mount/unmount

  // Map legacy tab IDs to new ones
  const resolveTab = (tab?: string) => {
    if (tab === "general") return "overview";
    if (tab === "git") return "source";
    if (tab === "settings" || tab === "build") return "runtime";
    return tab || undefined; // let default be set by tab list below
  };

  const tabs = useMemo(() => {
    return [
      { id: "overview", label: "Overview", icon: "setting-100-1658432731.png" },
      { id: "services", label: "Services", icon: "layers.png" },
      { id: "domains", label: "Domains", icon: "server-59-1658435258.png" },
      { id: "deployments", label: "Deployments", icon: "heart%20rate-118-1658433496.png" },
      { id: "source", label: "Source", icon: "git%20branch-159-1658431404.png" },
      { id: "runtime", label: "Runtime", icon: "setting-40-1662364403.png" },
      { id: "logs", label: "Logs", icon: "terminal-184-1658431404.png" },
      { id: "advanced", label: "Advanced", icon: "error%20triangle-81-1658234612.png" },
    ];
  }, []);

  const defaultTab = tabs[0].id;
  const [activeTab, setActiveTab] = useState(resolveTab(slug?.[0]) || defaultTab);

  useEffect(() => {
    void refreshServices();
  }, [refreshServices]);

  // Sync activeTab with slug changes (for browser back/forward navigation)
  const slugTab = slug?.[0];
  useEffect(() => {
    const resolved = resolveTab(slugTab) || defaultTab;
    // If the resolved tab isn't valid for this project type, fall back to default
    const validIds = tabs.map((t) => t.id);
    const target = validIds.includes(resolved) ? resolved : defaultTab;
    if (target !== activeTab) {
      setActiveTab(target);
    }
  }, [slugTab, defaultTab, tabs]); // Only watch slug[0] to avoid array reference issues

  const value: ProjectSettingsContextType = useMemo(
    () => ({
      projectData,
      setProjectData,
      updateProjectData,

      domainsData,
      updateDomains,

      environmentData,
      updateEnvironment,
      refreshEnvironment,

      gitData,
      refreshGit,

      buildData,
      updateBuild,

      terminalLogsData,
      addTerminalLog,
      clearTerminalLogs,
      setTerminalStreaming,
      setTerminalXtermInstance,

      serverLogsData,
      addServerLog,
      mergeServerLogs,
      setServerLogs,
      clearServerLogs,

      servicesData,
      refreshServices,
      hasMultipleServices,

      projectNotFound,
      errorType,
      id,
      environments,
      createEnvironment,
      domain,
      slug,
      activeTab,
      setActiveTab,
      tabs,
    }),
    [
      projectData,
      domainsData,
      updateDomains,
      environmentData,
      updateEnvironment,
      refreshEnvironment,
      gitData,
      refreshGit,
      buildData,
      updateBuild,
      terminalLogsData,
      addTerminalLog,
      clearTerminalLogs,
      setTerminalStreaming,
      setTerminalXtermInstance,
      serverLogsData,
      addServerLog,
      mergeServerLogs,
      setServerLogs,
      clearServerLogs,
      servicesData,
      refreshServices,
      hasMultipleServices,
      projectNotFound,
      errorType,
      id,
      environments,
      createEnvironment,
      domain,
      slug,
      activeTab,
      tabs,
    ],
  );

  return (
    <ProjectSettingsContext.Provider value={value}>{children}</ProjectSettingsContext.Provider>
  );
};

export const useProjectSettings = () => {
  const context = useContext(ProjectSettingsContext);
  if (context === undefined) {
    throw new Error("useProjectSettings must be used within a ProjectSettingsProvider");
  }
  return context;
};
