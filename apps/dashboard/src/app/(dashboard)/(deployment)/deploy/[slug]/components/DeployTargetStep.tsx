"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Server, Cloud, Cpu, ArrowRight, Pencil, ChevronDown, ChevronUp, CheckCircle2, Loader2, Plus, Sparkles, Settings2, Zap, Globe, GitBranch } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment } from "@/context/deployment/types";
import type { DeploymentConfig } from "@/context/deployment/types";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { systemApi } from "@/lib/api/system";
import { settingsApi } from "@/lib/api/settings";
import type { ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import type { DeployTarget, BuildStrategy } from "@/context/deployment/types";
import { createPersistedValue, createPersistedFlag } from "@/lib/persisted-value";
import { AddServerModal } from "./AddServerModal";
import ServerRuntimePicker from "./ServerRuntimePicker";

// ─── Option card ─────────────────────────────────────────────────────────────

interface OptionCardProps {
  value: string;
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
  /** Optional children rendered below when selected */
  children?: React.ReactNode;
  /** Extra classes for the outer wrapper - e.g. `h-full` for equal-height grids. */
  className?: string;
}

export const OptionCard: React.FC<OptionCardProps> = ({
  selected,
  onSelect,
  icon,
  label,
  description,
  children,
  className,
}) => (
  <div className={className}>
    <button
      type="button"
      onClick={onSelect}
      className={`
        relative w-full h-full text-left p-4 rounded-xl border transition-all
        ${selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
        }
        ${selected && children ? "rounded-b-none border-b-0" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${selected ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${selected ? "text-foreground" : "text-foreground/80"}`}>
            {label}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
        {selected && (
          <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <div className="size-2 rounded-full bg-primary-foreground" />
          </div>
        )}
      </div>
    </button>
    {selected && children && (
      <div className="border border-t-0 border-primary/20 bg-primary/[0.02] rounded-b-xl px-4 pb-4 pt-2">
        {children}
      </div>
    )}
  </div>
);

// ─── Server sub-selector (shown when "Servers" is selected with multiple) ────

interface ServerSubSelectorProps {
  servers: ServerInfo[];
  selectedId?: string;
  onSelect: (server: ServerInfo) => void;
}

const ServerSubSelector: React.FC<ServerSubSelectorProps> = ({
  servers,
  selectedId,
  onSelect,
}) => (
  <div className="space-y-1.5">
    <p className="text-xs font-medium text-muted-foreground mb-2">Choose a server</p>
    {servers.map((s) => {
      const isSelected = selectedId === s.id;
      return (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelect(s)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
            isSelected
              ? "bg-primary/10 border border-primary/30"
              : "bg-card/60 border border-border/30 hover:border-primary/20 hover:bg-muted/30"
          }`}
        >
          <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
            isSelected ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"
          }`}>
            <Server className="size-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {s.name || s.sshHost}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {s.sshUser || "root"}@{s.sshHost}:{s.sshPort || 22}
            </p>
          </div>
          {isSelected && (
            <CheckCircle2 className="size-4 text-primary shrink-0" />
          )}
        </button>
      );
    })}
  </div>
);

// ─── Compact summary (shown when editing from step 2) ────────────────────────

interface CompactSummaryProps {
  deployTarget: DeployTarget;
  buildStrategy: BuildStrategy;
  serverName?: string | null;
  showBuildStrategy?: boolean;
  /** When deployTarget is "cloud", the chosen resource tier — rendered
   *  as a small chip on the right of the summary so the operator sees
   *  their power pick at a glance without re-opening the picker. */
  cloudResourceTier?: CloudResourceTier;
  /** False when the project deploys as static files (no Start command,
   *  no long-running process). For cloud deploys this swaps the power
   *  tier chip for a "Static" chip — there's no machine to size when
   *  the workload is just files served from the edge. */
  hasServer?: boolean;
  onEdit: () => void;
}

const targetLabels: Record<DeployTarget, { label: string; icon: React.ReactNode }> = {
  local: { label: "This Machine", icon: <Cpu className="size-3.5" /> },
  server: { label: "My Server", icon: <Server className="size-3.5" /> },
  cloud: { label: "OpenShip Cloud", icon: <Cloud className="size-3.5" /> },
};

const buildLabels: Record<BuildStrategy, { label: string; icon: React.ReactNode }> = {
  local: { label: "This Machine", icon: <Cpu className="size-3.5" /> },
  server: { label: "Remote", icon: <Cloud className="size-3.5" /> },
};

export const DeployTargetSummary: React.FC<CompactSummaryProps> = ({
  deployTarget,
  buildStrategy,
  serverName,
  showBuildStrategy = true,
  cloudResourceTier,
  hasServer = true,
  onEdit,
}) => {
  const target = targetLabels[deployTarget];
  // Build label is driven by buildStrategy FIRST — a "local" build always runs
  // on this machine, even when the deploy target is Openship Cloud
  // (local-orchestrated cloud: build here, upload the output to the cloud
  // workspace). Only a SERVER build inherits the target's name ("Openship
  // Cloud" when the workspace builds it, else the generic remote label).
  const build =
    buildStrategy === "local"
      ? buildLabels.local
      : deployTarget === "cloud"
        ? { label: "Openship Cloud", icon: <Cloud className="size-3.5" /> }
        : buildLabels.server;
  const deployLabel = deployTarget === "server" && serverName
    ? serverName
    : target.label;

  // Build "destination" derived from (deployTarget, buildStrategy):
  //   - buildStrategy === "local" → local machine
  //   - buildStrategy === "server" → runs ON the deploy target
  // Same destination → collapse Build + Deploy into a single chip with
  // the two icons stacked + a `+` between them, instead of two
  // sections separated by an arrow. Most users have matching targets
  // (cloud-on-cloud, server-on-server), so this is the common case.
  const buildDest = buildStrategy === "local" ? "local" : deployTarget;
  const sameDestination = showBuildStrategy && buildDest === deployTarget;

  // Cloud-only chip on the right of the summary. Two shapes:
  //   - Static workloads (no Start command, files served from the edge)
  //     have no machine to size — show a neutral "Static" chip instead
  //     of a power tier. Otherwise "Low" / "Medium" / etc. would imply
  //     a runtime that doesn't exist.
  //   - Otherwise the picked resource tier with a Zap (power) icon.
  const tierChip =
    deployTarget === "cloud"
      ? !hasServer
        ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/10 text-[11px] font-medium text-sky-500 shrink-0">
            <Globe className="size-3" />
            Static
          </span>
        )
        : cloudResourceTier
          ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-[11px] font-medium text-amber-500 shrink-0">
              <Zap className="size-3" />
              <span className="capitalize">{cloudResourceTier}</span>
            </span>
          )
          : null
      : null;

  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full flex items-center gap-3 px-4 py-3 bg-card rounded-xl border border-border/50 hover:border-primary/30 transition-all group"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {sameDestination ? (
          // Merged view — single line, two icons with a + between to
          // signal "both build and deploy go here", followed by one
          // label. Saves horizontal space vs the two-section layout.
          <div className="flex items-center gap-1.5 text-sm min-w-0">
            <div className="flex items-center gap-0.5 text-muted-foreground shrink-0">
              {build.icon}
              <Plus className="size-2.5" strokeWidth={2.5} />
              {target.icon}
            </div>
            <span className="text-muted-foreground">Build &amp; deploy:</span>
            <span className="font-medium text-foreground truncate">{deployLabel}</span>
          </div>
        ) : (
          <>
            {showBuildStrategy && (
              <>
                <div className="flex items-center gap-1.5 text-sm shrink-0">
                  {build.icon}
                  <span className="text-muted-foreground">Build:</span>
                  <span className="font-medium text-foreground">{build.label}</span>
                </div>
                <ArrowRight className="size-3 text-muted-foreground/50 shrink-0" />
              </>
            )}
            <div className="flex items-center gap-1.5 text-sm min-w-0">
              {target.icon}
              <span className="text-muted-foreground">Deploy:</span>
              <span className="font-medium text-foreground truncate">{deployLabel}</span>
            </div>
          </>
        )}
      </div>
      {tierChip}
      <Pencil className="size-3.5 text-muted-foreground transition-opacity" />
    </button>
  );
};

// ─── Hook: resolve available targets ─────────────────────────────────────────

export interface ResolvedTargets {
  ready: boolean;
  /** All configured servers */
  servers: ServerInfo[];
  hasCloudConnected: boolean;
  hasCloudOption: boolean;
  /** True when there's a real choice to make */
  hasChoice: boolean;
  /** Refetch the server list - used after returning from /servers/new */
  refreshServers: () => void;
}

export function useDesktopTargets(): ResolvedTargets {
  const cloud = useCloud();
  const { selfHosted } = usePlatform();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [serversReady, setServersReady] = useState(false);

  // Fetch servers + filter to ones that can run apps. Exposed so the picker
  // can re-pull after the user adds a new server in another tab.
  const fetchServers = useCallback(() => {
    if (!selfHosted) {
      setServersReady(true);
      return () => {};
    }

    let cancelled = false;
    systemApi.listServers()
      .then((list) => { if (!cancelled) setServers(list); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setServersReady(true); });
    return () => { cancelled = true; };
  }, [selfHosted]);

  useEffect(() => {
    const cleanup = fetchServers();
    return cleanup;
  }, [fetchServers]);

  // Refresh when the tab regains focus - covers the "added a server in a new
  // tab" flow without forcing the user to reload the deploy page.
  useEffect(() => {
    if (!selfHosted) return;
    const onFocus = () => { fetchServers(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [selfHosted, fetchServers]);

  const hasServers = servers.length > 0;
  const hasCloudConnected = cloud.connected;
  const hasCloudOption = true;
  const ready = serversReady && !cloud.loading;

  return {
    ready,
    servers,
    hasCloudConnected,
    hasCloudOption,
    hasChoice: ready && Number(hasServers) + Number(hasCloudOption) > 1,
    refreshServers: fetchServers,
  };
}

// ─── Soft "last pick" memory ─────────────────────────────────────────────────
// Remembers the most recent deploy choice across deployments without the user
// having to opt in via "Save as default". Distinct from the settings-API
// default, which is the explicit, cross-device "always use this" setting:
// localStorage here is the soft, per-browser "what did I pick last time".
//
// Priority on seed: settings-API default > localStorage > auto-select fallback.

export type LastPick = {
  target: DeployTarget;
  serverId?: string | null;
};

export const lastPickStore = createPersistedValue<LastPick>(
  "openship.deploy-last-pick",
  (raw): raw is LastPick => {
    if (!raw || typeof raw !== "object") return false;
    const obj = raw as { target?: unknown; serverId?: unknown };
    if (obj.target !== "local" && obj.target !== "server" && obj.target !== "cloud") return false;
    if (obj.serverId !== undefined && obj.serverId !== null && typeof obj.serverId !== "string") return false;
    return true;
  },
);

// "Have we shown the first-deploy build hint yet?" - set on the first
// Continue. Once set, subsequent deploys get the full Build picker.
const buildHintFlag = createPersistedFlag("openship.build-hint-seen");

// ─── Main step ───────────────────────────────────────────────────────────────

interface DeployTargetStepProps {
  targets: ResolvedTargets;
  onContinue: () => void;
  /**
   * When true (the default), the step auto-advances to the next step if a
   * saved default applies cleanly - the user never sees this screen. Set to
   * false by the parent when the user explicitly navigated back here via
   * the edit affordance, so we don't bounce them straight back out.
   */
  autoSkipAllowed?: boolean;
}

// ─── Cloud resource tiers ────────────────────────────────────────────────────
// Placeholder runtime shapes for the Openship Cloud power picker. The
// numbers here are the UX surface only — the backend owns the
// authoritative cpu/mem/disk values per tier and translates them at
// provision time. Billing is credits-based (no $/mo shown here).
type CloudResourceTier = NonNullable<DeploymentConfig["cloudResourceTier"]>;

const CLOUD_RESOURCE_TIERS: Array<{
    id: Exclude<CloudResourceTier, "custom">;
    label: string;
    cpu: string;
    ram: string;
    disk: string;
    bestFor: string;
}> = [
    {
        id: "micro",
        label: "Micro",
        cpu: "0.25 vCPU",
        ram: "256 MB",
        disk: "4 GB",
        bestFor: "Side projects, low traffic",
    },
    {
        id: "low",
        label: "Low",
        cpu: "0.5 vCPU",
        ram: "512 MB",
        disk: "8 GB",
        bestFor: "Small apps, light APIs",
    },
    {
        id: "medium",
        label: "Medium",
        cpu: "1 vCPU",
        ram: "1 GB",
        disk: "16 GB",
        bestFor: "Most production apps",
    },
    {
        id: "high",
        label: "High",
        cpu: "2 vCPU",
        ram: "2 GB",
        disk: "32 GB",
        bestFor: "Heavy workloads, fast builds",
    },
];

const CUSTOM_DEFAULTS = { cpuCores: 1, memoryMb: 1024, diskMb: 16384 };

// ─── Custom-values modal ─────────────────────────────────────────────────────
// Rendered via showModal() so the inputs get proper breathing room
// instead of trying to fit beside the static spec line in a 320px card.
// Modal is portal-rendered (outside DeploymentProvider) — values are
// passed in via props rather than read from useDeployment here.
interface CustomPowerModalContentProps {
    initial: { cpuCores: number; memoryMb: number; diskMb: number };
    onSave: (values: { cpuCores: number; memoryMb: number; diskMb: number }) => void;
    onCancel: () => void;
}

const CustomPowerModalContent: React.FC<CustomPowerModalContentProps> = ({
    initial,
    onSave,
    onCancel,
}) => {
    const [values, setValues] = useState(initial);
    const set = (patch: Partial<typeof values>) =>
        setValues((prev) => ({ ...prev, ...patch }));
    return (
        <div className="p-6 space-y-5">
            <div className="space-y-1.5">
                <h3 className="text-base font-semibold text-foreground">Custom runtime</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                    Pick the CPU, RAM, and disk this deployment should run with.
                </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">vCPU</span>
                    <input
                        type="number"
                        inputMode="decimal"
                        step="0.25"
                        min="0.25"
                        value={values.cpuCores}
                        onChange={(e) => set({ cpuCores: Number(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </label>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">RAM (MB)</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        step="128"
                        min="128"
                        value={values.memoryMb}
                        onChange={(e) => set({ memoryMb: Number(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </label>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Disk (GB)</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        step="1"
                        min="1"
                        // Stored in MB internally; display as GB so the
                        // input matches what an operator types.
                        value={Math.round(values.diskMb / 1024)}
                        onChange={(e) =>
                            set({ diskMb: Math.max(0, Number(e.target.value) || 0) * 1024 })
                        }
                        className="w-full px-3 py-2 bg-background border border-border/50 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </label>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={() => onSave(values)}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                    Save
                </button>
            </div>
        </div>
    );
};

const CloudPowerPicker: React.FC = () => {
    const { config, updateConfig } = useDeployment();
    const { showModal, hideModal } = useModal();
    const selected = config.cloudResourceTier ?? "low";
    const custom = config.cloudResourceCustom ?? CUSTOM_DEFAULTS;

    // Click on Custom card → open modal. Pre-selects the tier so the choice
    // sticks even if the user cancels (matches the rest of the picker:
    // clicking any tier card commits the selection). Saving from the
    // modal also writes the new values; cancel leaves them as-was.
    const openCustomModal = () => {
        updateConfig({
            cloudResourceTier: "custom",
            cloudResourceCustom: config.cloudResourceCustom ?? CUSTOM_DEFAULTS,
        });
        const id = showModal({
            maxWidth: "480px",
            customContent: (
                <CustomPowerModalContent
                    initial={config.cloudResourceCustom ?? CUSTOM_DEFAULTS}
                    onCancel={() => hideModal(id)}
                    onSave={(values) => {
                        updateConfig({
                            cloudResourceTier: "custom",
                            cloudResourceCustom: values,
                        });
                        hideModal(id);
                    }}
                />
            ),
        });
    };

    return (
        // Header lives OUTSIDE the cards (matching the left column's
        // "Where do you want to deploy?" heading rhythm) so the first
        // tier card visually aligns with the first deploy option across
        // the grid row.
        <div className="space-y-3">
            <div>
                <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                    <Zap className="size-4 text-amber-500" />
                    Power
                </h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                    Pick a runtime size for Openship Cloud
                </p>
            </div>
            <div className="space-y-2">
                {CLOUD_RESOURCE_TIERS.map((tier) => {
                    const isSelected = selected === tier.id;
                    return (
                        <button
                            key={tier.id}
                            type="button"
                            onClick={() => updateConfig({ cloudResourceTier: tier.id })}
                            className={`w-full rounded-xl border p-4 text-left transition-all ${
                                isSelected
                                    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                                    : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
                            }`}
                        >
                            {/* Row 1 — label + description inline with a · divider. */}
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex items-baseline gap-2">
                                    <span className={`text-sm font-semibold shrink-0 ${isSelected ? "text-foreground" : "text-foreground/80"}`}>
                                        {tier.label}
                                    </span>
                                    <span className="text-muted-foreground/70 shrink-0">·</span>
                                    <span className="text-xs text-muted-foreground truncate">
                                        {tier.bestFor}
                                    </span>
                                </div>
                                {isSelected && (
                                    <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                        <div className="size-2 rounded-full bg-primary-foreground" />
                                    </div>
                                )}
                            </div>
                            {/* Row 2 — resources with RAM / Disk labels so each
                                value reads on its own without context. */}
                            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground tabular-nums">
                                <span>{tier.cpu}</span>
                                <span className="text-muted-foreground/70">·</span>
                                <span>RAM {tier.ram}</span>
                                <span className="text-muted-foreground/70">·</span>
                                <span>Disk {tier.disk}</span>
                            </div>
                        </button>
                    );
                })}

                {/* Custom — clicking the card selects it; the inline
                    inputs only appear once selected, so the collapsed
                    state stays tidy. */}
                {/* Custom — clicking opens a modal where the operator can
                    edit CPU / RAM / disk. The card itself mirrors the tier
                    layout exactly: row 1 = label · description, row 2 =
                    current values in the same `vCPU · RAM x · Disk y` shape
                    as the tier cards. Identical height, no in-card inputs
                    bleeding past the border. */}
                <button
                    type="button"
                    onClick={openCustomModal}
                    className={`w-full rounded-xl border p-4 text-left transition-all ${
                        selected === "custom"
                            ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                            : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
                    }`}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-baseline gap-2">
                            <span className={`text-sm font-semibold shrink-0 ${selected === "custom" ? "text-foreground" : "text-foreground/80"}`}>
                                Custom
                            </span>
                            <span className="text-muted-foreground/70 shrink-0">·</span>
                            <span className="text-xs text-muted-foreground truncate">
                                Dial in CPU, RAM, and storage yourself
                            </span>
                        </div>
                        {selected === "custom" && (
                            <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                <div className="size-2 rounded-full bg-primary-foreground" />
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground tabular-nums">
                        <span>{custom.cpuCores} vCPU</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span>RAM {custom.memoryMb} MB</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span>Disk {Math.round(custom.diskMb / 1024)} GB</span>
                    </div>
                </button>
            </div>
        </div>
    );
};

const DeployTargetStep: React.FC<DeployTargetStepProps> = ({ targets, onContinue, autoSkipAllowed = true }) => {
  const { config, updateConfig } = useDeployment();
  const { requireCloud } = useCloud();
  const { selfHosted, deployMode } = usePlatform();
  // Git credential forwarding is desktop-only — the relay forwards the
  // operator's machine-local `gh`, which only exists on a desktop host.
  const isDesktop = deployMode === "desktop";
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const { ready, servers, hasCloudConnected, hasCloudOption, hasChoice, refreshServers } = targets;
  const hasServers = servers.length > 0;
  const isSingleServer = servers.length === 1;
  // "Save as my default for every deployment" - persists the picked target
  // (+ server id when applicable) to user_settings on continue.
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  // Whether to render the full picker vs the compact summary pill.
  // Default = full picker. Flips to compact when a saved default applies
  // cleanly. User can re-expand any time via the pencil on the pill.
  const [expanded, setExpanded] = useState(true);
  // Track when the defaults fetch is done so we can suppress the picker
  // for a brief moment instead of flashing the full picker before collapsing.
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  // First-deploy-ever flag - read from localStorage on mount. When true,
  // we hide the Build picker, auto-match build to deploy, and show a small
  // hint card instead. Flipped off on the first successful Continue so the
  // full picker re-appears on subsequent deploys.
  const [isFirstBuildHint, setIsFirstBuildHint] = useState(false);
  // User can opt into picking the build location manually from inside the
  // hint - when true, the hint hides and the full Build picker is shown.
  const [revealBuildPicker, setRevealBuildPicker] = useState(false);
  // Build picker on subsequent deploys lives under an "Advanced" disclosure
  // so the screen leads with the deploy-target decision. Folded by default
  // because the build strategy is correctly seeded from the user's saved
  // default — most operators never need to touch it on a per-deploy basis.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // True once the user has EXPLICITLY picked a build location from the picker.
  // The auto-match effects below (first-deploy match, cloud-switch default)
  // must never overwrite an explicit choice — otherwise "Build on this machine"
  // silently snaps back to the cloud default. Reset when the deploy target
  // changes so the sensible default applies to the new target.
  const buildStrategyTouchedRef = useRef(false);

  // Add server inline via modal. On create, refresh the server list and
  // auto-select the new one so the user lands on it immediately - no extra
  // clicks, no tab juggling, deploy config stays intact.
  const openAddServer = () => {
    const id = showModal({
      width: "720px",
      maxWidth: "92vw",
      showCloseButton: false,
      customContent: (
        <AddServerModal
          onCancel={() => hideModal(id)}
          onCreated={(server) => {
            hideModal(id);
            refreshServers();
            updateConfig({ deployTarget: "server", serverId: server.id });
          }}
        />
      ),
    });
  };
  const isServiceDeployment = usesServiceDeployment(config);
  const showBuildStrategy =
    config.projectType === "app" || (config.projectType === "services" && !isServiceDeployment);

  // On mount: read first-deploy flag from localStorage. We treat the very
  // first deploy as "build hint shown" - once the user clicks Continue we
  // mark it seen, and from then on the full Build picker is back. Skipping
  // the picker on first run keeps the UI focused; the option remains
  // available in the post-continue summary and in Settings.
  useEffect(() => {
    setIsFirstBuildHint(!buildHintFlag.isSet());
  }, []);

  // First-deploy-only: auto-match build to deploy target. If the user opts
  // to pick manually via the hint's "Choose build location", `revealBuildPicker`
  // flips and we stop forcing the match.
  useEffect(() => {
    // Never override an explicit user pick — only auto-match on the untouched
    // first-deploy default.
    if (!isFirstBuildHint || revealBuildPicker || buildStrategyTouchedRef.current) return;
    const want: BuildStrategy = config.deployTarget === "local" ? "local" : "server";
    if (config.buildStrategy !== want) {
      updateConfig({ buildStrategy: want });
    }
  }, [isFirstBuildHint, revealBuildPicker, config.deployTarget, config.buildStrategy, updateConfig]);

  // Seed the picker from the user's saved default (if any). The ref makes
  // sure we only ever APPLY the default once - even under StrictMode's
  // double-mount in dev - so we never clobber a choice the user made after
  // the initial seed. The fetch itself is allowed to re-run; only the
  // current invocation's `cancelled` flag gates state updates.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    settingsApi.get()
      .then((res) => {
        if (cancelled) return;
        if (appliedDefaultRef.current) return; // already seeded - don't overwrite
        appliedDefaultRef.current = true;

        const target = res?.defaultDeployTarget;
        const savedServerId = res?.defaultServerId;
        let applied = false;
        if (target === "server") {
          if (savedServerId && servers.some((s) => s.id === savedServerId)) {
            updateConfig({ deployTarget: "server", serverId: savedServerId });
            applied = true;
          }
        } else if (target === "cloud") {
          updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
          applied = true;
        } else if (target === "local") {
          updateConfig({ deployTarget: "local", serverId: undefined });
          applied = true;
        }

        // No explicit settings-API default? Try the soft "last pick"
        // memory from localStorage. Validate against current state - if the
        // remembered server has since been deleted, fall through.
        if (!applied) {
          const last = lastPickStore.read();
          if (last) {
            if (last.target === "server") {
              if (last.serverId && servers.some((s) => s.id === last.serverId)) {
                updateConfig({ deployTarget: "server", serverId: last.serverId });
                applied = true;
              }
            } else if (last.target === "cloud" && hasCloudOption) {
              updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
              applied = true;
            } else if (last.target === "local") {
              updateConfig({ deployTarget: "local", serverId: undefined });
              applied = true;
            }
          }
        }

        // Collapse to compact summary only when defaults applied cleanly
        // AND we're not coming back here on purpose. `autoSkipAllowed=false`
        // means the user clicked the edit affordance on the next step to
        // come back and change something - landing them on the compact pill
        // would force an extra click on the pencil to actually edit. Skip
        // the collapse so they see the full picker right away.
        if (applied && autoSkipAllowed) setExpanded(false);
      })
      .catch(() => { /* no default - picker falls back to auto-select */ })
      .finally(() => { if (!cancelled) setDefaultsLoaded(true); });
    return () => { cancelled = true; };
    // Excluded `servers` / `updateConfig` on purpose: this is a one-shot
    // seed keyed off `ready`. The dep array is intentionally tight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Auto-set deploy target when there's only one option
  useEffect(() => {
    if (!ready || hasChoice) {
      return;
    }

    if (hasServers) {
      updateConfig({ deployTarget: "server", serverId: servers[0].id });
      return;
    }

    if (hasCloudOption) {
      updateConfig({ deployTarget: "cloud", serverId: undefined, buildStrategy: "server" });
    }
  }, [ready, hasChoice, hasServers, hasCloudOption, servers, updateConfig]);

  // When switching TO cloud, AUTO-PRESELECT "server" as the build strategy.
  // Cloud builds belong in the cloud runtime — they get the right toolchain
  // automatically and don't burn the host's CPU/RAM. We fire this ONLY on the
  // deployTarget transition into cloud (not on every render) so a user who
  // explicitly switches to "This Machine" via the visible card AFTER the
  // switch is respected — `cloudSupportsLocalBuild` keeps that override card
  // available for stacks that produce a transferable artifact (Next.js .next,
  // Vite dist, etc.). Static-app stacks (no `hasBuild`) have nothing to
  // transfer, so the second clause force-corrects an invalid local pick.
  const prevDeployTargetRef = useRef(config.deployTarget);
  useEffect(() => {
    const justSwitchedToCloud =
      prevDeployTargetRef.current !== "cloud" && config.deployTarget === "cloud";
    prevDeployTargetRef.current = config.deployTarget;
    if (justSwitchedToCloud && config.buildStrategy !== "server") {
      updateConfig({ buildStrategy: "server" });
      return;
    }
    // Always force server-build when the stack can't produce a transferable
    // artifact - local-build would have nothing to ship to cloud.
    if (
      config.deployTarget === "cloud" &&
      config.buildStrategy === "local" &&
      config.options?.hasBuild !== true
    ) {
      updateConfig({ buildStrategy: "server" });
    }
  }, [config.deployTarget, config.buildStrategy, config.options?.hasBuild, updateConfig]);

  // Auto-select single server
  useEffect(() => {
    if (isSingleServer && config.deployTarget === "server" && !config.serverId) {
      updateConfig({ serverId: servers[0].id });
    }
  }, [isSingleServer, config.deployTarget, config.serverId, servers, updateConfig]);

  // Remember the last server actually chosen so flipping cloud↔server doesn't
  // lose it (and the runtime panel that depends on serverId). Tracks whatever
  // path set it — manual pick, single-server auto-select, add-server, default.
  const lastServerIdRef = useRef<string | undefined>(config.serverId || undefined);
  useEffect(() => {
    if (config.deployTarget === "server" && config.serverId) {
      lastServerIdRef.current = config.serverId;
    }
  }, [config.deployTarget, config.serverId]);

  const handleDeployTargetChange = (target: DeployTarget) => {
    // Changing the deploy target re-applies the sensible build default for the
    // new target; the user's previous explicit pick no longer applies.
    buildStrategyTouchedRef.current = false;
    const updates: Partial<typeof config> = { deployTarget: target };
    if (target === "cloud") {
      updates.serverId = undefined;
      updates.buildStrategy = "server";
    }
    if (target === "server") {
      // Restore the previously-chosen server (or auto-pick the only one) so the
      // runtime panel reappears instead of vanishing until a manual re-pick.
      updates.serverId =
        config.serverId ?? lastServerIdRef.current ?? (isSingleServer ? servers[0].id : undefined);
    }
    // Selection is tentative — it only updates local config. The soft "remember
    // this for next time" memory is persisted on Continue (handleContinue), not
    // on every click, so glancing at another target doesn't silently stick.
    updateConfig(updates);
  };

  const handleServerSelect = (server: ServerInfo) => {
    updateConfig({ deployTarget: "server", serverId: server.id });
  };

  // Build the deploy target options
  const deployTargetOptions: Array<{
    value: DeployTarget;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [];

  if (hasServers) {
    if (isSingleServer) {
      // Single server → show directly by name
      deployTargetOptions.push({
        value: "server",
        icon: <Server className="size-5" />,
        label: servers[0].name || servers[0].sshHost,
        description: "Deploy to your remote server via SSH.",
      });
    } else {
      // Multiple servers → show "Servers" category
      deployTargetOptions.push({
        value: "server",
        icon: <Server className="size-5" />,
        label: "Servers",
        description: `Choose from ${servers.length} configured servers.`,
      });
    }
  }

  if (hasCloudOption) {
    deployTargetOptions.push({
      value: "cloud",
      icon: <Cloud className="size-5" />,
      label: "Openship Cloud",
      description: hasCloudConnected
        ? "Deploy to managed cloud infrastructure. No server setup needed."
        : "Connect your Openship Cloud account and deploy to managed infrastructure.",
    });
  }

  const buildOptions: Array<{
    value: BuildStrategy;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [
    {
      value: "local",
      icon: <Cpu className="size-5" />,
      label: "This Machine",
      description: "Build locally, then transfer the output. Faster if you have a powerful machine.",
    },
    {
      value: "server",
      icon: <Cloud className="size-5" />,
      label: "Remote",
      description: "Build on the deploy target. Best when your machine has limited resources.",
    },
  ];
  // For cloud deploys, building locally is a valid cost-saving path when the
  // stack produces a transferable build artifact (Next.js .next, Vite dist,
  // etc.). We charge for cloud build minutes; doing the build on the user's
  // machine and only shipping the output to cloud skips that cost.
  //
  // NOT default - cloud-on-cloud stays the recommended choice. Building
  // locally requires the same toolchain the cloud would use (Node version,
  // pnpm/bun/etc.) and is environment-sensitive, so we surface it as an
  // opt-in option, not the first card. Static-app stacks (no `hasBuild`)
  // can't use local-build because there's no artifact to transfer; skip.
  const cloudSupportsLocalBuild = config.options?.hasBuild === true;
  const visibleBuildOptions = config.deployTarget === "cloud"
    ? [
        {
          value: "server" as const,
          icon: <Cloud className="size-5" />,
          label: "Openship Cloud",
          description: "Build in managed cloud infrastructure. Recommended.",
        },
        ...(cloudSupportsLocalBuild
          ? [
              {
                value: "local" as const,
                icon: <Cpu className="size-5" />,
                label: "This Machine",
                description:
                  "Build locally and ship only the output. Saves cloud build minutes when you have a capable machine.",
              },
            ]
          : []),
      ]
    : buildOptions;

  const hasAnyDeployTarget = deployTargetOptions.length > 0;
  const canContinue = ready && (
    config.deployTarget === "cloud" ||
    (config.deployTarget === "server" && !!config.serverId && hasServers)
  );

  // Auto-skip eligibility - true when a saved default has applied cleanly
  // AND the parent allows skipping. While true, we want to bypass the UI
  // entirely (no flash of compact summary before onContinue fires).
  const baseLoading = !ready || !defaultsLoaded;
  const baseCompactEligible = !baseLoading && !expanded && canContinue;
  const wouldAutoSkip = autoSkipAllowed && baseCompactEligible;

  // Render flags. When we're about to auto-skip, keep showing the loading
  // spinner so the user sees a single transition (spinner → next step)
  // instead of (spinner → compact pill → next step).
  const showLoading = baseLoading || wouldAutoSkip;
  const useCompact = !showLoading && baseCompactEligible;
  const showFullPicker = !showLoading && !useCompact;

  // Auto-skip the entire step when a saved default applies cleanly. Parent
  // sets autoSkipAllowed=false when the user navigated back here on purpose,
  // so this only fires on the initial entry. Ref prevents StrictMode and
  // re-render double-fires; once we've handed off to onContinue we're done.
  const autoSkippedRef = useRef(false);
  useEffect(() => {
    if (!wouldAutoSkip) return;
    if (autoSkippedRef.current) return;
    autoSkippedRef.current = true;
    // Persist the "build hint seen" flag too - auto-skipping past the
    // picker also means the user has effectively been through it once.
    buildHintFlag.set();
    onContinue();
  }, [wouldAutoSkip, onContinue]);

  // Server name for the compact pill - falls back to host if unnamed.
  const selectedServer = config.deployTarget === "server" && config.serverId
    ? servers.find((s) => s.id === config.serverId)
    : null;
  const summaryServerName = selectedServer
    ? (selectedServer.name || selectedServer.sshHost)
    : null;

  // Persist the current pick as the user's default - fire-and-forget so it
  // never blocks the deploy flow. Failures are surfaced as a toast; the
  // deploy itself continues either way.
  const persistDefault = async () => {
    if (!saveAsDefault) return;
    setSavingDefault(true);
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: config.deployTarget,
        defaultServerId: config.deployTarget === "server" ? (config.serverId ?? null) : null,
      });
      showToast("Saved as your default deploy target", "success", "Defaults");
    } catch {
      showToast("Couldn't save default - your deploy will still continue", "error", "Defaults");
    } finally {
      setSavingDefault(false);
    }
  };

  const handleContinue = () => {
    // The only hard gate at this step: deploying TO Openship Cloud needs an
    // Openship Cloud connection. Anything else (free .${baseDomain} domains
    // on own-server / local, free domains in compose services, etc.) is a
    // downstream concern - the stack/domains screens after Continue prompt
    // for cloud at the exact moment it's actually needed. Interrupting here
    // is paternalistic and breaks the "I picked my own server, leave me
    // alone" signal the user just gave us.
    if (config.deployTarget === "cloud" && !hasCloudConnected) {
      if (!requireCloud("Deploying to Openship Cloud")) {
        return;
      }
    }

    // Mark the build hint as seen - future deploys get the full Build picker.
    buildHintFlag.set();

    // Persist the soft "remember this target for next time" memory now — on
    // commit, not on every tentative click. This is what lets a returning user
    // skip straight to config next deploy.
    lastPickStore.write({
      target: config.deployTarget,
      serverId: config.deployTarget === "server" ? (config.serverId ?? null) : null,
    });

    void persistDefault();
    onContinue();
  };

  // Right-column "how it runs" panel: cloud → power/resource picker; a
  // self-hosted SERVER app → runtime-isolation (Sandbox/Direct) picker. Both
  // lay the step out as 2 columns (existing flow left, panel right). Anything
  // else (local, static, docker/compose, compact summary, loading) stays
  // single-column. This component owns its own max-width (below) so the parent
  // page just centers it — the two-column layout needs the wide track, the
  // single-column onboarding stays narrow.
  const showCloudPicker = showFullPicker && config.deployTarget === "cloud";
  const showServerRuntime =
    showFullPicker &&
    config.deployTarget === "server" &&
    !!config.serverId &&
    config.options.hasServer &&
    config.projectType !== "docker" &&
    !isServiceDeployment;
  const showRightPanel = showCloudPicker || showServerRuntime;

  return (
    <div
      className={
        showRightPanel
          ? "mx-auto w-full max-w-5xl grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_1px_320px] gap-0 items-start"
          : "mx-auto w-full max-w-lg"
      }
    >
    <div className={`space-y-8 ${showRightPanel ? "lg:pr-6" : ""}`}>
      {showLoading && (
        <div className="space-y-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Where do you want to deploy?
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Loading your available deploy targets
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 rounded-xl border border-border/50 bg-card px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking servers and cloud connection...
          </div>
        </div>
      )}

      {/* Compact summary - saved default applied cleanly. The pill itself
          is the edit affordance: clicking expands the full picker so the
          user can change build/deploy for this one deployment. */}
      {useCompact && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-foreground">
            Deploy &amp; build
          </h3>
          <DeployTargetSummary
            deployTarget={config.deployTarget}
            buildStrategy={config.buildStrategy}
            serverName={summaryServerName}
            showBuildStrategy={showBuildStrategy}
            onEdit={() => setExpanded(true)}
          />
        </div>
      )}

      {/* Deploy target */}
      {showFullPicker && hasAnyDeployTarget && (
        <div className="space-y-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Where do you want to deploy?
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              {hasChoice
                ? "Choose where your application will run"
                : "Only one deploy target is currently available"}
            </p>
          </div>
          <div className="space-y-2">
            {deployTargetOptions.map((opt) => (
              <OptionCard
                key={opt.value}
                value={opt.value}
                selected={config.deployTarget === opt.value}
                onSelect={() => handleDeployTargetChange(opt.value)}
                icon={opt.icon}
                label={opt.label}
                description={opt.description}
              >
                {/* Sub-selector for multiple servers */}
                {opt.value === "server" && !isSingleServer && config.deployTarget === "server" && (
                  <ServerSubSelector
                    servers={servers}
                    selectedId={config.serverId}
                    onSelect={handleServerSelect}
                  />
                )}
              </OptionCard>
            ))}
          </div>
          {selfHosted && (
            <button
              type="button"
              onClick={openAddServer}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 bg-card/40 px-4 py-2.5 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/30 transition-all"
            >
              <Plus className="size-3.5" />
              Add your own server
            </button>
          )}

          {/* Git credential forwarding — desktop-only, server target only,
              default off. Lets the remote clone with the operator's local `gh`
              instead of build-local-then-upload. Nothing is persisted on the
              remote; the relay closes when the build ends. */}
          {isDesktop && config.deployTarget === "server" && (
            <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-xl border border-border/50 bg-card/40 px-4 py-3">
              <input
                type="checkbox"
                checked={config.forwardGitCredentials === true}
                onChange={(e) => updateConfig({ forwardGitCredentials: e.target.checked })}
                className="mt-0.5 size-4 shrink-0 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30 focus:ring-offset-0 cursor-pointer"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <GitBranch className="size-3.5 text-muted-foreground" />
                  Forward my git credentials
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground leading-snug">
                  Clone on the server using your local{" "}
                  <span className="font-mono text-foreground/80">gh</span> identity — no
                  build-and-upload. Nothing is stored on the server.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {showFullPicker && !hasAnyDeployTarget && (
        <div className="space-y-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Where do you want to deploy?
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              No deploy target is available yet
            </p>
          </div>
          <div className="rounded-xl border border-border/50 bg-card px-4 py-4 text-sm text-muted-foreground leading-relaxed">
            Connect Openship Cloud or add a server to continue with this deployment.
          </div>
          {selfHosted && (
            <button
              type="button"
              onClick={openAddServer}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 bg-card/40 px-4 py-2.5 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/30 transition-all"
            >
              <Plus className="size-3.5" />
              Add your own server
            </button>
          )}
        </div>
      )}

      {/* First-deploy hint - replaces the build picker on the user's very
          first deployment. We auto-match build to deploy target and surface
          the option as an inline "did you know" so the picker isn't gone
          forever - they can reveal it inline or change it on the next
          screen. After the first Continue, the full picker is always shown. */}
      {showFullPicker && showBuildStrategy && isFirstBuildHint && !revealBuildPicker && (
        <div className="rounded-xl border border-border/40 bg-muted/15 px-4 py-3.5">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
              <Sparkles className="size-4 text-amber-500" strokeWidth={1.75} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">
                We&apos;ll {config.options.hasBuild ? "build" : "prepare"} where you deploy
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                {config.deployTarget === "cloud"
                  ? "Builds run in managed cloud infrastructure - nothing to set up."
                  : config.deployTarget === "server"
                    ? `Builds run on your ${summaryServerName ? `server "${summaryServerName}"` : "server"}. If it's a small VPS, building on this machine can be much faster. You can change this on the next screen or save a preference in Settings.`
                    : "Builds run on this machine. You can change this on the next screen or save a preference in Settings."}
              </p>
              {config.deployTarget !== "cloud" && (
                <button
                  type="button"
                  onClick={() => setRevealBuildPicker(true)}
                  className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Choose build location
                  <ArrowRight className="size-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showFullPicker && showBuildStrategy && (!isFirstBuildHint || revealBuildPicker) && (
        <div className="rounded-2xl border border-border/50 bg-card">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-muted/40">
                <Settings2 className="size-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Advanced</p>
                <p className="text-xs text-muted-foreground">
                  {config.options.hasBuild ? "Build" : "Prepare"} on{" "}
                  {visibleBuildOptions.find((o) => o.value === config.buildStrategy)?.label ?? "—"}
                </p>
              </div>
            </div>
            {advancedOpen ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {advancedOpen && (
            <div className="border-t border-border/50 px-5 py-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  {config.options.hasBuild ? "Where do you want to build?" : "Where do you want to prepare it?"}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {config.options.hasBuild
                    ? "Choose where the build process runs"
                    : "Choose where the repository is cloned and staged before deploy"}
                </p>
              </div>
              <div className="space-y-2">
                {visibleBuildOptions.map((opt) => (
                  <OptionCard
                    key={opt.value}
                    value={opt.value}
                    selected={config.buildStrategy === opt.value}
                    onSelect={() => {
                      buildStrategyTouchedRef.current = true;
                      updateConfig({ buildStrategy: opt.value });
                    }}
                    icon={opt.icon}
                    label={opt.label}
                    description={opt.description}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Save as default - fire-and-forget on continue. Only shown in the
          full picker; in compact mode the default's already in use. */}
      {showFullPicker && canContinue && (
        <label className="flex items-start gap-2.5 cursor-pointer select-none px-1">
          <input
            type="checkbox"
            checked={saveAsDefault}
            onChange={(e) => setSaveAsDefault(e.target.checked)}
            disabled={savingDefault}
            className="mt-0.5 size-4 shrink-0 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30 focus:ring-offset-0 cursor-pointer disabled:opacity-50"
          />
          <span className="text-sm text-muted-foreground leading-snug">
            Save as my default for every deployment.{" "}
            <span className="text-muted-foreground/70">
              Change it later in Settings, or per-deploy from the picker on this page.
            </span>
          </span>
        </label>
      )}

      {/* Continue */}
      <button
        type="button"
        onClick={handleContinue}
        disabled={!canContinue}
        className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
      >
        Continue
        <ArrowRight className="size-4" />
      </button>
    </div>
    {showRightPanel && (
      <>
        {/* Vertical divider line between the two columns. Sits in its
            own 1px-wide grid track so the column widths stay clean and
            the line is perfectly centered in the gutter. Hidden on
            mobile where the layout collapses to a single column. */}
        <div className="hidden lg:block w-px bg-border self-stretch" />
        {/* Slide-in keyed on deployTarget so the animation re-fires
            each time the user flips targets (not only on first selection). */}
        <div key={config.deployTarget} className="lg:pl-6 animate-slide-in-right">
          {showCloudPicker ? <CloudPowerPicker /> : <ServerRuntimePicker />}
        </div>
      </>
    )}
    </div>
  );
};

export default DeployTargetStep;
