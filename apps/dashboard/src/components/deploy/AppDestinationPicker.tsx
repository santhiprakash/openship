"use client";

import React, { useEffect, useState } from "react";
import { Server, Cloud, Cpu, Plus } from "lucide-react";
import {
  OptionCard,
  useDesktopTargets,
  lastPickStore,
} from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import { AddServerModal } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/AddServerModal";
import type { DeployTarget } from "@/context/deployment/types";
import { useI18n } from "@/components/i18n-provider";

export interface AppDestination {
  deployTarget: DeployTarget;
  serverId?: string;
}

/**
 * "Where to install" picker for the app wizards — the SAME target selection as
 * the deploy wizard, assembled from its shared primitives (useDesktopTargets +
 * OptionCard + lastPickStore + AddServerModal) with zero logic duplication.
 * Reports the pick as {deployTarget, serverId} and remembers the last choice.
 */
export function AppDestinationPicker({
  value,
  onChange,
  allowLocal = false,
}: {
  value: AppDestination | null;
  onChange: (d: AppDestination) => void;
  allowLocal?: boolean;
}) {
  const targets = useDesktopTargets();
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  const opt = t.deploy.targetStep.options;
  const [showAdd, setShowAdd] = useState(false);

  const pick = (d: AppDestination) => {
    onChange(d);
    lastPickStore.write({ target: d.deployTarget, serverId: d.serverId ?? null });
  };

  // Seed once targets resolve + nothing chosen: last pick (if still valid),
  // else first server, else cloud. Never overrides an explicit choice.
  useEffect(() => {
    if (!targets.ready || value) return;
    const last = lastPickStore.read();
    if (
      last &&
      (last.target !== "server" ||
        (!!last.serverId && targets.servers.some((s) => s.id === last.serverId)))
    ) {
      onChange({ deployTarget: last.target, serverId: last.serverId ?? undefined });
    } else if (targets.servers.length > 0) {
      onChange({ deployTarget: "server", serverId: targets.servers[0].id });
    } else {
      onChange({ deployTarget: "cloud" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.ready]);

  if (!targets.ready) {
    return <div className="h-16 animate-pulse rounded-xl border border-border/50 bg-card" />;
  }

  return (
    <div className="space-y-2">
      {targets.servers.map((s) => (
        <OptionCard
          key={s.id}
          value={`server:${s.id}`}
          selected={value?.deployTarget === "server" && value.serverId === s.id}
          onSelect={() => pick({ deployTarget: "server", serverId: s.id })}
          icon={<Server className="size-4" />}
          label={s.name || s.sshHost}
          description={`${s.sshUser || "root"}@${s.sshHost}`}
        />
      ))}

      {targets.hasCloudOption && (
        <OptionCard
          value="cloud"
          selected={value?.deployTarget === "cloud"}
          onSelect={() => pick({ deployTarget: "cloud" })}
          icon={<Cloud className="size-4" />}
          label={opt.cloud}
          description={targets.hasCloudConnected ? opt.cloudConnectedDesc : opt.cloudDisconnectedDesc}
        />
      )}

      {allowLocal && (
        <OptionCard
          value="local"
          selected={value?.deployTarget === "local"}
          onSelect={() => pick({ deployTarget: "local" })}
          icon={<Cpu className="size-4" />}
          label={w.destLocal}
          description={w.destLocalDesc}
        />
      )}

      <button
        type="button"
        onClick={() => setShowAdd(true)}
        className="inline-flex items-center gap-1.5 px-1 pt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" /> {t.deploy.targetStep.addServer}
      </button>

      {showAdd && (
        <AddServerModal
          onCancel={() => setShowAdd(false)}
          onCreated={(server) => {
            setShowAdd(false);
            targets.refreshServers();
            pick({ deployTarget: "server", serverId: server.id });
          }}
        />
      )}
    </div>
  );
}
