import { api } from "./client";
import type { PrepareComposeService, PrepareProjectResponse } from "./deploy";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Projects API                                                      */
/* ------------------------------------------------------------------ */

export interface ScanProjectResponse {
  success: boolean;
  name: string;
  path: string;
  stack: PrepareProjectResponse["stack"];
  projectType: PrepareProjectResponse["projectType"];
  category: PrepareProjectResponse["category"];
  packageManager: PrepareProjectResponse["packageManager"];
  installCommand: PrepareProjectResponse["installCommand"];
  buildCommand: PrepareProjectResponse["buildCommand"];
  startCommand: PrepareProjectResponse["startCommand"];
  buildImage: PrepareProjectResponse["buildImage"];
  outputDirectory: PrepareProjectResponse["outputDirectory"];
  rootDirectory: PrepareProjectResponse["rootDirectory"];
  productionPaths: PrepareProjectResponse["productionPaths"];
  port: PrepareProjectResponse["port"];
  services?: PrepareComposeService[];
}

export const projectsApi = {
  /** Dashboard overview - projects list + stats numbers */
  getHome: () =>
    api.get<{ success: boolean; projects: any[]; numbers: Record<string, number> }>(
      endpoints.projects.home,
    ),

  /** Create or update a project (mandatory before build access) */
  ensure: (body: {
    projectId?: string;
    name: string;
    slug?: string;
    gitOwner?: string;
    gitRepo?: string;
    gitBranch?: string;
    framework?: string;
    localPath?: string;
    packageManager?: string;
    installCommand?: string;
    buildCommand?: string;
    outputDirectory?: string;
    productionPaths?: string;
    rootDirectory?: string;
    startCommand?: string;
    buildImage?: string;
    port?: number;
    publicEndpoints?: Array<{
      port?: number;
      targetPath?: string;
      domain?: string;
      customDomain?: string;
      domainType?: "free" | "custom";
    }>;
    hasServer?: boolean;
    hasBuild?: boolean;
    /** Project flavor - "monorepo" persists the sub-app + workspace fields below. */
    projectType?: "app" | "docker" | "services" | "monorepo";
    monorepoApps?: Array<{
      name: string;
      rootDirectory: string;
      framework?: string;
      packageManager?: string;
      buildImage?: string;
      installCommand?: string;
      buildCommand?: string;
      startCommand?: string;
      outputDirectory?: string;
      port?: number;
      enabled?: boolean;
      exposed?: boolean;
      domain?: string;
      customDomain?: string;
      domainType?: "free" | "custom";
      environment?: Record<string, string>;
    }>;
    monorepoWorkspace?: {
      packageManager: string;
      installCommand?: string;
    };
  }) => api.post<any>(endpoints.projects.ensure, body),

  /** List local projects only */
  getLocal: () => api.get<{ success: boolean; projects: any[] }>(endpoints.projects.local),

  /** Scan a local directory for framework detection */
  scan: (path: string) =>
    api.post<ScanProjectResponse>(endpoints.projects.scan, { path }),

  /** Import a local folder as a project */
  importLocal: (data: {
    name: string;
    localPath: string;
    framework?: string;
    packageManager?: string;
    buildCommand?: string;
    installCommand?: string;
    outputDirectory?: string;
    rootDirectory?: string;
    startCommand?: string;
    productionPaths?: string;
    buildImage?: string;
    port?: number;
    hasServer?: boolean;
    hasBuild?: boolean;
  }) => api.post<{ data: any }>(endpoints.projects.import, data),

  /** Delete a local project */
  deleteLocal: (id: string) => api.delete<{ message: string }>(`projects/${id}`),

  /** Single project info */
  getInfo: (id: string | number) => api.get<any>(endpoints.projects.info(id)),

  /** List sibling environments for the same app/repo */
  getEnvironments: (id: string | number) =>
    api.get<{ success: boolean; data: any[] }>(endpoints.projects.environments(id)),

  /** Create an isolated project environment under the same app/repo */
  createEnvironment: (
    id: string | number,
    body: {
      environmentName: string;
      environmentSlug?: string;
      environmentType?: "production" | "preview" | "development";
      gitBranch?: string;
      sourceMode?: "branch" | "manual";
    },
  ) =>
    api.post<{ success: boolean; data?: any; error?: string }>(
      endpoints.projects.environments(id),
      body,
    ),

  /** Delete a project app or a single environment.
   *  `wipeVolumes=true` ALSO removes Docker named volumes attached to the
   *  project's containers - destroys persistent data (DBs, caches, etc.).
   *  Default is false: data survives so the user can recover. */
  delete: (
    id: string | number,
    body: { deleteApp?: boolean; wipeVolumes?: boolean } = {},
  ) => api.delete<any>(endpoints.projects.item(id), { body }),

  /** Read-only snapshot of what `delete(id)` will remove - services and their
   *  named volumes, project networks. Cheap, safe to call on modal open. */
  deletionPreview: (id: string | number) =>
    api.get<{
      success: boolean;
      preview: {
        projectId: string;
        projectName: string;
        selfHosted: boolean;
        services: Array<{
          id: string;
          name: string;
          image: string | null;
          volumes: string[];
          hasContainer: boolean;
        }>;
        deploymentVolumes: string[];
        networks: string[];
        totalVolumes: number;
      };
    }>(`${endpoints.projects.item(id)}/deletion-preview`),

  /** Update name or description — pass any subset of TUpdateProjectBody fields. */
  update: (id: string | number, fields: Record<string, unknown>) =>
    api.patch<any>(endpoints.projects.item(id), fields),

  /**
   * Get the per-project clone-token state. Returns only `{ hasToken, setAt }`
   * - never the token itself.
   */
  getCloneToken: (id: string | number) =>
    api.get<{ hasToken: boolean; setAt: string | null }>(endpoints.projects.cloneToken(id)),

  /**
   * Set/replace/clear the per-project clone token override. Highest priority
   * in `resolveCloneToken`'s chain - used when the user wants a Fine-Grained
   * PAT scoped to just this repo.
   *   - token: null/empty → clear
   *   - token: string     → encrypt + store
   */
  updateCloneToken: (id: string | number, body: { token: string | null }) =>
    api.patch<{ hasToken: boolean; setAt: string | null }>(
      endpoints.projects.cloneToken(id),
      body,
    ),

  /** Update full project fields */
  patch: (
    id: string | number,
    body: {
      name?: string;
      slug?: string;
      port?: number;
      publicEndpoints?: Array<{
        port?: number;
        targetPath?: string;
        domain?: string;
        customDomain?: string;
        domainType?: "free" | "custom";
      }>;
      hasServer?: boolean;
      hasBuild?: boolean;
    },
  ) => api.patch<any>(endpoints.projects.item(id), body),

  /** Update build options (single field) */
  setOptions: (id: string | number, options: Record<string, any>) =>
    api.post<any>(endpoints.projects.options(id), options),

  /** Enable or disable a project */
  toggle: (id: string | number, enable: boolean) =>
    api.post<any>(endpoints.projects.toggle(id, enable ? "enable" : "disable")),

  /** Clear CDN / proxy cache */
  clearCache: (id: string | number) => api.post<any>(endpoints.projects.clearCache(id)),

  /** Clear build artifacts */
  clearBuild: (id: string | number) => api.post<any>(endpoints.projects.clearBuild(id)),

  /** Create a new deployment session */
  createDeploymentSession: (id: string | number) =>
    api.post<any>(endpoints.projects.deploymentSession(id)),

  /** Connect a custom domain */
  connectDomain: (id: string | number, body: { domain: string; includeWww: boolean }) =>
    api.post<any>(endpoints.projects.connect(id), body),

  /** Set environment variables */
  setEnv: (id: string | number, envVars: any) =>
    api.put<any>(endpoints.projects.env(id), envVars),

  /** Get environment variables */
  getEnv: (id: string | number) => api.get<any>(endpoints.projects.env(id)),

  /** Get git settings */
  getGit: (id: string | number) => api.get<any>(endpoints.projects.git(id)),

  /** Link a GitHub repo to an existing project + register webhook */
  linkRepo: (
    id: string | number,
    body: { owner: string; repo: string; branch?: string; installationId?: number },
  ) => api.post<any>(endpoints.projects.gitLink(id), body),

  /** List branches */
  getBranches: (id: string | number) => api.get<any>(endpoints.projects.branches(id)),

  /** Set active branch */
  setBranch: (id: string | number, branch: string) =>
    api.post<any>(endpoints.projects.branch(id), { branch }),

  /** Toggle git auto-deploy via git/switch */
  gitSwitch: (id: string | number, auto_deploy: boolean) =>
    api.post<any>(endpoints.projects.gitSwitch(id), { auto_deploy }),

  /** Toggle auto-deploy setting */
  setAutoDeploy: (id: string | number, enabled: boolean) =>
    api.post<any>(endpoints.projects.autoDeploy(id), { enabled }),

  /** Set or clear the webhook domain */
  setWebhookDomain: (id: string | number, domain: string | null) =>
    api.post<any>(endpoints.projects.webhookDomain(id), { domain }),

  /** Set resources (POST - tier-based) */
  setResources: (id: string | number, resources: Record<string, any>) =>
    api.post<any>(endpoints.projects.resources(id), resources),

  /** Update resources (PUT - raw values) */
  updateResources: (id: string | number, resources: Record<string, any>) =>
    api.put<any>(endpoints.projects.resources(id), resources),

  /** Set sleep-mode */
  setSleepMode: (id: string | number, sleep_mode: string) =>
    api.post<any>(endpoints.projects.sleepMode(id), { sleep_mode }),

  /** List deployments for a project */
  getDeployments: (id: string | number) => api.get<any>(endpoints.projects.deployments(id)),
};
