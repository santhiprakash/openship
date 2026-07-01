"use client";

/**
 * Settings — tabbed layout with left sidebar (desktop) + horizontal
 * scroll tabs (mobile). Mirrors the project-detail page pattern.
 *
 * Tabs:
 *   - general   → GitHub connection, deploy defaults, build preferences
 *   - tokens    → clone credentials, API access tokens
 *   - mcp        → MCP connection (endpoint + client config)
 *   - team      → organization members + invitations (moved from /members)
 *   - audit     → audit log feed (moved from /audit), admin+ only
 *   - cloud     → cloud connection (self-hosted only)
 *   - instance  → instance info
 */

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useToast } from "@/context/ToastContext";

import { BuildPreferences } from "./_components/BuildPreferences";
import { DeployDefaults } from "./_components/DeployDefaults";
import { CloudConnection } from "./_components/CloudConnection";
import { GitHubConnection } from "./_components/GitHubConnection";
import { CloneCredentials } from "./_components/CloneCredentials";
import { PersonalAccessTokens } from "./_components/PersonalAccessTokens";
import { McpConnection } from "./_components/McpConnection";
import { InstanceInfo } from "./_components/InstanceInfo";
import { TeamTab } from "./_components/TeamTab";
import { NotificationsTab } from "./_components/NotificationsTab";
import { AuditTab } from "./_components/AuditTab";
import {
  SettingsSidebar,
  SettingsMobileTabs,
  useSettingsTabs,
} from "./_components/SettingsSidebar";
import { PageContainer } from "@/components/ui/PageContainer";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <PageContainer>
          <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </PageContainer>
      }
    >
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const { selfHosted } = usePlatform();
  const { refresh } = useCloud();
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const { activeTab } = useSettingsTabs();

  // Build preferences: only self-hosted — SaaS manages builds.
  const showBuildPreferences = selfHosted;
  // Deploy defaults: only meaningful where the picker exists (desktop / self-hosted)
  const showDeployDefaults = selfHosted;

  /* ── Cloud callback (redirect after connect) ── */
  useEffect(() => {
    if (searchParams.get("cloud") === "connected") {
      refresh();
      showToast("Connected to Openship Cloud", "success", "Cloud");
      window.history.replaceState({}, "", "/settings?tab=cloud");
    }
  }, [searchParams, showToast, refresh]);

  return (
    <PageContainer>
      <div className="mb-6">
        <h1
          className="text-2xl font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          Settings
        </h1>
        <p className="text-sm text-muted-foreground/70 mt-1">
          Manage your preferences, team, and instance configuration
        </p>
      </div>

      <SettingsMobileTabs />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 mt-4 lg:mt-0">
        {/* ── ACTIVE TAB CONTENT (left, primary) ── */}
        <div className="space-y-6 min-w-0">
          {activeTab === "general" && (
            <>
              <GitHubConnection />
              {showDeployDefaults && <DeployDefaults />}
              {showBuildPreferences && <BuildPreferences />}
            </>
          )}

          {activeTab === "tokens" && (
            <>
              <CloneCredentials />
              <PersonalAccessTokens />
            </>
          )}

          {activeTab === "mcp" && <McpConnection />}

          {activeTab === "team" && <TeamTab />}

          {activeTab === "notifications" && <NotificationsTab />}

          {activeTab === "audit" && <AuditTab />}

          {activeTab === "cloud" && selfHosted && <CloudConnection />}

          {activeTab === "instance" && <InstanceInfo />}
        </div>

        {/* ── NAV (right, sticky on desktop) ── */}
        <aside className="hidden lg:block lg:sticky lg:top-6 lg:self-start">
          <SettingsSidebar />
        </aside>
      </div>
    </PageContainer>
  );
}
