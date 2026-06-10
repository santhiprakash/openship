"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useProjectInfo, useAnalyticsData } from "@/hooks/useProjectEndpoints";
import {
  ExternalLink,
  GitBranch,
  Cpu,
  Server,
  Users,
  Gauge,
  ArrowUpDown,
  BarChart3,
  Layers,
  ChevronRight,
  Container,
} from "lucide-react";

export const OverviewTab = () => {
  const {
    projectData,
    gitData,
    buildData,
    setActiveTab,
    id,
    servicesData,
  } = useProjectSettings();

  // ATOMIC PER-ENDPOINT HOOKS — each one owns its own skeleton state.
  // No context coupling, no useMemo soup. Module-level caches dedup
  // concurrent fetches across components (e.g. OverviewTab and
  // MonitoringTab share one summary fetch).
  const projectInfoQuery = useProjectInfo(id);
  const analytics = useAnalyticsData(id);
  const analyticsData = analytics.data;
  const services = servicesData.services;
  const serviceCount = servicesData.isLoading
    ? (projectData.serviceCount ?? services.length)
    : services.length;

  // deployTarget comes from API (active deployment's meta), not from global dashboard mode
  const deployTarget = projectData.deployTarget as string | null;
  const platformLabel =
    deployTarget === "cloud"
      ? "Openship Cloud"
      : deployTarget === "server"
        ? "Self-hosted (Server)"
        : deployTarget === "local"
          ? "Self-hosted (Local)"
          : "-";
  const hasGit = !!(projectData.gitOwner && projectData.gitRepo);
  const isStaticRuntime =
    projectData.hasServer === false ||
    projectData.options?.hasServer === false ||
    projectData.productionMode === "static";
  const modeLabel = isStaticRuntime
    ? "Static Site"
    : projectData.productionMode === "standalone"
      ? "Standalone"
      : "Server";

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num?.toString() || "0";
  };

  // Each skeleton gate reads STRICTLY from its own hook's isLoading.
  // No cross-coupling possible — info, summary, periods each own a
  // module-level cache and an independent isLoading boolean. A slow
  // periods endpoint cannot pin the stats; a slow getInfo cannot pin
  // the analytics widgets.
  const showProjectInfoSkeleton = projectInfoQuery.isLoading;
  const showStatsSkeleton = analytics.isLoadingSummary;
  const showChartSkeleton = analytics.isLoadingPeriods;
  type Stat = {
    label: string;
    value: string;
    icon: React.ReactNode;
    subtext?: string;
    loading?: boolean;
  };
  const hasAnalytics = !!analyticsData;
  const stats: Stat[] = showStatsSkeleton
    ? [
        { label: "Server Requests", value: "", icon: <Server className="size-4" />, loading: true },
        { label: "Unique IPs", value: "", icon: <Users className="size-4" />, loading: true },
        { label: "Avg Response", value: "", icon: <Gauge className="size-4" />, loading: true },
        { label: "Bandwidth Out", value: "", icon: <ArrowUpDown className="size-4" />, loading: true },
      ]
    : [
        {
          label: "Server Requests",
          value: formatNumber(analyticsData?.summary?.uniqueRequests ?? 0),
          icon: <Server className="size-4" />,
          subtext: `${formatNumber(analyticsData?.summary?.totalRequests ?? 0)} total, ${analyticsData?.summary?.avgRequestsPerHour ?? 0}/hr avg`,
        },
        {
          label: "Unique IPs",
          value: formatNumber(analyticsData?.summary?.uniqueIPs ?? 0),
          icon: <Users className="size-4" />,
          subtext: `${analyticsData?.summary?.uniqueIPsPercentage ?? 0}% of total`,
        },
        {
          label: "Avg Response",
          value: `${analyticsData?.performance?.avgResponseTimeMs?.toFixed(2) || "N/A "}ms`,
          icon: <Gauge className="size-4" />,
          subtext: "Response time",
        },
        {
          label: "Bandwidth Out",
          value: analyticsData?.bandwidth?.totalOutFormatted || "N/A",
          icon: <ArrowUpDown className="size-4" />,
          subtext: `${analyticsData?.bandwidth?.totalInFormatted ?? "0 B"} in`,
        },
      ];

  const trafficData = analyticsData?.trafficByHour || [];
  const topPaths = analyticsData?.topPaths || [];
  const dateRange = analyticsData
    ? `${new Date(analyticsData.summary.firstRequest).toLocaleDateString()} – ${new Date(analyticsData.summary.lastRequest).toLocaleDateString()}`
    : undefined;

  const displayData =
    trafficData.length > 0
      ? trafficData
      : Array.from({ length: 24 }, (_, i) => ({ hour: i, requests: 0 }));
  const maxRequests = Math.max(...displayData.map((d) => d.requests), 1);
  const areaData = displayData.length === 1 ? [displayData[0], displayData[0]] : displayData;

  return (
    <div className="space-y-5">
      {/* ── Info sections ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Infrastructure */}
        <Card title="Infrastructure" icon={Cpu} iconColor="primary">
          <Item label="Platform" value={platformLabel} loading={showProjectInfoSkeleton} />
          <Item label="Mode" value={modeLabel} loading={showProjectInfoSkeleton} />
          {/* Port row shown when loading (we don't know hasServer yet)
              or when there's an actual server runtime. Once project
              info hydrates and we know it's static, the row is hidden. */}
          {(showProjectInfoSkeleton || !isStaticRuntime) && (
            <Item
              label="Port"
              value={String(projectData.port || 3000)}
              loading={showProjectInfoSkeleton}
            />
          )}
        </Card>

        {/* Source & CI/CD */}
        <Card title="Source & CI/CD" icon={GitBranch} iconColor="orange">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">Repository</span>
            {showProjectInfoSkeleton ? (
              <div className="h-[14px] w-28 rounded bg-muted-foreground/20 animate-pulse" />
            ) : hasGit ? (
              <a
                href={`https://github.com/${projectData.gitOwner}/${projectData.gitRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-medium text-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5 truncate max-w-[180px]"
              >
                {projectData.gitOwner}/{projectData.gitRepo}
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <span className="text-[13px] text-muted-foreground/60">Not connected</span>
            )}
          </div>
          <Item
            label="Branch"
            value={projectData.gitBranch || projectData.branch || "main"}
            loading={showProjectInfoSkeleton}
          />
          <StatusItem
            label="Auto Deploy"
            active={!!gitData?.autoDeployEnabled}
            loading={showProjectInfoSkeleton}
          />
          <StatusItem
            label="Webhook"
            active={!!gitData?.webhookActive}
            loading={showProjectInfoSkeleton}
          />
        </Card>
      </div>

      {/* ── Monitoring ────────────────────────────────────────── */}

      {/* Compact stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-card rounded-xl border border-border/50 px-3.5 py-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-primary [&>svg]:size-3.5">{s.icon}</span>
              <span className="text-[11px] text-muted-foreground font-medium">{s.label}</span>
            </div>
            {s.loading ? (
              <>
                {/* Skeleton bars roughly matching the value (large) and
                    subtext (small) line heights so the card doesn't
                    visibly jump when the data lands. Tuned to
                    `bg-muted-foreground/*` instead of `bg-muted/*` -
                    the latter is nearly identical to the card surface
                    in this theme and renders almost invisible. */}
                <div className="h-[18px] w-12 rounded bg-muted-foreground/25 animate-pulse" />
                <div className="h-[10px] w-20 mt-1.5 rounded bg-muted-foreground/15 animate-pulse" />
              </>
            ) : (
              <>
                <p className="text-[18px] font-semibold text-foreground leading-tight">{s.value}</p>
                {s.subtext && (
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">{s.subtext}</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Compact traffic chart */}
      <div className="bg-card rounded-2xl border border-border/50 px-4 py-3.5">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <BarChart3 className="size-3.5 text-primary" />
            <span className="text-[13px] font-semibold text-foreground">Traffic</span>
          </div>
          {dateRange && <span className="text-[11px] text-muted-foreground">{dateRange}</span>}
        </div>
        {showChartSkeleton ? (
          // Chart-shaped skeleton - animated bars at varied heights so
          // the placeholder reads as "a chart is coming" instead of a
          // bare text line. Gated on `showChartSkeleton` (periods
          // hydration) only — the stat cards above use their own
          // `showStatsSkeleton`, so a fast `summary` endpoint can flip
          // those even while `periods` is still in flight.
          <div className="flex items-end gap-[3px] h-[120px] px-1 pb-1">
            {Array.from({ length: 32 }).map((_, i) => {
              // Deterministic varied heights - sine-based so the bars
              // form a wave rather than a uniform block, and the
              // sequence stays stable across re-renders.
              const h = 18 + Math.abs(Math.sin(i * 0.7)) * 70;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-muted-foreground/15 animate-pulse"
                  style={{ height: `${h}%`, animationDelay: `${i * 40}ms` }}
                />
              );
            })}
          </div>
        ) : !hasAnalytics ? (
          <div className="flex items-center justify-center h-[120px] rounded-xl border border-dashed border-border/50 bg-muted/10">
            <span className="text-[12px] text-muted-foreground">No traffic data yet</span>
          </div>
        ) : (
          <div>
            <div className="relative h-[120px]">
              <svg
                className="absolute inset-0 w-full h-full text-primary"
                viewBox="0 0 1000 200"
                preserveAspectRatio="none"
                style={{ color: "hsl(var(--primary))" }}
              >
                <defs>
                  <linearGradient id="overviewAreaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="20%" stopColor="currentColor" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path
                  d={`M 0 200 ${areaData
                    .map((d, i) => {
                      const x = areaData.length === 1 ? 500 : (i / (areaData.length - 1)) * 1000;
                      const y = 200 - (d.requests / maxRequests) * 180;
                      return `L ${x} ${y}`;
                    })
                    .join(" ")} L 1000 200 Z`}
                  fill="url(#overviewAreaGrad)"
                />
                <path
                  d={areaData
                    .map((d, i) => {
                      const x = areaData.length === 1 ? 500 : (i / (areaData.length - 1)) * 1000;
                      const y = 200 - (d.requests / maxRequests) * 180;
                      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </div>
            <div className="flex items-center justify-between mt-1 text-[9px] text-muted-foreground">
              {displayData
                .filter((_, i) => i % 6 === 0)
                .map((d, i) => (
                  <span key={i}>{d.hour}:00</span>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Connected Services bar */}
      <button
        onClick={() => {
          const projectId = projectData.id || id;
          if (!projectId || projectId === "undefined") return;
          setActiveTab("services");
          window.history.replaceState({}, "", `/projects/${projectId}/services`);
        }}
        className="w-full bg-card rounded-2xl border border-border/50 px-4 py-3 flex items-center justify-between hover:bg-accent/50 transition-colors group"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <Layers className="size-3.5 text-emerald-500" />
          </div>
          <span className="text-[13px] font-medium text-foreground">Services</span>
          {serviceCount > 0 && (
            <span className="text-[11px] font-semibold text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-md">
              {serviceCount}
            </span>
          )}
          {services.length > 0 && (
            <div className="flex items-center gap-1 ml-1">
              {services.slice(0, 4).map((svc) => (
                <div
                  key={svc.id}
                  title={svc.name}
                  className="w-6 h-6 rounded-md bg-muted/50 flex items-center justify-center"
                >
                  <Container className="size-3 text-muted-foreground" />
                </div>
              ))}
              {services.length > 4 && (
                <span className="text-[10px] text-muted-foreground/60 ml-0.5">
                  +{services.length - 4}
                </span>
              )}
            </div>
          )}
          {serviceCount === 0 && (
            <span className="text-[11px] text-muted-foreground/50">No services connected</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="text-[12px]">Manage</span>
          <ChevronRight className="size-3.5 group-hover:translate-x-0.5 transition-transform" />
        </div>
      </button>

      {/* Top paths (compact) */}
      {topPaths.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 px-4 py-3.5">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="size-3.5 text-primary" />
            <span className="text-[13px] font-semibold text-foreground">Top Paths</span>
          </div>
          <div className="space-y-2">
            {topPaths.slice(0, 5).map((p, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <span className="text-[12px] text-muted-foreground font-medium truncate flex-1 min-w-0">
                  {p.path}
                </span>
                <span className="text-[11px] font-medium text-primary shrink-0">
                  {p.percentage}%
                </span>
                <div className="w-20 bg-muted/50 rounded-full h-1.5 shrink-0 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${p.percentage}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground/60 shrink-0 w-14 text-right">
                  {p.count} req
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ── Sub-components ────────────────────────────────────────────────── */

const ICON_COLORS: Record<string, { bg: string; text: string }> = {
  primary: { bg: "bg-primary/10", text: "text-primary" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-500" },
  blue: { bg: "bg-blue-500/10", text: "text-blue-500" },
  emerald: { bg: "bg-emerald-500/10", text: "text-emerald-500" },
};

function Card({
  title,
  icon: Icon,
  iconColor = "primary",
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor?: keyof typeof ICON_COLORS;
  children: React.ReactNode;
}) {
  const colors = ICON_COLORS[iconColor] || ICON_COLORS.primary;
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors.bg}`}>
          <Icon className={`size-4 ${colors.text}`} />
        </div>
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      </div>
      <div className="px-5 py-4 space-y-3">{children}</div>
    </div>
  );
}

function Item({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {loading ? (
        <div className="h-[14px] w-24 rounded bg-muted-foreground/20 animate-pulse" />
      ) : (
        <span className="text-[13px] font-medium text-foreground truncate max-w-[200px]">
          {value}
        </span>
      )}
    </div>
  );
}

function StatusItem({ label, active, loading }: { label: string; active: boolean; loading?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {loading ? (
        <div className="h-[18px] w-14 rounded-full bg-muted-foreground/20 animate-pulse" />
      ) : (
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
            active
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted/60 text-muted-foreground/60"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
          />
          {active ? "Active" : "Off"}
        </span>
      )}
    </div>
  );
}
