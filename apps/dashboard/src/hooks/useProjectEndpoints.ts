"use client";

/**
 * Atomic per-endpoint hooks for the project page.
 *
 * Each hook owns one endpoint end-to-end:
 *   - fires its own fetch in a useEffect keyed on `id`
 *   - manages its own loading / data / error state
 *   - returns the same { data, isLoading, error } shape
 *
 * There is NO shared state, NO context, NO useMemo soup, NO cross-coupling.
 * If you only need stats data, call `useAnalyticsSummary(id)` and gate your
 * skeleton on its `isLoading` — a slow `getInfo` cannot affect you.
 *
 * Dedup across components: each endpoint has a module-level in-flight
 * promise + resolved-result cache keyed by id, so OverviewTab and
 * MonitoringTab fetching the same endpoint share one network request.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, endpoints, projectsApi } from "@/lib/api";

// ─── Shared types ──────────────────────────────────────────────────────────

interface ProjectInfoData {
  project: any;
  environments?: any[];
}

export interface AnalyticsSummaryResponse {
  totalRequests: number;
  uniqueVisitors: number;
  bandwidthIn: number;
  bandwidthOut: number;
  avgResponseTimeMs: number;
  lastUpdated: string | null;
}

export interface AnalyticsPeriodResponse {
  from: string;
  to: string;
  requests: number;
  uniqueVisitors: number;
  bandwidthIn: number;
  bandwidthOut: number;
  avgResponseTimeMs: number;
}

/** Legacy combined shape used by display components. Derived from summary
 *  + periods via `mapAnalyticsData`. */
export interface AnalyticsData {
  success: boolean;
  domain: string;
  summary: {
    totalRequests: number;
    uniqueIPs: number;
    uniqueRequests: number;
    totalIPs: number;
    uniqueIPsPercentage: string;
    firstRequest: string;
    lastRequest: string;
    timeRangeHours: number;
    avgRequestsPerHour: number;
  };
  performance: {
    avgResponseTime: number;
    avgResponseTimeMs: number;
    totalResponseTime: number;
    minResponseTime: string;
    maxResponseTime: string;
  };
  bandwidth: {
    totalIn: number;
    totalOut: number;
    totalInFormatted: string;
    totalOutFormatted: string;
    avgRequestSize: number;
    avgResponseSize: number;
  };
  topPaths: Array<{ path: string; count: number; percentage: string }>;
  trafficByHour: Array<{ hour: number; requests: number }>;
  limited: boolean;
}

interface AsyncState<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
}

// ─── Per-endpoint dedup caches ─────────────────────────────────────────────

/**
 * Each cache is a Map<id, entry> where entry holds either an in-flight
 * promise (still loading) or a resolved value (loaded) — never an error.
 * Errors are NOT cached: a transient 5xx shouldn't permanently brick the
 * project page until reload. Failed fetches drop the entry entirely and
 * the next mount/retry re-fires the request.
 *
 * Invalidation: call `invalidateProjectCaches(id)` after a mutation that
 * could change the underlying data (e.g. after a domain save).
 */
type CacheEntry<T> =
  | { kind: "loading"; promise: Promise<T> }
  | { kind: "ready"; data: T };

const infoCache = new Map<string, CacheEntry<ProjectInfoData>>();
const summaryCache = new Map<string, CacheEntry<AnalyticsSummaryResponse>>();
const periodsCache = new Map<string, CacheEntry<AnalyticsPeriodResponse[]>>();

// ─── Revision store (drives live refresh on invalidation) ──────────────────
//
// Each project id has a revision counter. `invalidateProjectCaches(id)`
// bumps the counter and notifies subscribed hooks. The hooks include the
// current revision in their useEffect deps, so the bump re-runs the
// effect and fires a fresh fetch — letting currently-mounted Overview /
// Monitoring tabs update without remounting.
const revisions = new Map<string, number>();
const revisionListeners = new Map<string, Set<() => void>>();

function getRevision(id: string): number {
  return revisions.get(id) ?? 0;
}

function bumpRevision(id: string): void {
  revisions.set(id, getRevision(id) + 1);
  revisionListeners.get(id)?.forEach((cb) => cb());
}

function subscribeRevision(id: string, listener: () => void): () => void {
  let set = revisionListeners.get(id);
  if (!set) {
    set = new Set();
    revisionListeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) revisionListeners.delete(id);
  };
}

// ─── Internal generic hook ─────────────────────────────────────────────────

function useEndpoint<T>(
  id: string | null | undefined,
  cache: Map<string, CacheEntry<T>>,
  fetcher: (id: string) => Promise<T>,
): AsyncState<T> {
  // Ref tracks the LATEST id from props at any moment. Combined with
  // the `cancelled` flag, this prevents an in-flight fetch for project
  // A from writing its result onto project B's state after the user
  // navigates A→B. React's effect cleanup is supposed to fire before
  // a stale `.then` resolves, but under concurrent rendering the
  // exact ordering isn't guaranteed — the ref check is the defensive
  // belt to the cancelled-flag suspenders.
  const idRef = useRef(id);
  idRef.current = id;

  // Subscribe to this id's revision counter. When
  // invalidateProjectCaches(id) is called, the counter bumps,
  // useSyncExternalStore triggers a re-render, and the effect below
  // re-runs (because `revision` is in its deps) — firing a fresh
  // fetch so currently-mounted consumers see new data immediately.
  const revision = useSyncExternalStore(
    (cb) => (id ? subscribeRevision(id, cb) : () => {}),
    () => (id ? getRevision(id) : 0),
    () => 0,
  );

  const [state, setState] = useState<AsyncState<T>>(() => {
    if (!id) return { data: null, isLoading: false, error: null };
    const cached = cache.get(id);
    if (cached?.kind === "ready") {
      return { data: cached.data, isLoading: false, error: null };
    }
    return { data: null, isLoading: true, error: null };
  });

  useEffect(() => {
    if (!id) {
      setState({ data: null, isLoading: false, error: null });
      return;
    }

    // Cached ready → flip into resolved state and bail.
    const cached = cache.get(id);
    if (cached?.kind === "ready") {
      setState({ data: cached.data, isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    let promise: Promise<T>;
    if (cached?.kind === "loading") {
      // Already in flight from a concurrent mount — subscribe to it.
      promise = cached.promise;
    } else {
      // Cold — fire a new fetch and register it so concurrent mounts share.
      promise = fetcher(id);
      cache.set(id, { kind: "loading", promise });
    }

    promise
      .then((data) => {
        cache.set(id, { kind: "ready", data });
        // Guard: don't write A's result into B's state if id has
        // changed since the effect started. Both flags together cover
        // synchronous (cancelled) and racy (idRef mismatch) cases.
        if (cancelled || idRef.current !== id) return;
        setState({ data, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        // Errors are NOT cached — drop the entry so a future mount /
        // refresh re-fires the request. Otherwise a transient 5xx
        // permanently bricks the page until full reload.
        cache.delete(id);
        if (cancelled || idRef.current !== id) return;
        const message = err instanceof Error ? err.message : "Request failed";
        setState({ data: null, isLoading: false, error: message });
      });

    return () => {
      cancelled = true;
    };
    // `revision` is intentionally in deps: bumping it via
    // invalidateProjectCaches() retriggers the effect for already-
    // mounted consumers, fetching fresh data without a remount.
  }, [id, cache, fetcher, revision]);

  return state;
}

// ─── Fetcher functions ─────────────────────────────────────────────────────

async function fetchProjectInfo(id: string): Promise<ProjectInfoData> {
  const response = await projectsApi.getInfo(id);
  if (!response.success) {
    throw new Error(response.error || "Failed to load project info");
  }
  return response.data;
}

async function fetchSummary(id: string): Promise<AnalyticsSummaryResponse> {
  const response = await api.get<{ data: AnalyticsSummaryResponse; success?: boolean; error?: string }>(
    endpoints.analytics.summary,
    { params: { projectId: id } },
  );
  if (response.success === false || !response.data) {
    throw new Error(response.error || "Failed to load analytics summary");
  }
  return response.data;
}

async function fetchPeriods(id: string): Promise<AnalyticsPeriodResponse[]> {
  const response = await api.get<{ data: AnalyticsPeriodResponse[]; success?: boolean; error?: string }>(
    endpoints.analytics.periods,
    { params: { projectId: id } },
  );
  if (response.success === false) {
    throw new Error(response.error || "Failed to load analytics periods");
  }
  return response.data ?? [];
}

// ─── Public hooks — one per endpoint ───────────────────────────────────────

/**
 * Fetches /projects/:id/info. Owns the Infrastructure + Source & CI/CD card
 * skeletons on the overview page. `data` is `null` while loading or on error.
 *
 * To force a refetch (e.g. after a mutation), call
 * `invalidateProjectCaches(id)` and the next mount of this hook will refetch.
 */
export function useProjectInfo(id: string | null | undefined) {
  return useEndpoint(id, infoCache, fetchProjectInfo);
}

/**
 * Fetches /analytics/summary. Owns the stat-card skeleton (Server Requests
 * / Unique IPs / Avg Response / Bandwidth Out). Independent of project info.
 */
export function useAnalyticsSummary(id: string | null | undefined) {
  return useEndpoint(id, summaryCache, fetchSummary);
}

/**
 * Fetches /analytics/periods. Owns the traffic chart skeleton. Independent
 * of summary — a slow periods endpoint can't pin the stats and vice versa.
 */
export function useAnalyticsPeriods(id: string | null | undefined) {
  return useEndpoint(id, periodsCache, fetchPeriods);
}

/**
 * Composite hook — returns summary + periods combined into one
 * AnalyticsData object plus the underlying per-endpoint loading states.
 * Use this when a consumer needs both shapes together (Overview /
 * Monitoring tabs). When a consumer only needs one of stats or chart,
 * call `useAnalyticsSummary` / `useAnalyticsPeriods` directly to keep
 * skeletons tight.
 */
export function useAnalyticsData(id: string | null | undefined) {
  const summary = useAnalyticsSummary(id);
  const periods = useAnalyticsPeriods(id);
  const data = summary.data
    ? mapAnalyticsData(summary.data, periods.data ?? [], "")
    : null;
  return {
    data,
    summary: summary.data,
    periods: periods.data,
    isLoading: summary.isLoading || periods.isLoading,
    isLoadingSummary: summary.isLoading,
    isLoadingPeriods: periods.isLoading,
    error: summary.error ?? periods.error,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function mapAnalyticsData(
  summary: AnalyticsSummaryResponse,
  periods: AnalyticsPeriodResponse[],
  domain: string,
): AnalyticsData | null {
  if (summary.totalRequests <= 0 && periods.length === 0) return null;
  const firstPeriod = periods[0] ?? null;
  const lastPeriod = periods[periods.length - 1] ?? null;
  const firstRequest = firstPeriod?.from ?? summary.lastUpdated ?? new Date().toISOString();
  const lastRequest = lastPeriod?.to ?? summary.lastUpdated ?? firstRequest;
  const timeRangeHours = Math.max(
    1,
    Math.ceil((new Date(lastRequest).getTime() - new Date(firstRequest).getTime()) / 3_600_000),
  );
  const uniqueIPs = summary.uniqueVisitors;
  const totalRequests = summary.totalRequests;
  return {
    success: true,
    domain,
    summary: {
      totalRequests,
      uniqueIPs,
      uniqueRequests: totalRequests,
      totalIPs: totalRequests,
      uniqueIPsPercentage:
        totalRequests > 0 ? ((uniqueIPs / totalRequests) * 100).toFixed(1) : "0.0",
      firstRequest,
      lastRequest,
      timeRangeHours,
      avgRequestsPerHour: Math.round(totalRequests / timeRangeHours),
    },
    performance: {
      avgResponseTime: summary.avgResponseTimeMs / 1000,
      avgResponseTimeMs: summary.avgResponseTimeMs,
      totalResponseTime: summary.avgResponseTimeMs * totalRequests,
      minResponseTime: `${summary.avgResponseTimeMs.toFixed(0)}ms`,
      maxResponseTime: `${summary.avgResponseTimeMs.toFixed(0)}ms`,
    },
    bandwidth: {
      totalIn: summary.bandwidthIn,
      totalOut: summary.bandwidthOut,
      totalInFormatted: formatBytes(summary.bandwidthIn),
      totalOutFormatted: formatBytes(summary.bandwidthOut),
      avgRequestSize: totalRequests > 0 ? summary.bandwidthIn / totalRequests : 0,
      avgResponseSize: totalRequests > 0 ? summary.bandwidthOut / totalRequests : 0,
    },
    topPaths: [],
    trafficByHour: periods.map((period) => ({
      hour: new Date(period.from).getHours(),
      requests: period.requests,
    })),
    limited: false,
  };
}

// ─── Cache invalidation (exported for force-refresh patterns) ─────────────

/**
 * Drop ALL caches for an id AND notify subscribed hooks to refetch.
 * Use after a mutation that could change the data (e.g. domain save,
 * redeploy). Mounted consumers will receive fresh data on the next
 * tick — no remount required.
 */
export function invalidateProjectCaches(id: string) {
  infoCache.delete(id);
  summaryCache.delete(id);
  periodsCache.delete(id);
  bumpRevision(id);
}
