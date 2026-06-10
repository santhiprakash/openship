"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, Loader2, Server, Cloud, Cpu, Rocket, X } from "lucide-react";
import { settingsApi } from "@/lib/api";
import { systemApi } from "@/lib/api/system";
import type { ServerInfo } from "@/lib/api/system";
import type { DefaultDeployTarget } from "@/lib/api/settings";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

// Static target options. "server" gets a server-id sub-picker below.
const TARGET_OPTIONS: {
  value: DefaultDeployTarget;
  label: string;
  desc: string;
  icon: React.ElementType;
}[] = [
  { value: "local", label: "This Machine", desc: "Local Docker / runtime", icon: Cpu },
  { value: "server", label: "My Server", desc: "A configured SSH server", icon: Server },
  { value: "cloud", label: "OpenShip Cloud", desc: "Managed cloud infra", icon: Cloud },
];

export function DeployDefaults() {
  const { showToast } = useToast();
  const [target, setTarget] = useState<DefaultDeployTarget | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [res, serverList] = await Promise.all([
        settingsApi.get(),
        systemApi.listServers().catch(() => [] as ServerInfo[]),
      ]);
      setTarget(res?.defaultDeployTarget ?? null);
      setServerId(res?.defaultServerId ?? null);
      setServers(serverList);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Save the picked target. For target='server' we require a serverId;
  // we don't auto-pick the first server because that hides the choice
  // from the user - they should select one explicitly.
  async function save(nextTarget: DefaultDeployTarget | null, nextServerId: string | null) {
    if (nextTarget === "server" && !nextServerId) {
      showToast("Pick a server first", "error", "Defaults");
      return;
    }
    setSaving(true);
    const prevTarget = target;
    const prevServerId = serverId;
    setTarget(nextTarget);
    setServerId(nextTarget === "server" ? nextServerId : null);
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: nextTarget,
        defaultServerId: nextTarget === "server" ? nextServerId : null,
      });
      showToast(
        nextTarget === null
          ? "Default deploy target cleared"
          : `Default set to ${labelFor(nextTarget, nextServerId, servers)}`,
        "success",
        "Defaults",
      );
    } catch {
      setTarget(prevTarget);
      setServerId(prevServerId);
      showToast("Failed to update default", "error", "Defaults");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      icon={Rocket}
      title="Deploy Defaults"
      description="Where new deployments should land by default"
      iconBg="bg-blue-500/10"
      iconColor="text-blue-500"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          Loading preferences…
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            Picked target is preselected on the deploy picker. You can still
            override it per deployment, or clear it to be asked every time.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {TARGET_OPTIONS.map(({ value, label, desc, icon: ModeIcon }) => {
              const active = target === value;
              return (
                <button
                  key={value}
                  onClick={() => save(value, value === "server" ? serverId : null)}
                  disabled={saving}
                  className={`relative text-left rounded-xl border p-4 transition-all ${
                    active
                      ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 bg-card hover:bg-muted/40 hover:border-border"
                  } disabled:opacity-50`}
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                    <ModeIcon className="size-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                  {active && (
                    <div className="absolute top-3 right-3">
                      <Check className="size-4 text-primary" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Server sub-picker - only when target=server */}
          {target === "server" && (
            <div className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2 px-1">
                Default server
              </p>
              {servers.length === 0 ? (
                <p className="text-xs text-muted-foreground px-1 py-1.5">
                  No servers configured yet - add one from the deploy picker.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {servers.map((s) => {
                    const isSelected = serverId === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={saving}
                        onClick={() => save("server", s.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                          isSelected
                            ? "bg-primary/10 border border-primary/30"
                            : "bg-card/60 border border-border/30 hover:border-primary/20 hover:bg-muted/30"
                        } disabled:opacity-50`}
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
                          <Check className="size-4 text-primary shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Clear */}
          {target !== null && (
            <button
              type="button"
              onClick={() => save(null, null)}
              disabled={saving}
              className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <X className="size-3" />
              Clear default (ask every time)
            </button>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function labelFor(
  target: DefaultDeployTarget,
  serverId: string | null,
  servers: ServerInfo[],
): string {
  if (target === "server") {
    const s = servers.find((srv) => srv.id === serverId);
    return s ? (s.name || s.sshHost) : "your server";
  }
  if (target === "cloud") return "Openship Cloud";
  return "This Machine";
}
