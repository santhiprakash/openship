"use client";

import React from "react";
import {
  Loader2,
  Check,
  ArrowRight,
  ExternalLink,
  AlertTriangle,
  SlidersHorizontal,
} from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";

export type CleanDeployPhase = "installing" | "done" | "error";

/** Map a raw deployment status to the two clean progress labels. */
export function labelForStatus(
  status: string,
  labels: { progressPreparing: string; progressDeploying: string },
): string {
  if (status === "building" || status === "deploying") return labels.progressDeploying;
  return labels.progressPreparing;
}

/**
 * Derive a public host from the deploy's publicEndpoints (custom domain wins,
 * else the free subdomain label + base domain).
 */
export function firstPublicHost(
  endpoints: Array<{ domain?: string; customDomain?: string; domainType?: string }> | undefined,
  baseDomain: string,
): string | null {
  const ep = endpoints?.[0];
  if (!ep) return null;
  if (ep.customDomain) return ep.customDomain;
  if (ep.domain) return ep.domain.includes(".") ? ep.domain : `${ep.domain}.${baseDomain}`;
  return null;
}

/**
 * The clean install progress view shared by the app wizards — a status-only
 * card (no raw build logs) with installing / done / error states. Reads the
 * shared `projectSettings.appInstall` copy so both wizards stay consistent.
 */
export function CleanDeployProgressCard({
  appId,
  title,
  phase,
  progress,
  phaseLabel,
  liveUrl,
  errorMsg,
  deploymentId,
  onGoToProject,
  onViewBuild,
  onRetry,
}: {
  appId: string;
  title: string;
  phase: CleanDeployPhase;
  progress: number;
  phaseLabel: string;
  liveUrl: string | null;
  errorMsg: string;
  deploymentId: string | null;
  onGoToProject: () => void;
  onViewBuild: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;

  return (
    <PageContainer outerClassName="pb-20">
      <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center">
        <div className="w-full rounded-2xl border border-border/50 bg-card p-8 text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId={appId} className="size-9 object-contain" />
          </div>

          {phase === "installing" && (
            <>
              <h1 className="mt-5 text-lg font-semibold text-foreground">{title}</h1>
              <p className="mt-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {phaseLabel}
              </p>
              <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(5, progress)}%` }}
                />
              </div>
            </>
          )}

          {phase === "done" && (
            <>
              <div className="mx-auto mt-5 flex size-8 items-center justify-center rounded-full bg-success-bg">
                <Check className="size-5 text-success" />
              </div>
              <h1 className="mt-3 text-lg font-semibold text-foreground">{w.progressLive}</h1>
              <div className="mt-6 flex flex-col gap-2">
                {liveUrl && (
                  <a
                    href={`https://${liveUrl}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <ExternalLink className="size-4" /> {w.openApp}
                  </a>
                )}
                <button
                  type="button"
                  onClick={onGoToProject}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                >
                  {w.goToApp} <ArrowRight className="size-4 rtl:rotate-180" />
                </button>
              </div>
            </>
          )}

          {phase === "error" && (
            <>
              <div className="mx-auto mt-5 flex size-8 items-center justify-center rounded-full bg-danger-bg">
                <AlertTriangle className="size-5 text-danger" />
              </div>
              <h1 className="mt-3 text-lg font-semibold text-foreground">{w.installFailed}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{errorMsg}</p>
              <div className="mt-6 flex flex-col gap-2">
                {deploymentId && (
                  <button
                    type="button"
                    onClick={onViewBuild}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                  >
                    <SlidersHorizontal className="size-4" /> {w.viewDetails}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onRetry}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {w.back}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
