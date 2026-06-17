"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { githubApi } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";
import { getApiBaseUrl } from "@/lib/api/client";
import { openAuthWindow } from "@/utils/authWindow";

/* ── Types ────────────────────────────────────────────────────────── */

export interface GitHubAccount {
  login: string;
  avatar_url: string;
  type: "User" | "Organization";
  name?: string;
  /**
   * Where this account came from. Mirrors MappedAccount.source on the
   * backend. The settings GitHub card filters on this to refuse
   * rendering CLI org memberships as App installations.
   *
   *  - "app" → real GitHub App installation
   *  - "cli" → gh CLI org membership (local-only)
   */
  source?: "app" | "cli";
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string;
  private: boolean;
  stars: number;
  stargazers_count?: number;
  forks: number;
  forks_count?: number;
  language: string;
  updated_at: string;
  default_branch: string;
  owner: { login: string; avatar_url: string } | string;
  html_url?: string;
  /**
   * Where this repo was sourced from (cloud-app mode only):
   *   - "app"  → covered by a GitHub App installation. Deployable
   *              anywhere (local + remote) via short-lived install tokens.
   *   - "cli"  → seen by the local gh CLI but NOT covered by an App
   *              installation. Local builds only — remote deploys are
   *              refused by clone-auth (GITHUB_APP_INSTALLATION_REQUIRED).
   *   - "both" → visible via both sources. Same capabilities as "app".
   * Undefined for SaaS mode + legacy code paths (App is the only source).
   */
  source?: "app" | "cli" | "both";
}

/**
 * Canonical GitHub connection state from the backend. Mirrors
 * `GitHubConnectionState` in apps/api/src/modules/github/github.types.ts —
 * the single source of truth for "is GitHub connected? which source is
 * primary?". No `mode` field: the global platform mode lives in
 * PlatformContext (`selfHosted`).
 */
export interface GitHubConnectionState {
  sources: {
    openshipApp: {
      connected: boolean;
      login?: string;
      avatarUrl?: string;
      hasInstallations?: boolean;
    };
    ghCli: {
      available: boolean;
      login?: string;
      avatarUrl?: string;
    };
  };
  primary: "openship-app" | "gh-cli" | null;
}

interface GitHubContextValue {
  /** Canonical GitHub connection state. Read this for anything connection-related. */
  state: GitHubConnectionState;
  /** Derived: `state.primary !== null`. Provided as a convenience for the
   *  many existing call sites that just need a "is anything connected" check. */
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  /**
   * Initiate a GitHub connection. `source` discriminates which dual-source
   * card was clicked in cli mode — "oauth" forces the Openship App install
   * flow even when gh CLI is already authenticated. Omit on legacy modes.
   */
  connect: (source?: "oauth" | "cli") => Promise<void>;
  disconnect: (source?: "oauth" | "cli" | "all") => Promise<void>;

  /* CLI / Device flow */
  cliAction: CliAction | null;

  /* Data */
  accounts: GitHubAccount[];
  userLogin: string;
  selectedOwner: string;
  setSelectedOwner: (owner: string) => void;
  repos: GitHubRepo[];
  loadingRepos: boolean;

  /* Actions */
  refresh: () => Promise<void>;
  fetchReposForOwner: (owner: string) => Promise<void>;

  /* App mode */
  installUrl: string | null;
}

export type CliAction =
  | { type: "terminal"; command: string; message: string }
  | { type: "device_flow"; userCode: string; verificationUri: string; expiresIn: number; interval: number };

const GitHubContext = createContext<GitHubContextValue | undefined>(undefined);

export function useGitHub() {
  const ctx = useContext(GitHubContext);
  if (!ctx) throw new Error("useGitHub must be used within GitHubProvider");
  return ctx;
}

/* ── Provider ─────────────────────────────────────────────────────── */

interface GitHubProviderProps {
  children: React.ReactNode;
  initialData?: any;
}

const EMPTY_STATE: GitHubConnectionState = {
  sources: {
    openshipApp: { connected: false },
    ghCli: { available: false },
  },
  primary: null,
};

export function GitHubProvider({ children, initialData }: GitHubProviderProps) {
  // Note: setSelfHosted is no longer driven from this context — the
  // global platform mode is owned by PlatformContext and read from
  // env.CLOUD_MODE during the initial dashboard layout. We deliberately
  // don't shadow it here.
  const [state, setState] = useState<GitHubConnectionState>(
    initialData?.state ?? EMPTY_STATE,
  );
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(!initialData);

  const [cliAction, setCliAction] = useState<CliAction | null>(null);
  const [accounts, setAccounts] = useState<GitHubAccount[]>(initialData?.accounts || []);
  const [userLogin, setUserLogin] = useState(
    initialData?.state?.sources?.openshipApp?.login ||
      initialData?.state?.sources?.ghCli?.login ||
      "",
  );
  const [selectedOwner, setSelectedOwnerState] = useState(userLogin);
  const [repos, setRepos] = useState<GitHubRepo[]>(initialData?.repos || []);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [installUrl, setInstallUrl] = useState<string | null>(initialData?.installUrl || null);
  const initRef = useRef(false);

  // Convenience derived from state.primary — every existing call site
  // that read `connected` keeps working.
  const connected = state.primary !== null;

  /* ── Fetch connection info ──────────────────────────────────── */
  const refresh = useCallback(async () => {
    try {
      const res = await githubApi.getUserHome();
      const nextState: GitHubConnectionState = res?.state ?? EMPTY_STATE;
      setState(nextState);

      if (res?.installUrl) setInstallUrl(res.installUrl);
      else setInstallUrl(null);

      if (nextState.primary !== null) {
        setCliAction(null);
        setAccounts(res.accounts ?? []);
        const primaryLogin =
          nextState.sources.openshipApp.login ??
          nextState.sources.ghCli.login ??
          "";
        setUserLogin(primaryLogin);
        if (!selectedOwner && primaryLogin) {
          setSelectedOwnerState(primaryLogin);
        }
        setRepos(res.repos ?? []);
      } else {
        setAccounts([]);
        setRepos([]);
      }
    } catch {
      setState(EMPTY_STATE);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── On mount ───────────────────────────────────────────────── */
  useEffect(() => {
    // If we have SSR initialData, don't double fetch!
    if (initialData) return;

    if (initRef.current) return;
    initRef.current = true;
    refresh();
  }, [refresh, initialData]);

  /* ── Connect GitHub ─────────────────────────────────────────── */
  const connect = useCallback(async (source?: "oauth" | "cli") => {
    setConnecting(true);
    setCliAction(null);

    const finishRedirectFlow = () => {
      setConnecting(false);
      void refresh();

      // The popup can close before cookies/DB writes are visible to the
      // dashboard request, so do a couple of quiet follow-up checks.
      window.setTimeout(() => void refresh(), 750);
      window.setTimeout(() => void refresh(), 2000);
    };

    try {
      const res = await githubApi.connect(source);

      // Already connected - just refresh
      if (res?.connected) {
        setConnecting(false);
        refresh();
        return;
      }

      switch (res?.flow) {
        case "redirect": {
          // Prefer a backend-provided URL when the next step is known
          // (for example, GitHub App installation after OAuth).
          const redirectUrl = res.url ?? `${getApiBaseUrl()}${endpoints.github.connectRedirect}`;
          const handle = openAuthWindow(redirectUrl);
          handle.onClose(finishRedirectFlow);
          return;
        }

        case "device_code":
          // Show verification code inline
          setCliAction({
            type: "device_flow",
            userCode: res.userCode,
            verificationUri: res.verificationUri,
            expiresIn: res.expiresIn,
            interval: res.interval,
          });
          setConnecting(false);
          return;

        case "terminal":
          // Show terminal instruction
          setCliAction({ type: "terminal", command: res.command, message: res.message });
          setConnecting(false);
          return;

        default:
          setConnecting(false);
      }
    } catch {
      setConnecting(false);
    }
  }, [refresh]);

  /* ── Disconnect GitHub ──────────────────────────────────────── */
  const disconnect = useCallback(
    async (source: "oauth" | "cli" | "all" = "all") => {
      try {
        await githubApi.disconnect(source);
        // Always refresh — the canonical state on the backend is now the
        // source of truth, and a per-source disconnect may still leave
        // the other source connected (e.g. cli logged out but the
        // Openship App still installed).
        await refresh();
      } catch {
        /* silent */
      }
    },
    [refresh],
  );

  /* ── Device flow polling ────────────────────────────────────── */
  useEffect(() => {
    if (cliAction?.type !== "device_flow") return;

    const interval = (cliAction.interval || 5) * 1000;
    const timer = setInterval(async () => {
      try {
        const res = await githubApi.pollConnect();
        if (res?.status === "complete") {
          setCliAction(null);
          refresh();
        } else if (res?.status === "error") {
          setCliAction(null);
        }
      } catch { /* keep polling */ }
    }, interval);

    return () => clearInterval(timer);
  }, [cliAction, refresh]);

  /* ── Fetch repos for an owner ───────────────────────────────── */
  const fetchReposForOwner = useCallback(
    async (owner: string) => {
      if (!owner || !connected) return;
      setLoadingRepos(true);
      try {
        // Backend is mode-aware - handles cloud (installation) vs desktop (OAuth) 
        const res = await githubApi.getUserRepos(owner);
        if (res && !res.error) {
          const list = Array.isArray(res) ? res : res.data ?? res.repos ?? [];
          setRepos(list);
        } else {
          setRepos([]);
        }
      } catch {
        setRepos([]);
      } finally {
        setLoadingRepos(false);
      }
    },
    [connected]
  );

  /* ── Owner change → fetch repos ─────────────────────────────── */
  const setSelectedOwner = useCallback(
    (owner: string) => {
      setSelectedOwnerState(owner);
      if (owner && owner !== selectedOwner) {
        fetchReposForOwner(owner);
      }
    },
    [selectedOwner, fetchReposForOwner]
  );

  return (
    <GitHubContext.Provider
      value={{
        state,
        connected,
        connecting,
        loading,
        connect,
        disconnect,
        cliAction,
        accounts,
        userLogin,
        selectedOwner,
        setSelectedOwner,
        repos,
        loadingRepos,
        refresh,
        fetchReposForOwner,
        installUrl,
      }}
    >
      {children}
    </GitHubContext.Provider>
  );
}
