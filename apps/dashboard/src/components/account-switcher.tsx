"use client";

/**
 * Account switcher — popover that lists all organizations the user
 * belongs to, lets them switch active org or create a new one.
 *
 * Wired to Better Auth's organization plugin:
 *   list()         → authClient.organization.list()
 *   setActive(id)  → authClient.organization.setActive({ organizationId })
 *   create({ name, slug })
 *
 * Switching the active org reloads the dashboard so resource lists
 * re-fetch under the new scope. Better Auth handles the session
 * activeOrganizationId update server-side.
 */

import { useEffect, useState, useRef } from "react";
import { Check, ChevronsUpDown, Plus, Building2, Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import { setActiveOrganizationId } from "@/lib/api/client";

interface Org {
  id: string;
  name: string;
  slug?: string | null;
  logo?: string | null;
}

/**
 * Module-level singleton — Better Auth's React client wraps the
 * organization plugin in a Proxy whose property accesses return a fresh
 * reference, so capturing it inside the component body and using it as
 * a useEffect dep creates an infinite render loop. See TeamTab for the
 * full explanation.
 */
const orgClient = (authClient as unknown as {
  organization: {
    list: () => Promise<{ data?: Org[] }>;
    setActive: (opts: { organizationId: string }) => Promise<{ error?: { message?: string } }>;
    create: (opts: { name: string; slug: string }) => Promise<{ data?: Org; error?: { message?: string } }>;
    getFullOrganization: () => Promise<{ data?: { id: string } | null }>;
  };
}).organization;

export function AccountSwitcher() {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [listRes, activeRes] = await Promise.all([
        orgClient.list(),
        orgClient.getFullOrganization().catch(() => ({ data: null as Org | null })),
      ]);
      if (cancelled) return;
      setOrgs(listRes.data ?? []);
      const activeId = (activeRes.data as { id: string } | null)?.id ?? null;
      setActiveId(activeId);
      // Sync the API client's X-Organization-Id header slot so every
      // subsequent api.get/post sends the right org id.
      setActiveOrganizationId(activeId);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  const handleSwitch = async (orgId: string) => {
    if (orgId === activeId) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    try {
      const res = await orgClient.setActive({ organizationId: orgId });
      if (res.error) {
        showToast(res.error.message ?? "Failed to switch", "error", "Organization");
        return;
      }
      // Update both: session cookie default (via setActive above) AND the
      // X-Organization-Id header slot used by all subsequent api.* calls.
      // The reload then re-fetches every resource list under the new org.
      setActiveOrganizationId(orgId);
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const slug = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const res = await orgClient.create({ name: newName.trim(), slug });
      if (res.error || !res.data) {
        showToast(res.error?.message ?? "Failed to create", "error", "Organization");
        return;
      }
      // Auto-switch to the new org — update both session and header slot.
      await orgClient.setActive({ organizationId: res.data.id });
      setActiveOrganizationId(res.data.id);
      window.location.reload();
    } finally {
      setCreating(false);
    }
  };

  const activeOrg = orgs.find((o) => o.id === activeId) ?? orgs[0] ?? null;

  if (!activeOrg) return null;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-muted/40 transition-colors text-left"
      >
        <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <Building2 className="size-3.5 text-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{activeOrg.name}</p>
          {orgs.length > 1 && (
            <p className="text-xs text-muted-foreground truncate">{orgs.length} workspaces</p>
          )}
        </div>
        <ChevronsUpDown className="size-3.5 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1.5 rounded-xl border border-border/50 bg-card shadow-lg z-50 overflow-hidden">
          <div className="py-1 max-h-72 overflow-y-auto">
            {orgs.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => handleSwitch(o.id)}
                disabled={switching}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted/40 transition-colors text-left disabled:opacity-50"
              >
                <div className="w-6 h-6 rounded-md bg-muted flex items-center justify-center shrink-0">
                  <Building2 className="size-3 text-muted-foreground" />
                </div>
                <span className="flex-1 text-sm text-foreground truncate">{o.name}</span>
                {o.id === activeId && <Check className="size-3.5 text-primary" />}
                {switching && o.id !== activeId && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-border/40 py-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-sm text-foreground"
            >
              <Plus className="size-3.5 text-muted-foreground" />
              New workspace
            </button>
          </div>
        </div>
      )}

      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
          onClick={() => !creating && setCreateOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-lg font-semibold text-foreground">Create a workspace</h3>
              <p className="text-sm text-muted-foreground mt-1">
                A separate org for projects, deployments, servers, and members.
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Acme Corp"
                disabled={creating}
                className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {creating && <Loader2 className="size-4 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
