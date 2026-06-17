"use client";

/**
 * Audit log page — filterable feed of who-did-what for the active org.
 *
 * Backed by GET /api/audit (admin-only). Supports filtering by:
 *   - event type        (deployment.succeeded, member.invited, etc.)
 *   - actor             (specific user in the org)
 *   - resource          (specific project / deployment / server)
 *   - free-text search  (client-side, on the loaded page)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Filter, User as UserIcon } from "lucide-react";
import { api } from "@/lib/api";

interface AuditEvent {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

const EVENT_TYPE_OPTIONS = [
  { value: "", label: "All events" },
  { value: "deployment.succeeded", label: "Deploy succeeded" },
  { value: "deployment.failed", label: "Deploy failed" },
  { value: "deployment.canceled", label: "Deploy canceled" },
  { value: "member.invited", label: "Member invited" },
  { value: "member.joined", label: "Member joined" },
  { value: "member.removed", label: "Member removed" },
  { value: "project.created", label: "Project created" },
  { value: "project.deleted", label: "Project deleted" },
  { value: "server.added", label: "Server added" },
  { value: "domain.added", label: "Domain added" },
  { value: "settings.updated", label: "Settings updated" },
];

function eventLabel(type: string): string {
  return type.replace(/\./g, " ").replace(/_/g, " ");
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function AuditTab() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [eventType, setEventType] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: AuditEvent[]; total: number }>("audit", {
        params: { page, perPage: 50, eventType: eventType || undefined },
      });
      setEvents(res.data);
      setTotal(res.total);
    } catch (err) {
      console.error("Failed to load audit events", err);
      setEvents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [eventType, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return events;
    const q = search.toLowerCase();
    return events.filter(
      (e) =>
        e.eventType.toLowerCase().includes(q) ||
        e.resourceId?.toLowerCase().includes(q) ||
        e.actorUserId?.toLowerCase().includes(q),
    );
  }, [events, search]);

  return (
    <div className="space-y-6">
      <div>
        <h2
          className="text-xl font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          Audit log
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every change in this organization, who made it, and when.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events, actors, resources..."
            className="w-full pl-10 pr-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <select
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value);
              setPage(1);
            }}
            className="pl-10 pr-8 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          >
            {EVENT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {search ? "No events match your search." : "No events yet."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {filtered.map((e) => (
              <div key={e.id} className="px-5 py-3.5 flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-muted/60 flex items-center justify-center shrink-0">
                  <UserIcon className="size-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {eventLabel(e.eventType)}
                    </span>
                    {e.resourceId && (
                      <span className="text-xs text-muted-foreground font-mono truncate">
                        {e.resourceId.slice(0, 16)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {e.actorUserId ? `Actor ${e.actorUserId.slice(0, 8)}` : "System"}
                    {e.ipAddress && ` - ${e.ipAddress}`}
                  </p>
                </div>
                <time className="text-xs text-muted-foreground shrink-0">
                  {relativeTime(e.createdAt)}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>

      {total > 50 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {(page - 1) * 50 + 1}-{Math.min(page * 50, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="px-3 py-1.5 rounded-lg border border-border/50 hover:bg-muted/40 transition-colors disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 50 >= total || loading}
              className="px-3 py-1.5 rounded-lg border border-border/50 hover:bg-muted/40 transition-colors disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
