"use client";

/**
 * ResourcePicker — Cloudflare-style multi-select for grantable resources.
 *
 * Replaces the legacy "type a resource id" textbox with a real picker:
 *   - Switch between resource types (Project / Server / Mail server / Backup)
 *   - Inline search (client-side filter)
 *   - "All resources" toggle that emits the wildcard `*` id
 *   - Multi-select via checkbox; emits a flat list of {resourceType, resourceId, permissions}
 *
 * Server is the source of truth — the picker fetches /api/permissions/resources?type=X
 * and renders the returned `{id, label, meta?}[]`. The wildcard `*` row
 * is synthesized client-side as a convenience; the backend treats it
 * identically to a specific id at the permission resolver level.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { api, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

export type Permission = "read" | "write" | "admin";

export type ResourceType =
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit";

export interface PickerGrant {
  resourceType: ResourceType;
  /** "*" for "all of this type" OR a specific id from the catalog. */
  resourceId: string;
  permissions: Permission[];
}

interface CatalogEntry {
  id: string;
  label: string;
  meta?: Record<string, unknown>;
}

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  project: "Projects",
  server: "Servers",
  mail_server: "Mail servers",
  backup_destination: "Backup destinations",
  billing: "Billing",
  audit: "Audit log",
};

const PERMISSIONS: Permission[] = ["read", "write", "admin"];

interface ResourcePickerProps {
  /** Current selection (controlled). Caller owns the array. */
  value: PickerGrant[];
  onChange: (value: PickerGrant[]) => void;
  /** Optional: restrict to a single resource type (no type tabs shown). */
  fixedType?: ResourceType;
  /**
   * Default permissions assigned when a new resource is checked. The
   * user can still adjust per-row. Defaults to ["read"].
   */
  defaultPermissions?: Permission[];
  disabled?: boolean;
}

export function ResourcePicker({
  value,
  onChange,
  fixedType,
  defaultPermissions = ["read"],
  disabled,
}: ResourcePickerProps) {
  const { showToast } = useToast();
  const [activeType, setActiveType] = useState<ResourceType>(fixedType ?? "project");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  const loadCatalog = useCallback(async (type: ResourceType) => {
    setLoading(true);
    try {
      const res = await api.get<{ data?: CatalogEntry[] }>(
        `permissions/resources?type=${encodeURIComponent(type)}`,
      );
      setCatalog(res.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to load resources"), "error", "Picker");
      setCatalog([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadCatalog(activeType);
  }, [activeType, loadCatalog]);

  const findGrant = useCallback(
    (resourceType: ResourceType, resourceId: string): PickerGrant | undefined =>
      value.find(
        (g) => g.resourceType === resourceType && g.resourceId === resourceId,
      ),
    [value],
  );

  const setGrant = useCallback(
    (resourceType: ResourceType, resourceId: string, perms: Permission[]) => {
      const next = value.filter(
        (g) => !(g.resourceType === resourceType && g.resourceId === resourceId),
      );
      if (perms.length > 0) {
        next.push({ resourceType, resourceId, permissions: perms });
      }
      onChange(next);
    },
    [value, onChange],
  );

  const toggleResource = (resourceType: ResourceType, resourceId: string) => {
    const existing = findGrant(resourceType, resourceId);
    if (existing) {
      setGrant(resourceType, resourceId, []);
    } else {
      setGrant(resourceType, resourceId, defaultPermissions);
    }
  };

  const togglePermission = (
    resourceType: ResourceType,
    resourceId: string,
    perm: Permission,
  ) => {
    const existing = findGrant(resourceType, resourceId);
    const current = existing?.permissions ?? [];
    const next = current.includes(perm)
      ? current.filter((p) => p !== perm)
      : [...current, perm];
    setGrant(resourceType, resourceId, next);
  };

  // Wildcard (* — "All of this type") shown as the first row in every tab.
  // Stored as a normal grant with resourceId="*". Selecting it doesn't
  // disable per-resource selection — that's the caller's responsibility
  // if they want exclusive semantics.
  const filteredCatalog = useMemo(() => {
    if (!search.trim()) return catalog;
    const q = search.trim().toLowerCase();
    return catalog.filter((c) => c.label.toLowerCase().includes(q));
  }, [catalog, search]);

  const typeTabs: ResourceType[] = fixedType
    ? [fixedType]
    : ["project", "server", "mail_server", "backup_destination", "billing", "audit"];

  return (
    <div className="space-y-4">
      {/* Resource type tabs */}
      {!fixedType && (
        <div className="flex flex-wrap gap-1.5">
          {typeTabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveType(t)}
              disabled={disabled}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                activeType === t
                  ? "bg-primary/15 text-foreground border border-primary/40"
                  : "bg-muted/40 text-muted-foreground hover:text-foreground border border-transparent"
              }`}
            >
              {RESOURCE_TYPE_LABELS[t]}
              {value.filter((g) => g.resourceType === t).length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                  {value.filter((g) => g.resourceType === t).length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      {activeType !== "billing" && activeType !== "audit" && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${RESOURCE_TYPE_LABELS[activeType].toLowerCase()}...`}
            disabled={disabled || loading}
            className="w-full pl-9 pr-3 py-2 bg-card border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
      )}

      {/* Catalog list */}
      <div className="rounded-xl border border-border/50 overflow-hidden max-h-[300px] overflow-y-auto divide-y divide-border/30">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Wildcard "All" row — always at top for non-singleton types */}
            {activeType !== "billing" && activeType !== "audit" && (
              <ResourceRow
                resourceType={activeType}
                resourceId="*"
                label={`All ${RESOURCE_TYPE_LABELS[activeType].toLowerCase()}`}
                meta={{ wildcard: true }}
                grant={findGrant(activeType, "*")}
                onToggleResource={toggleResource}
                onTogglePermission={togglePermission}
                disabled={disabled}
              />
            )}
            {/* Catalog rows */}
            {filteredCatalog.length === 0 && !loading ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {search.trim()
                    ? "No resources match your search."
                    : `No ${RESOURCE_TYPE_LABELS[activeType].toLowerCase()} in this organization yet.`}
                </p>
              </div>
            ) : (
              filteredCatalog.map((entry) => (
                <ResourceRow
                  key={entry.id}
                  resourceType={activeType}
                  resourceId={entry.id}
                  label={entry.label}
                  meta={entry.meta}
                  grant={findGrant(activeType, entry.id)}
                  onToggleResource={toggleResource}
                  onTogglePermission={togglePermission}
                  disabled={disabled}
                />
              ))
            )}
          </>
        )}
      </div>

      {/* Selection summary */}
      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {value.length} resource{value.length === 1 ? "" : "s"} selected across all types.
        </p>
      )}
    </div>
  );
}

function ResourceRow({
  resourceType,
  resourceId,
  label,
  meta,
  grant,
  onToggleResource,
  onTogglePermission,
  disabled,
}: {
  resourceType: ResourceType;
  resourceId: string;
  label: string;
  meta?: Record<string, unknown>;
  grant: PickerGrant | undefined;
  onToggleResource: (rt: ResourceType, rid: string) => void;
  onTogglePermission: (rt: ResourceType, rid: string, p: Permission) => void;
  disabled?: boolean;
}) {
  const checked = !!grant;
  const isWildcard = resourceId === "*";

  return (
    <div className={`px-4 py-3 ${checked ? "bg-primary/5" : "hover:bg-muted/20"} transition-colors`}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onToggleResource(resourceType, resourceId)}
          disabled={disabled}
          className={`size-5 rounded border-2 flex items-center justify-center transition-colors shrink-0 ${
            checked
              ? "bg-primary border-primary text-primary-foreground"
              : "border-border/60 hover:border-primary/60"
          }`}
          aria-checked={checked}
          role="checkbox"
        >
          {checked && <Check className="size-3" />}
        </button>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${isWildcard ? "text-foreground/90" : "text-foreground"}`}>
            {label}
            {isWildcard && (
              <span className="ml-2 text-[10px] font-medium uppercase tracking-wider text-primary">
                wildcard
              </span>
            )}
          </p>
          {meta && Object.keys(meta).filter((k) => k !== "wildcard").length > 0 && (
            <p className="text-[11px] text-muted-foreground font-mono truncate">
              {Object.entries(meta)
                .filter(([k]) => k !== "wildcard")
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join(" · ")}
            </p>
          )}
        </div>
      </div>

      {/* Per-row permissions — only shown when the resource is checked */}
      {checked && (
        <div className="mt-2 ml-8 flex flex-wrap items-center gap-1.5">
          {PERMISSIONS.map((p) => {
            const active = grant?.permissions.includes(p) ?? false;
            return (
              <button
                key={p}
                type="button"
                onClick={() => onTogglePermission(resourceType, resourceId, p)}
                disabled={disabled}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors ${
                  active
                    ? "bg-primary/20 text-foreground border border-primary/40"
                    : "bg-muted/40 text-muted-foreground border border-transparent hover:text-foreground"
                }`}
              >
                {p}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
