"use client";

import { useState } from "react";
import {
  Check,
  LogOut,
  Loader2,
  ExternalLink,
  Globe,
} from "lucide-react";
import { cloudApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useI18n } from "@/components/i18n-provider";

/* ── Component ──────────────────────────────────────────────────── */

export function CloudConnection() {
  const { authMode, deployMode } = usePlatform();
  const { t } = useI18n();
  const {
    connected: cloudConnected,
    cloudUser,
    loading: cloudLoading,
    connecting,
    startConnect,
    refresh,
  } = useCloud();
  const { showToast } = useToast();
  const isDesktop = deployMode === "desktop";
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!confirm(t.settings.cloud.confirmDisconnect)) return;
    try {
      setDisconnecting(true);
      await cloudApi.disconnect();
      await refresh();
      showToast(t.settings.cloud.toast.disconnected, "success", t.settings.common.toast.cloud);
    } catch {
      showToast(t.settings.cloud.toast.disconnectFailed, "error", t.settings.common.toast.cloud);
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      {cloudLoading ? (
        <div className="py-4 flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{t.settings.cloud.checking}</p>
        </div>
      ) : cloudConnected ? (
        <div className="space-y-4">
          {/* Header + user info */}
          <div className="flex items-center gap-3">
            {cloudUser?.image ? (
              <img
                src={cloudUser.image}
                alt=""
                className="size-9 rounded-full ring-1 ring-border shrink-0"
              />
            ) : (
              <div className="size-9 rounded-full bg-muted flex items-center justify-center ring-1 ring-border shrink-0">
                <span className="text-xs font-medium text-muted-foreground">
                  {cloudUser?.name?.charAt(0)?.toUpperCase() || cloudUser?.email?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {cloudUser?.name || t.settings.cloud.fallbackName}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {cloudUser?.email || t.settings.cloud.connectedAccount}
              </p>
            </div>
          </div>

          {/* Status badge */}
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-success-bg text-success text-xs font-semibold rounded-full ring-1 ring-success-border">
              <Check className="size-3" />
              {t.settings.cloud.connected}
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
            >
              {disconnecting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <LogOut className="size-3" />
              )}
              {t.settings.common.disconnect}
            </button>
          </div>

          <div className="h-px bg-border/60" />

          {/* Cloud features summary */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t.settings.cloud.featuresActive}
          </p>
        </div>
      ) : (
        <div className="text-center">
          {/* Cloud icon */}
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Globe className="size-6 text-primary" />
          </div>

          <h4 className="text-sm font-medium text-foreground mb-1">{t.settings.cloud.connectToCloud}</h4>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">
            {isDesktop
              ? t.settings.cloud.unlockDesktop
              : t.settings.cloud.deployLocal}
          </p>

          <button
            onClick={startConnect}
            disabled={connecting}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t.settings.cloud.waitingSignIn}
              </>
            ) : (
              <>
                <ExternalLink className="size-3.5" />
                {t.settings.cloud.connectButton}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
