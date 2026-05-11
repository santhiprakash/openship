"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import ComposeSidebar from "./ComposeSidebar";
import BuildTerminal from "../BuildTerminal";
import { generateIcon } from "@/utils/icons";
import { useRouter } from "next/navigation";
import { useDeployment } from "@/context/DeploymentContext";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useTheme } from "@/components/theme-provider";
import { deployApi } from "@/lib/api";
import type { DeploymentStatus, ServiceDeployStatus } from "@/context/deployment/types";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";

const warningDismissedKey = (deploymentId: string) => `compose-warning-dismissed:${deploymentId}`;
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// ─── Main Component ──────────────────────────────────────────────────────────

interface Props {
  onRedeploy: () => void;
}

const ComposeDeploymentProcessing: React.FC<Props> = ({ onRedeploy }) => {
  const { config, state, onTerminalReady, stopDeployment, respondToPrompt, deploymentStatus } =
    useDeployment();
  const { showModal, hideModal } = useModal();
  const { showToast } = useToast();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const promptModalRef = React.useRef<string | null>(null);
  const warningModalRef = React.useRef<string | null>(null);
  const handledWarningDeploymentRef = React.useRef<string | null>(null);
  const [activeLogTab, setActiveLogTab] = useState("");

  const hasWarning = deploymentStatus === "ready" && !!state.warningMessage;
  const isFinished =
    deploymentStatus === "ready" ||
    deploymentStatus === "failed" ||
    deploymentStatus === "cancelled";
  const services = state.serviceStatuses;
  const logServiceNames = useMemo(() => {
    const names = new Set<string>();
    config.services.forEach((service) => {
      if (service.name) names.add(service.name);
    });
    services.forEach((service) => {
      if (service.serviceName) names.add(service.serviceName);
    });
    return Array.from(names);
  }, [config.services, services]);
  const total = Math.max(services.length, logServiceNames.length);
  const running = services.filter((s) => s.status === "running").length;
  const built = services.filter((s) => s.status === "built").length;
  const building = services.filter((s) => s.status === "building").length;
  const failed = services.filter((s) => s.status === "failed").length;
  const settled = running + built + failed;
  const terminalTheme = resolvedTheme === "dark" ? "dark" : "light";

  useEffect(() => {
    onTerminalReady();
  }, [onTerminalReady]);

  useEffect(() => {
    if (logServiceNames.length === 0) {
      if (activeLogTab) {
        setActiveLogTab("");
      }
      return;
    }

    if (!activeLogTab || !logServiceNames.includes(activeLogTab)) {
      setActiveLogTab(logServiceNames[0] ?? "");
    }
  }, [activeLogTab, logServiceNames]);

  // ── Pipeline prompt modal ──────────────────────────────────────────────
  useEffect(() => {
    if (!state.pendingPrompt) return;
    const { promptId, title, message, actions } = state.pendingPrompt;
    if (promptModalRef.current === promptId) return;
    promptModalRef.current = promptId;

    const modalId = showModal({
      title,
      icon: "error%20triangle-16-1662499385.png",
      customContent: (
        <div className="p-6 space-y-5">
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-foreground">{title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            {actions.map((action) => {
              const variant = (action.variant || "secondary") as "secondary" | "danger" | "primary";
              const styles =
                variant === "danger"
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : variant === "primary"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-muted text-foreground hover:bg-muted/80";
              return (
                <button
                  key={action.id}
                  type="button"
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${styles}`}
                  onClick={() => {
                    hideModal(modalId);
                    respondToPrompt(action.id);
                  }}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </div>
      ),
      width: "560px",
      maxWidth: "92vw",
    });
  }, [state.pendingPrompt, showModal, hideModal, respondToPrompt]);

  useEffect(() => {
    if (
      deploymentStatus !== "ready" ||
      !state.warningMessage ||
      failed === 0 ||
      !state.deploymentId
    ) {
      warningModalRef.current = null;
      handledWarningDeploymentRef.current = null;
      return;
    }

    const warningKey = warningDismissedKey(state.deploymentId);

    if (typeof window !== "undefined" && window.sessionStorage.getItem(warningKey) === "1") {
      handledWarningDeploymentRef.current = state.deploymentId;
      return;
    }

    if (handledWarningDeploymentRef.current === state.deploymentId) return;
    if (warningModalRef.current) return;

    let modalId = "";
    modalId = showModal({
      customContent: (
        <PartialSuccessModalContent
          failed={failed}
          total={total}
          warningMessage={state.warningMessage}
          onKeep={() => {
            handledWarningDeploymentRef.current = state.deploymentId;
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem(warningKey, "1");
            }
            hideModal(modalId);
          }}
          onReject={async () => {
            handledWarningDeploymentRef.current = state.deploymentId;
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem(warningKey, "1");
            }

            await deployApi.reject(state.deploymentId!);
            hideModal(modalId);
            showToast("Partial deployment rejected", "success", "Deployment Reverted");

            if (state.projectId) {
              router.push(`/projects/${state.projectId}`);
            }
          }}
        />
      ),
      width: "640px",
      maxWidth: "92vw",
      showCloseButton: true,
      onClose: () => {
        if (warningModalRef.current === modalId) {
          warningModalRef.current = null;
        }
        handledWarningDeploymentRef.current = state.deploymentId;
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(warningKey, "1");
        }
      },
    });

    warningModalRef.current = modalId;
  }, [
    deploymentStatus,
    failed,
    hideModal,
    router,
    showModal,
    showToast,
    state.deploymentId,
    state.projectId,
    state.warningMessage,
    total,
  ]);

  const handleViewDashboard = () => {
    if (state.projectId) router.push(`/projects/${state.projectId}`);
  };

  // ── Title ──────────────────────────────────────────────────────────────
  const title =
    deploymentStatus === "cancelled"
      ? "Deployment Cancelled"
      : deploymentStatus === "failed"
        ? "Deployment Failed"
        : hasWarning
          ? "Deployed With Warnings"
          : deploymentStatus === "ready"
            ? "Deployment Successful"
            : "Deploying Services…";

  return (
    <div className="min-h-screen bg-background mx-auto md:px-12">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex border border-border/50 bg-muted/50 rounded-lg w-12 h-12 justify-center items-center">
              {generateIcon("space%20rocket-85-1687505546.png", 30, "currentColor")}
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">{title}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {config.owner}/{config.repo}
                {total > 0 && (
                  <span className="ml-2 text-xs">
                    · {total} service{total !== 1 ? "s" : ""}
                  </span>
                )}
              </p>
            </div>
          </div>

          {deploymentStatus === "ready" && (
            <button
              onClick={handleViewDashboard}
              className="flex items-center gap-2 text-primary-foreground font-medium bg-primary rounded-full px-4 py-2 text-sm hover:bg-primary/90 shadow-md hover:shadow-lg transition-all"
            >
              View Dashboard
            </button>
          )}
        </div>
      </div>

      {/* ── Grid ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Warning banner */}
          {hasWarning && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/8 px-5 py-4">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Some services need attention
              </p>
              <p className="mt-1 text-sm text-amber-700/80 dark:text-amber-300/80">
                {state.warningMessage}
              </p>
            </div>
          )}

          <ComposeServiceLogsPanel
            logs={state.buildLogs}
            serviceNames={logServiceNames}
            services={services}
            activeTab={activeLogTab}
            onTabChange={setActiveLogTab}
            deploymentStatus={deploymentStatus}
            running={running}
            building={building}
            failed={failed}
            settled={settled}
            total={total}
            isFinished={isFinished}
            terminalTheme={terminalTheme}
          />
        </div>

        {/* Sidebar */}
        <div className="lg:sticky lg:top-6 h-fit space-y-6">
          <ComposeSidebar />

          {/* Action button */}
          <div className="bg-card rounded-2xl border border-border/50 p-4">
            {deploymentStatus === "deploying" || deploymentStatus === "building" ? (
              <button
                onClick={stopDeployment}
                disabled={state.isStopping}
                className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm border ${
                  state.isStopping
                    ? "bg-muted text-muted-foreground border-border cursor-not-allowed"
                    : "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15 hover:border-destructive/30"
                }`}
              >
                {state.isStopping ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Stopping…
                  </>
                ) : (
                  "Stop Deployment"
                )}
              </button>
            ) : deploymentStatus === "failed" || deploymentStatus === "cancelled" ? (
              <button
                onClick={onRedeploy}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:bg-primary/90 transition-all"
              >
                Redeploy
              </button>
            ) : deploymentStatus === "ready" ? (
              <button
                onClick={handleViewDashboard}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:bg-primary/90 transition-all"
              >
                Open Dashboard
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ComposeDeploymentProcessing;

interface ParsedLogLine {
  text: string;
  type: BuildLog["type"];
  serviceName: string | null;
  rawData?: string;
}

function stripAnsi(text: string) {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function textForDetection(text: string) {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trimEnd() ?? "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectServiceName(text: string, serviceNames: string[]) {
  const prefixed = text.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (prefixed) {
    const serviceName = prefixed[1];
    if (serviceNames.includes(serviceName)) {
      return serviceName;
    }
  }

  const composed = text.match(
    /\b(?:building|built|deploying|starting|started|stopping|creating|created|preparing|running|failed)\s+(?:compose\s+)?service\s+"([^"]+)"/i,
  );
  if (composed && serviceNames.includes(composed[1])) {
    return composed[1];
  }

  for (const name of serviceNames) {
    const servicePattern = new RegExp(`\\bservice\\s+"${escapeRegExp(name)}"\\b`, "i");
    if (servicePattern.test(text)) {
      return name;
    }
  }

  return null;
}

function stripServicePrefix(text: string, serviceName: string) {
  const prefixPattern = new RegExp(`^\\[${escapeRegExp(serviceName)}\\]\\s*`);
  return text.replace(prefixPattern, "") || text;
}

function stripServicePrefixFromChunk(text: string, serviceName: string) {
  const prefixPattern = new RegExp(`(^|[\\r\\n])\\[${escapeRegExp(serviceName)}\\]\\s*`, "g");
  return text.replace(prefixPattern, "$1") || text;
}

function parseLogLines(logs: BuildLog[], serviceNames: string[]): ParsedLogLine[] {
  return logs
    .map((log) => {
      const rawText = log.text;
      const detectionText = textForDetection(rawText);
      const structuredService =
        log.serviceName && serviceNames.includes(log.serviceName)
          ? {
              serviceName: log.serviceName,
              text: stripServicePrefixFromChunk(rawText, log.serviceName),
            }
          : null;
      const detectedServiceName = structuredService?.serviceName ?? detectServiceName(detectionText, serviceNames);
      const text = detectedServiceName
        ? stripServicePrefixFromChunk(structuredService?.text ?? rawText, detectedServiceName)
        : rawText;

      return {
        text,
        serviceName: detectedServiceName,
        type: log.type,
        rawData: log.rawData,
      };
    })
    .filter((log) => log.text.trim().length > 0);
}

function statusDotClass(status?: ServiceDeployStatus["status"]) {
  switch (status) {
    case "running":
      return "bg-primary";
    case "built":
      return "bg-muted-foreground";
    case "building":
    case "deploying":
      return "bg-foreground";
    case "failed":
      return "bg-destructive";
    case "pending":
    default:
      return "bg-muted-foreground/40";
  }
}

function serviceTabClass(status: ServiceDeployStatus["status"] | undefined, isActive: boolean) {
  if (status === "failed") {
    return isActive
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10";
  }
  if (status === "running") {
    return isActive
      ? "border-primary/30 bg-primary/10 text-primary"
      : "border-primary/20 bg-primary/5 text-primary hover:bg-primary/10";
  }
  if (status === "building" || status === "deploying") {
    return isActive
      ? "border-foreground/25 bg-foreground/10 text-foreground"
      : "border-border/60 bg-muted/30 text-foreground hover:bg-muted/50";
  }
  if (status === "built") {
    return isActive
      ? "border-muted-foreground/30 bg-muted text-foreground"
      : "border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50";
  }
  return isActive
    ? "border-primary/30 bg-primary/10 text-primary"
    : "border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50";
}

function ComposeServiceLogsPanel({
  logs,
  serviceNames,
  services,
  activeTab,
  onTabChange,
  deploymentStatus,
  running,
  building,
  failed,
  settled,
  total,
  isFinished,
  terminalTheme,
}: {
  logs: BuildLog[];
  serviceNames: string[];
  services: ServiceDeployStatus[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  deploymentStatus: DeploymentStatus;
  running: number;
  building: number;
  failed: number;
  settled: number;
  total: number;
  isFinished: boolean;
  terminalTheme: "light" | "dark";
}) {
  const parsedLogs = useMemo(() => parseLogLines(logs, serviceNames), [logs, serviceNames]);
  const serviceStatusByName = useMemo(() => {
    const statuses = new Map<string, ServiceDeployStatus["status"]>();
    services.forEach((service) => statuses.set(service.serviceName, service.status));
    return statuses;
  }, [services]);
  const hasFinished =
    deploymentStatus === "ready" ||
    deploymentStatus === "failed" ||
    deploymentStatus === "cancelled";
  const terminalTabs = useMemo(() => {
    const byService = new Map<string, ParsedLogLine[]>();
    serviceNames.forEach((serviceName) => byService.set(serviceName, []));

    parsedLogs.forEach((log) => {
      if (!log.serviceName) {
        return;
      }
      byService.get(log.serviceName)?.push(log);
    });

    return serviceNames.map((serviceName) => ({
      id: serviceName,
      label: serviceName,
      logs: byService.get(serviceName) ?? [],
      emptyMessage: hasFinished
        ? `No logs were recorded for ${serviceName}.`
        : `Waiting for ${serviceName} logs...`,
    }));
  }, [hasFinished, parsedLogs, serviceNames]);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 mb-20">
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {generateIcon("terminal-58-1658431404.png", 24, "currentColor")}
            <h2 className="text-base font-normal text-foreground">Deployment Logs</h2>
          </div>
          {total > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {running}/{total} running
              {building > 0 && <span className="ml-1">· {building} building</span>}
              {failed > 0 && <span className="text-destructive ml-1">· {failed} failed</span>}
            </span>
          )}
        </div>

        {!isFinished && total > 0 && (
          <div className="h-1 rounded-full overflow-hidden bg-border/50">
            <div
              className="h-full transition-all duration-500 bg-primary"
              style={{ width: `${(settled / total) * 100}%` }}
            />
          </div>
        )}

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {serviceNames.length > 0 ? (
            serviceNames.map((serviceName) => {
              const status = serviceStatusByName.get(serviceName);
              const isActive = activeTab === serviceName;
              return (
                <button
                  key={serviceName}
                  type="button"
                  onClick={() => onTabChange(serviceName)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${serviceTabClass(status, isActive)}`}
                >
                  {status === "building" || status === "deploying" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(status)}`} />
                  )}
                  {serviceName}
                </button>
              );
            })
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Preparing services
            </span>
          )}
        </div>

        <div className="relative h-[420px] overflow-hidden rounded-xl border border-border/50 bg-white dark:bg-black">
          {terminalTabs.length > 0 ? (
            terminalTabs.map((tab) => (
              <ComposeLogTerminal
                key={tab.id}
                logs={tab.logs}
                active={activeTab === tab.id}
                emptyMessage={tab.emptyMessage}
                theme={terminalTheme}
              />
            ))
          ) : (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <p className="text-sm text-muted-foreground">Preparing service logs...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function terminalLine(log: ParsedLogLine) {
  const text = log.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const hasAnsi = text.includes("\x1B");
  const suffix = /[\r\n]/.test(log.text) ? "" : "\r\n";
  if (hasAnsi) return `${text}${suffix}`;
  if (log.type === "error") return `\x1b[31m${text}\x1b[0m${suffix}`;
  if (log.type === "success") return `\x1b[32m${text}\x1b[0m${suffix}`;
  return `${text}${suffix}`;
}

function terminalBytes(log: ParsedLogLine) {
  if (!log.rawData) {
    return terminalLine(log);
  }

  try {
    const binary = atob(log.rawData);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return terminalLine(log);
  }
}

function isTerminalAtBottom(terminal: any) {
  const buffer = terminal?.buffer?.active;
  if (!buffer) return true;
  return buffer.viewportY >= buffer.baseY - 1;
}

function ComposeLogTerminal({
  logs,
  active,
  emptyMessage,
  theme,
}: {
  logs: ParsedLogLine[];
  active: boolean;
  emptyMessage: string;
  theme: "light" | "dark";
}) {
  const terminalRef = useRef<any | null>(null);
  const writtenCountRef = useRef(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !ready) return;

    if (logs.length < writtenCountRef.current) {
      terminal.reset();
      writtenCountRef.current = 0;
    }

    const shouldScroll = active && isTerminalAtBottom(terminal);
    logs.slice(writtenCountRef.current).forEach((log) => {
      terminal.write(terminalBytes(log));
    });
    writtenCountRef.current = logs.length;
    if (shouldScroll) {
      terminal.scrollToBottom();
    }
  }, [active, logs, ready]);

  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
      }}
      aria-hidden={!active}
    >
      <BuildTerminal
        onReady={(terminal) => {
          terminalRef.current = terminal;
          setReady(true);
        }}
        theme={theme}
        enableContainerStreaming={false}
      />
      {active && logs.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      )}
    </div>
  );
}

function PartialSuccessModalContent({
  failed,
  total,
  warningMessage,
  onKeep,
  onReject,
}: {
  failed: number;
  total: number;
  warningMessage: string;
  onKeep: () => void;
  onReject: () => Promise<void>;
}) {
  const [isRejecting, setIsRejecting] = React.useState(false);

  return (
    <div className="p-6 space-y-5">
      <div className="space-y-2">
        <h3 className="text-xl font-bold text-foreground">
          Deployment finished with failed services
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {failed} of {total} services failed, but the rest of the stack was deployed successfully.
          You can keep this deployment and fix the failed services later, or reject it and restore
          the previous deployment.
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 space-y-2">
        <p className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
          Warning
        </p>
        <p className="text-sm text-amber-700/90 dark:text-amber-300/90">{warningMessage}</p>
      </div>

      <div className="rounded-xl border border-border bg-muted/40 p-4">
        <p className="text-sm text-muted-foreground">
          Rejecting stops using this partial deployment. If a previous deployment exists, Openship
          restores it. Otherwise, the new partial deployment is removed.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
          onClick={onKeep}
          disabled={isRejecting}
        >
          Keep And Fix Later
        </button>
        <button
          type="button"
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          onClick={async () => {
            setIsRejecting(true);
            try {
              await onReject();
            } finally {
              setIsRejecting(false);
            }
          }}
          disabled={isRejecting}
        >
          {isRejecting ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Rejecting...
            </span>
          ) : (
            "Reject Deployment"
          )}
        </button>
      </div>
    </div>
  );
}
