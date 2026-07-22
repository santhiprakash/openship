"use client";

import React, { useState, useEffect, memo } from "react";
import { Clock, Container } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { resolveBuildElapsedMs, type DeploymentStatus } from "@/context/deployment/types";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function statusBadge(status: DeploymentStatus, hasWarning: boolean, t: Dictionary) {
  const s = t.importProject.composeSidebar.status;
  if (status === "failed" || status === "cancelled") {
    return {
      label: status === "cancelled" ? s.cancelled : s.failed,
      cls: "bg-destructive/10 text-destructive border-destructive/20",
    };
  }
  if (hasWarning) {
    return {
      label: s.warnings,
      cls: "bg-warning-bg text-warning border-warning-border",
    };
  }
  if (status === "ready") {
    return { label: s.ready, cls: "bg-primary/10 text-primary border-primary/20" };
  }
  return { label: s.deploying, cls: "bg-primary/10 text-primary border-primary/20" };
}

// ─── Component ───────────────────────────────────────────────────────────────

const ComposeSidebar: React.FC = () => {
  const { state, config, deploymentStatus } = useDeployment();
  const { t } = useI18n();
  const sb = t.importProject.composeSidebar;

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  const badge = statusBadge(deploymentStatus, hasWarning, t);

  // ── Build timer ──────────────────────────────────────────────────────
  const [elapsed, setElapsed] = useState<number>(() => {
    return Math.round(resolveBuildElapsedMs(state) / 1000);
  });

  useEffect(() => {
    setElapsed(Math.round(resolveBuildElapsedMs(state) / 1000));
  }, [
    state.buildDurationMs,
    state.buildStartedAt,
    state.buildRetryCarryMs,
    state.deploymentSuccess,
    state.deploymentFailed,
    state.deploymentCanceled,
  ]);

  useEffect(() => {
    if (state.deploymentSuccess || state.deploymentFailed || state.deploymentCanceled) return;
    const id = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(id);
  }, [state.deploymentSuccess, state.deploymentFailed, state.deploymentCanceled]);

  // ── Service counts ───────────────────────────────────────────────────
  const services = state.serviceStatuses;
  const total = services.length;
  const running = services.filter((s) => s.status === "running").length;
  const building = services.filter((s) => s.status === "building").length;
  const failed = services.filter((s) => s.status === "failed").length;

  // ── Row component ────────────────────────────────────────────────────
  const Row: React.FC<{
    label: string;
    children: React.ReactNode;
    border?: boolean;
  }> = ({ label, children, border = true }) => (
    <div className={`flex justify-between items-center py-1.5 ${border ? "border-b border-border/50" : ""}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-normal text-foreground">{children}</span>
    </div>
  );

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <h3 className="text-base font-normal text-foreground mb-3">{sb.detailsTitle}</h3>
      <div className="space-y-0">
        <Row label={sb.rowStatus}>
          <span className={`text-sm font-normal px-3 py-1 rounded-full border ${badge.cls}`}>
            {badge.label}
          </span>
        </Row>

        <Row label={sb.rowBuildTime}>
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            {formatTime(elapsed)}
          </span>
        </Row>

        {total > 0 && (
          <Row label={sb.rowServices}>
            <span>
              {running}/{total} {sb.running}
              {building > 0 && (
                <span className="ms-1">{interpolate(sb.buildingSuffix, { count: String(building) })}</span>
              )}
              {failed > 0 && (
                <span className="text-destructive ms-1">{interpolate(sb.failedSuffix, { count: String(failed) })}</span>
              )}
            </span>
          </Row>
        )}

        <Row label={sb.rowProject}>
          {config.projectName || `${config.owner}/${config.repo}`}
        </Row>

        <Row label={sb.rowType} border={false}>
          <span className="flex items-center gap-1.5">
            <Container className="w-3.5 h-3.5 text-muted-foreground" />
            Compose
          </span>
        </Row>
      </div>
    </div>
  );
};

export default memo(ComposeSidebar);
