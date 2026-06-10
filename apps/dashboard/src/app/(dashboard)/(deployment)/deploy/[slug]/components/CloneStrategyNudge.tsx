"use client";

/**
 * First-time clone-strategy gate.
 *
 * Asks the user how clone credentials should flow on a SELF-HOSTED server
 * deploy. Three choices:
 *   - "local"               → switch this deploy to a local build (no token leaves API)
 *   - "remote-with-token"   → keep server build, jump to Settings to add a clone token
 *   - "github"              → keep using their existing GitHub credential as-is
 *
 * Surface model:
 *   The modal-content is rendered ONLY when the deploy button is clicked
 *   (preflight), via `showModal({ customContent: <CloneStrategyModalContent /> })`.
 *   This file no longer renders anything inline - it exports the hook that
 *   reports whether a prompt is needed, plus the modal-content component
 *   the caller mounts.
 *
 * Scope:
 *   - deployTarget === "server" → may show the modal
 *   - deployTarget === "cloud"  → NEVER shows (Opshcloud handles its own
 *                                  connect-account flow via requireCloud)
 *   - deployTarget === "local"  → never relevant (no remote clone)
 *
 * The choice is persisted on `userSettings.cloneStrategyPreference`. Once
 * anything but "prompt" is on the user, `useCloneStrategyGate` reports
 * `needsPrompt: false` on every subsequent deploy.
 */

import { useEffect, useState, useCallback } from "react";
import { Github, HardDrive, Key, Loader2 } from "lucide-react";
import { settingsApi, type CloneStrategyPreference } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

interface CloneStrategyGateResult {
  /** True when this deploy SHOULD prompt before continuing. */
  needsPrompt: boolean;
  /** Latest preference value (null while initial fetch is in flight). */
  preference: CloneStrategyPreference | null;
  /** True if the user has already saved a global PAT. */
  hasGlobalToken: boolean;
}

/**
 * Lightweight hook that loads the user's `cloneStrategyPreference` once
 * and tells the caller whether a prompt is needed for the current
 * deployTarget. Returns `needsPrompt: false` until the fetch completes,
 * which is the right behaviour - we don't want to flash the modal on
 * every page load before we know the preference.
 */
export function useCloneStrategyGate(
  deployTarget: "local" | "server" | "cloud" | null | undefined,
): CloneStrategyGateResult {
  const [preference, setPreference] = useState<CloneStrategyPreference | null>(null);
  const [hasGlobalToken, setHasGlobalToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await settingsApi.get();
        if (cancelled) return;
        setPreference(res.cloneStrategyPreference);
        setHasGlobalToken(res.cloneToken.hasToken);
      } catch {
        // Silent - gate is purely informational.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ONLY self-hosted server deploys see the prompt. Opshcloud has its
  // own connect-account flow via `requireCloud`; we don't need a clone
  // token there. Local builds never need a remote clone credential.
  const needsPrompt =
    deployTarget === "server" && preference === "prompt";

  return { needsPrompt, preference, hasGlobalToken };
}

interface CloneStrategyModalContentProps {
  hasGlobalToken: boolean;
  /** Called after the user picks a choice (or dismisses). The caller
   *  should `hideModal()` AND continue the deploy. */
  onDone: () => void;
  /** Invoked when the user picks "Build locally" so the parent can flip
   *  the deployment's `buildStrategy` to "local". Lifted out of the
   *  modal because the modal renders inside a portal (outside the
   *  DeploymentProvider tree) — calling useDeployment() directly here
   *  throws when the modal opens. */
  onChooseLocal?: () => void;
}

/**
 * The 3-choice picker rendered inside the modal. Same options as the
 * old inline nudge - the inline placement was wrong (showed on page
 * load before the user even decided to deploy); preflight is the
 * correct moment.
 */
export function CloneStrategyModalContent({
  hasGlobalToken,
  onDone,
  onChooseLocal,
}: CloneStrategyModalContentProps) {
  const { showToast } = useToast();
  const [saving, setSaving] = useState<CloneStrategyPreference | "dismiss" | null>(null);

  const choose = useCallback(
    async (next: CloneStrategyPreference, sideEffects?: () => void) => {
      setSaving(next);
      try {
        await settingsApi.updateCloneStrategyPreference(next);
        sideEffects?.();
        onDone();
      } catch {
        showToast("Failed to save your choice - try again", "error", "Clone strategy");
        setSaving(null);
      }
    },
    [onDone, showToast],
  );

  return (
    <div className="p-6 space-y-5">
      <div className="space-y-1.5">
        <h3 className="text-lg font-semibold text-foreground">
          How should we clone your repo on the remote target?
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          You're deploying to a self-hosted server. Pick once and we'll stop
          asking - change it later in Settings.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <button
          type="button"
          disabled={saving !== null}
          onClick={() =>
            choose("local", () => {
              onChooseLocal?.();
              showToast(
                "We'll build locally for this and future deploys",
                "success",
                "Clone strategy",
              );
            })
          }
          className="rounded-xl border border-border/50 bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
              {saving === "local" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <HardDrive className="size-4" />
              )}
            </div>
            <p className="text-[13px] font-semibold text-foreground">Build locally</p>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            Clone & build on this machine, ship the artifact. The token never
            leaves your API process.
          </p>
        </button>

        <button
          type="button"
          disabled={saving !== null}
          onClick={() =>
            choose("remote-with-token", () => {
              window.location.assign("/settings");
            })
          }
          className="rounded-xl border border-border/50 bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
              {saving === "remote-with-token" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Key className="size-4" />
              )}
            </div>
            <p className="text-[13px] font-semibold text-foreground">
              {hasGlobalToken ? "Use my clone token" : "Add a clone token"}
            </p>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            {hasGlobalToken
              ? "Use your saved global token (recommended) - scoped narrower than your GitHub session."
              : "Save a fine-grained PAT once. Scoped narrower than your GitHub session."}
          </p>
        </button>

        <button
          type="button"
          disabled={saving !== null}
          onClick={() =>
            choose("remote-with-token", () => {
              showToast(
                "We'll keep using your GitHub credential",
                "success",
                "Clone strategy",
              );
            })
          }
          className="rounded-xl border border-border/50 bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground">
              <Github className="size-4" />
            </div>
            <p className="text-[13px] font-semibold text-foreground">Use my GitHub</p>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            Stick with the credential already linked to your account. Skip the
            extra setup.
          </p>
        </button>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={saving !== null}
          onClick={() => {
            setSaving("dismiss");
            onDone();
          }}
          className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
