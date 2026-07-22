"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Github,
  ExternalLink,
  Unplug,
  RefreshCw,
  Download,
  Terminal,
  Cloud,
  ShieldCheck,
  Key,
  KeyRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useGitHub,
  type GitHubConnectionState,
  type GitHubAccount,
} from "@/context/GitHubContext";
import { useCloud } from "@/context/CloudContext";
import { useModal } from "@/context/ModalContext";
import { usePlatform } from "@/context/PlatformContext";
import { githubApi } from "@/lib/api";
import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

const EMPTY_STATE: GitHubConnectionState = {
  sources: { openshipApp: { connected: false }, ghCli: { available: false } },
  primary: null,
};

export function GitHubConnection() {
  // The Settings card owns the App-connection truth. The library context
  // (useGitHub) is now gh-first and does NOT probe the App, so we fetch
  // GET /github/status here — the cloud round-trip for the App badge +
  // installations happens on THIS page only, never on a plain library browse.
  // Actions (connect/disconnect/connecting) still come from the shared context.
  const { connecting, connect: ctxConnect, disconnect: ctxDisconnect } = useGitHub();
  const { t } = useI18n();
  const router = useRouter();

  const [state, setState] = useState<GitHubConnectionState>(EMPTY_STATE);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async (force = false) => {
    setLoading(true);
    try {
      // Live (no TTL cache) but de-duplicated across concurrent callers (the
      // library App badge shares this in-flight request). `force` bypasses a
      // pre-mutation in-flight after connect/disconnect.
      const res = await githubApi.getStatusDeduped<any>(force);
      setState(res?.state ?? EMPTY_STATE);
      setAccounts(res?.accounts ?? []);
      setInstallUrl(res?.installUrl || null);
    } catch {
      setState(EMPTY_STATE);
      setAccounts([]);
      setInstallUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Connect/install opens a separate window (OAuth popup or the GitHub App
  // install tab). The connect call returns as soon as that window opens, so
  // the immediate loadStatus below is stale. Arm this flag on click and
  // re-pull the card's own status when the settings window regains focus —
  // i.e. when the connect window closes / the user comes back.
  const pendingConnectRef = useRef(false);
  useEffect(() => {
    const repullIfPending = () => {
      if (!pendingConnectRef.current) return;
      pendingConnectRef.current = false;
      void loadStatus(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") repullIfPending();
    };
    window.addEventListener("focus", repullIfPending);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", repullIfPending);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadStatus]);

  // Re-fetch the App status after a connect/disconnect so the card reflects
  // the change without depending on the gh-first library refresh.
  const connect = useCallback(
    async (source?: "oauth" | "cli") => {
      pendingConnectRef.current = true; // re-pull when the connect window closes
      await ctxConnect(source);
      await loadStatus(true);
    },
    [ctxConnect, loadStatus],
  );
  const disconnect = useCallback(
    async (source?: "oauth" | "cli" | "all") => {
      await ctxDisconnect(source);
      await loadStatus(true);
    },
    [ctxDisconnect, loadStatus],
  );

  // Self-hosted needs an active Openship Cloud connection to use the
  // GitHub App at all — the App private key lives in openship.io and
  // self-hosted instances proxy through it. PAT + gh CLI escape hatches
  // don't require cloud.
  const { connected: cloudConnected, startConnect: startCloudConnect } = useCloud();
  const { showModal, hideModal } = useModal();
  const { selfHosted: isSelfHosted } = usePlatform();

  const promptDisconnect = (
    source: "oauth" | "cli" | "all",
    label: string,
    body: string,
  ) => {
    const modalId = showModal({
      title: interpolate(t.settings.github.disconnectTitle, { label }),
      message: body,
      buttons: [
        { label: t.settings.common.cancel, variant: "secondary", onClick: () => hideModal(modalId) },
        {
          label: t.settings.github.disconnect,
          variant: "danger",
          onClick: async () => {
            hideModal(modalId);
            await disconnect(source);
          },
        },
      ],
    });
  };

  // STRICT source-of-truth for the GitHub App card. Read ONLY from
  // state.sources.openshipApp (which the backend computes from the SaaS
  // /api/cloud/github/user-status response in cloud-app mode, or from
  // local OAuth in app mode). NEVER use `connected` from useGitHub() —
  // that's derived from state.primary, which can be "gh-cli" when only
  // the CLI is logged in. In that case `accounts` is a list of CLI org
  // memberships from /user/orgs, NOT App installations — rendering them
  // here would lie about which orgs the App can actually deploy from
  // (they could be completely different sets, and the user would think
  // the App is installed where it isn't).
  const appConnected = state.sources.openshipApp.connected;
  const appLogin = state.sources.openshipApp.login;
  // accounts is only meaningful when the App itself is connected. When
  // primary is "gh-cli" the backend returns CLI orgs in this field
  // (tagged source: "cli") — gate on appConnected AND filter to
  // source: "app" so the App card never surfaces them under any
  // future regression. Backend without the source tag (older response)
  // falls through the `?? true` so we don't black-hole the list when
  // appConnected is genuinely true.
  const appAccounts = appConnected
    ? accounts.filter((acct) => (acct.source ?? "app") === "app")
    : [];
  const hasInstallations = appAccounts.length > 0;

  return (
    <>
      {/* ─── Openship GitHub App card (legacy single-source layout) ─────
          The clean accounts table that was already good. On self-hosted
          + not cloud-connected we swap the "Connect GitHub" CTA for a
          "Connect Openship Cloud" prompt, because the App can't function
          without cloud minting tokens for the local instance.            */}
      <SettingsSection
        icon={Github}
        title={appConnected && appLogin ? interpolate(t.settings.github.titleWithLogin, { login: appLogin }) : t.settings.github.title}
        description={
          appConnected
            ? hasInstallations
              ? appAccounts.length === 1
                ? t.settings.github.connectedOne
                : interpolate(t.settings.github.connectedMany, { count: String(appAccounts.length) })
              : t.settings.github.noInstallations
            : isSelfHosted && !cloudConnected
              ? t.settings.github.requiresCloud
              : t.settings.github.connectPrompt
        }
        iconBg="bg-foreground/5"
        iconColor="text-foreground"
      >
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            {t.settings.github.checkingConnection}
          </div>
        ) : appConnected ? (
          <div className="space-y-4">
            {hasInstallations && (
              <div className="space-y-2">
                {appAccounts.map((acct) => (
                  <div
                    key={acct.login}
                    className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg border border-border/40"
                  >
                    {acct.avatar_url ? (
                      <img
                        src={acct.avatar_url}
                        alt={acct.login}
                        className="size-7 rounded-full"
                      />
                    ) : (
                      <div className="size-7 rounded-full bg-muted flex items-center justify-center">
                        <Github className="size-3.5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {acct.login}
                      </p>
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                      {acct.type === "Organization" ? t.settings.github.orgBadge : t.settings.github.userBadge}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {installUrl && (
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    pendingConnectRef.current = true; // re-pull when the install tab closes
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <Download className="size-3.5" />
                  {hasInstallations ? t.settings.github.addAccount : t.settings.github.installApp}
                </a>
              )}
              <a
                href="https://github.com/settings/installations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
              >
                {t.settings.github.manageOnGithub}
                <ExternalLink className="size-3" />
              </a>
              <button
                onClick={() =>
                  promptDisconnect(
                    "oauth",
                    t.settings.github.disconnectAppLabel,
                    t.settings.github.disconnectAppBody,
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger bg-danger-bg hover:bg-danger-bg rounded-lg border border-danger-border transition-colors"
              >
                <Unplug className="size-3.5" />
                {t.settings.github.disconnect}
              </button>
            </div>
          </div>
        ) : isSelfHosted && !cloudConnected ? (
          /* Self-hosted user without cloud — App is unreachable without
             cloud minting tokens for them. Route them through the
             cloud-connect flow first; once cloud is connected the App
             card flips to the standard not-yet-OAuth'd state. */
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.settings.github.cloudExplainer}
            </p>
            <button
              onClick={startCloudConnect}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors"
            >
              <Cloud className="size-4" />
              {t.settings.github.connectCloud}
            </button>

            {/* Escape hatches — clone private repos without cloud. SSH keys
                attach per server (Servers → GitHub); a PAT works everywhere. */}
            <div className="border-t border-border/40 pt-3.5">
              <p className="text-xs font-medium text-muted-foreground/70 mb-2.5">
                {t.settings.github.noCloudTitle}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => router.push("/servers")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <KeyRound className="size-3.5" />
                  {t.settings.github.useSshPerServer}
                </button>
                <button
                  onClick={() => router.push("/settings?tab=tokens")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <Key className="size-3.5" />
                  {t.settings.github.usePat}
                </button>
              </div>
              <p className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">
                {t.settings.github.noCloudHint}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.settings.github.linkExplainer}
            </p>
            <button
              onClick={() => connect("oauth")}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors disabled:opacity-50"
            >
              {connecting ? (
                <>
                  <RefreshCw className="size-4 animate-spin" />
                  {t.settings.github.connecting}
                </>
              ) : (
                <>
                  <Github className="size-4" />
                  {t.settings.github.connect}
                </>
              )}
            </button>
          </div>
        )}
      </SettingsSection>

      {/* ─── gh CLI card (self-hosted only) ─────────────────────────────
          Separate card so the App listing above stays clean. Compact
          single-row layout that surfaces the auth state + the build-
          target capability so users understand WHY cli is treated as a
          local-only escape hatch.                                         */}
      {isSelfHosted && (
        <GhCliCard
          available={state.sources.ghCli.available}
          login={state.sources.ghCli.login}
          avatarUrl={state.sources.ghCli.avatarUrl}
          active={state.primary === "gh-cli"}
          onConnect={() => connect("cli")}
          connecting={connecting && !state.sources.ghCli.available}
        />
      )}
    </>
  );
}

/**
 * Compact local-gh-CLI card. Lives in its own SettingsSection so the App
 * card above stays untouched. Surfaces the auth state, "Local builds
 * only" capability chip, connect/disconnect action, and a deploy-time
 * warning when CLI is the active source (clone-auth.ts rejects cli
 * tokens for remote builds — we surface that here rather than at deploy
 * time).
 */
function GhCliCard(props: {
  available: boolean;
  login?: string;
  avatarUrl?: string;
  active: boolean;
  onConnect: () => void;
  connecting: boolean;
}) {
  const { available, login, avatarUrl, active, onConnect, connecting } = props;
  const { t } = useI18n();
  return (
    <SettingsSection
      icon={Terminal}
      title={t.settings.github.ghCli.title}
      description={
        available && login
          ? interpolate(t.settings.github.ghCli.loggedInAs, { login })
          : t.settings.github.ghCli.fallbackDesc
      }
      iconBg="bg-foreground/5"
      iconColor="text-foreground"
    >
      <div className="space-y-3">
        {/* Status badge — only when gh CLI is actually the active source. */}
        {active && (
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
              title={t.settings.github.ghCli.usedForDeploysTitle}
            >
              {t.settings.github.ghCli.usedForDeploys}
            </span>
          </div>
        )}

        {/* Auth identity row when authenticated */}
        {available && login && (
          <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg border border-border/40 w-fit">
            {avatarUrl ? (
              <img src={avatarUrl} alt={login} className="size-6 rounded-full" />
            ) : (
              <Terminal className="size-4 text-muted-foreground" />
            )}
            <span className="text-sm font-medium text-foreground">@{login}</span>
          </div>
        )}

        {/* Active-source warning — remote deploys get refused.
            Fires when CLI is the ONLY source (no cloud connection).  */}
        {active && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">{t.settings.github.ghCli.activeWarnStrong}</span>{" "}
            {t.settings.github.ghCli.activeWarnRest}
          </p>
        )}
        {/* Cloud-app mode + CLI available: it's a real fallback now.
            clone-auth.ts uses gh CLI for local builds when the App
            doesn't have an installation on the repo's owner (your
            personal forks, side projects, etc). Remote builds still
            route through the App regardless. */}
        {!active && available && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            <ShieldCheck className="size-3.5 inline-block align-text-bottom me-1" />
            {t.settings.github.ghCli.primaryNotePrefix}{" "}
            <span className="text-foreground font-medium">{t.settings.github.ghCli.primaryNoteStrong}</span>{" "}
            {t.settings.github.ghCli.primaryNoteSuffix}
          </p>
        )}
        {/* CLI not yet authed but App is connected — explain why
            setting up gh CLI is still useful. */}
        {!active && !available && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t.settings.github.ghCli.optionalPrefix}{" "}
            <code className="px-1.5 py-0.5 rounded bg-muted/60 text-foreground font-mono text-xs">
              gh auth login
            </code>{" "}
            {t.settings.github.ghCli.optionalSuffix}
          </p>
        )}

        {/* Action / hint row.
            Connected → terminal instruction for the durable disconnect
            (`gh auth logout`). Not connected → button that triggers the
            connect flow (device flow / terminal instruction). */}
        <div className="flex items-center gap-2">
          {available ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.settings.github.ghCli.disconnectPrefix}{" "}
              <code className="px-1.5 py-0.5 rounded bg-muted/60 text-foreground font-mono text-xs">
                gh auth logout
              </code>{" "}
              {t.settings.github.ghCli.disconnectSuffix}
            </p>
          ) : (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-muted/50 text-foreground hover:bg-muted/70 rounded-lg border border-border/50 transition-colors disabled:opacity-50"
            >
              {connecting ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : (
                <Terminal className="size-3.5" />
              )}
              {t.settings.github.ghCli.use}
            </button>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
