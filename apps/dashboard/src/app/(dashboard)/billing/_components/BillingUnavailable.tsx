"use client";

/**
 * BillingUnavailable — empty-state card rendered when the billing
 * surface is reachable but not usable in the current mode.
 *
 * Three accurate variants per the trace:
 *
 *   - `saas-not-enabled`  : we're in SaaS mode but the org has no
 *                            billing configured (admin should enable).
 *   - `cloud-not-connected`: local mode, no cloud session linked —
 *                            offers a Connect to Cloud button.
 *   - `cloud-unreachable`  : local mode, cloud was linked but the
 *                            proxy got a 5xx — likely transient or
 *                            expired session; user can retry/reconnect.
 *
 * The Connect button reuses CloudContext.startConnect, identical to
 * the settings/cloud flow so we don't fork the PKCE handshake.
 */

import { useCallback } from "react";
import { ExternalLink, Loader2, Cloud, CircleAlert } from "lucide-react";
import { useCloud } from "@/context/CloudContext";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export type BillingUnavailableReason =
  | "saas-not-enabled"
  | "cloud-not-connected"
  | "cloud-session-expired"
  | "cloud-unreachable";

interface Props {
  reason: BillingUnavailableReason;
}

export function BillingUnavailable({ reason }: Props) {
  const { t } = useI18n();
  const { startConnect, connecting, refresh } = useCloud();

  const handleConnect = useCallback(() => {
    startConnect();
  }, [startConnect]);

  const handleRetry = useCallback(() => {
    // Re-check cloud status and reload the route — Next will re-run
    // the server component, which re-hits /billing/state.
    void refresh().then(() => {
      if (typeof window !== "undefined") window.location.reload();
    });
  }, [refresh]);

  if (reason === "cloud-not-connected") {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10">
          <Cloud className="size-6 text-primary" />
        </div>
        <h2 className="text-base font-semibold text-foreground">
          {t.billing.unavailable.notConnected.title}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {t.billing.unavailable.notConnected.description}
        </p>
        <div className="mt-5 flex justify-center">
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            {connecting
              ? t.billing.unavailable.notConnected.connecting
              : t.billing.unavailable.notConnected.connect}
          </Button>
        </div>
      </div>
    );
  }

  if (reason === "cloud-session-expired") {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-warning-bg">
          <CircleAlert className="size-6 text-warning" />
        </div>
        <h2 className="text-base font-semibold text-foreground">
          {t.billing.unavailable.sessionExpired.title}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {t.billing.unavailable.sessionExpired.description}
        </p>
        <div className="mt-5 flex justify-center">
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            {connecting
              ? t.billing.unavailable.sessionExpired.connecting
              : t.billing.unavailable.sessionExpired.reconnect}
          </Button>
        </div>
      </div>
    );
  }

  if (reason === "cloud-unreachable") {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-destructive/10">
          <CircleAlert className="size-6 text-destructive" />
        </div>
        <h2 className="text-base font-semibold text-foreground">
          {t.billing.unavailable.unreachable.title}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {t.billing.unavailable.unreachable.description}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="outline" onClick={handleRetry}>
            {t.billing.unavailable.unreachable.tryAgain}
          </Button>
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            {t.billing.unavailable.unreachable.reconnect}
          </Button>
        </div>
      </div>
    );
  }

  // saas-not-enabled
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
      <h2 className="text-base font-semibold text-foreground">
        {t.billing.unavailable.notEnabled.title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {t.billing.unavailable.notEnabled.description}
      </p>
    </div>
  );
}
