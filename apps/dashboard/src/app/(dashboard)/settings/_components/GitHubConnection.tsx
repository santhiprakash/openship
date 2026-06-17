"use client";

import {
  Github,
  ExternalLink,
  Unplug,
  RefreshCw,
  Download,
  Terminal,
  Cloud,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { useGitHub } from "@/context/GitHubContext";
import { useCloud } from "@/context/CloudContext";
import { useModal } from "@/context/ModalContext";
import { usePlatform } from "@/context/PlatformContext";
import { SettingsSection } from "./SettingsSection";

export function GitHubConnection() {
  const {
    state,
    connecting,
    loading,
    accounts,
    connect,
    disconnect,
    installUrl,
  } = useGitHub();

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
      title: `Disconnect ${label}`,
      message: body,
      buttons: [
        { label: "Cancel", variant: "secondary", onClick: () => hideModal(modalId) },
        {
          label: "Disconnect",
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
        title={appConnected && appLogin ? `GitHub · @${appLogin}` : "GitHub"}
        description={
          appConnected
            ? hasInstallations
              ? `Connected · ${appAccounts.length} installation${appAccounts.length > 1 ? "s" : ""}`
              : "Connected · No installations yet"
            : isSelfHosted && !cloudConnected
              ? "Requires Openship Cloud — the App is owned by openship.io"
              : "Connect your GitHub account to deploy repositories"
        }
        iconBg="bg-foreground/5"
        iconColor="text-foreground"
      >
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            Checking connection…
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
                      {acct.type === "Organization" ? "Org" : "User"}
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
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
                >
                  <Download className="size-3.5" />
                  {hasInstallations ? "Add account" : "Install GitHub App"}
                </a>
              )}
              <a
                href="https://github.com/settings/installations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
              >
                Manage on GitHub
                <ExternalLink className="size-3" />
              </a>
              <button
                onClick={() =>
                  promptDisconnect(
                    "oauth",
                    "Openship GitHub App",
                    "This removes the Openship OAuth account row. The GitHub App installation stays until you uninstall it on GitHub.",
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-700 bg-red-500/5 hover:bg-red-500/10 rounded-lg border border-red-500/15 hover:border-red-500/25 transition-colors"
              >
                <Unplug className="size-3.5" />
                Disconnect
              </button>
            </div>
          </div>
        ) : isSelfHosted && !cloudConnected ? (
          /* Self-hosted user without cloud — App is unreachable without
             cloud minting tokens for them. Route them through the
             cloud-connect flow first; once cloud is connected the App
             card flips to the standard not-yet-OAuth'd state. */
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              The Openship GitHub App is owned by openship.io. Connect your
              instance to Openship Cloud to use scoped install tokens for
              cloning private repos (works for local AND remote deploys).
            </p>
            <button
              onClick={startCloudConnect}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors"
            >
              <Cloud className="size-4" />
              Connect Openship Cloud
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Link your GitHub account to import repositories, enable auto-deploy
              on push, and manage branches directly from the dashboard.
            </p>
            <button
              onClick={() => connect("oauth")}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors disabled:opacity-50"
            >
              {connecting ? (
                <>
                  <RefreshCw className="size-4 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <Github className="size-4" />
                  Connect GitHub
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
  return (
    <SettingsSection
      icon={Terminal}
      title="gh CLI"
      description={
        available && login
          ? `Logged in as @${login}`
          : "Optional local-build fallback for repos outside your App installations"
      }
      iconBg="bg-foreground/5"
      iconColor="text-foreground"
    >
      <div className="space-y-3">
        {/* Capability + status badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400"
            title="Refused at deploy time for remote-server builds. The App or a per-project clone token is required for remote deploys."
          >
            <AlertTriangle className="size-2.5" />
            Local builds only
          </span>
          {active && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
              title="No cloud connection — gh CLI is the primary source for everything right now"
            >
              Used for deploys
            </span>
          )}
        </div>

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
          <p className="text-sm text-amber-600 dark:text-amber-400 leading-relaxed">
            <span className="font-medium">gh CLI is the active source.</span>{" "}
            Deploys to remote servers will be refused — connect the Openship App
            or set a per-project clone token to deploy to remote targets.
          </p>
        )}
        {/* Cloud-app mode + CLI available: it's a real fallback now.
            clone-auth.ts uses gh CLI for local builds when the App
            doesn't have an installation on the repo's owner (your
            personal forks, side projects, etc). Remote builds still
            route through the App regardless. */}
        {!active && available && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            <ShieldCheck className="size-3.5 inline-block align-text-bottom mr-1" />
            Openship App is the primary source. gh CLI fills in for{" "}
            <span className="text-foreground font-medium">local builds</span> against
            repos outside your App installations.
          </p>
        )}
        {/* CLI not yet authed but App is connected — explain why
            setting up gh CLI is still useful. */}
        {!active && !available && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            Optional. Run{" "}
            <code className="px-1.5 py-0.5 rounded bg-muted/60 text-foreground font-mono text-xs">
              gh auth login
            </code>{" "}
            on this machine to enable local-build clones of repos outside your
            App installations. Remote deploys always route through the App.
          </p>
        )}

        {/* Action / hint row.
            Connected → terminal instruction for the durable disconnect
            (`gh auth logout`). Not connected → button that triggers the
            connect flow (device flow / terminal instruction). */}
        <div className="flex items-center gap-2">
          {available ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              To disconnect, run{" "}
              <code className="px-1.5 py-0.5 rounded bg-muted/60 text-foreground font-mono text-xs">
                gh auth logout
              </code>{" "}
              in your terminal.
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
              Use gh CLI
            </button>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
