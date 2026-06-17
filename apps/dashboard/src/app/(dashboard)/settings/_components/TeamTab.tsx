"use client";

/**
 * Members page — list, invite, manage roles, remove members in the
 * active organization.
 *
 * Backed by Better Auth's organization plugin endpoints:
 *   GET    /api/auth/organization/list-members
 *   POST   /api/auth/organization/invite-member
 *   POST   /api/auth/organization/update-member-role
 *   POST   /api/auth/organization/remove-member
 *
 * All accessible via the authClient.organization.* methods.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Mail,
  Plus,
  Trash2,
  UserPlus,
  X,
  Building2,
  Sparkles,
  Users as UsersIcon,
  Shield,
  Lock,
} from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import { api, getApiErrorMessage } from "@/lib/api";
import { ResourcePicker, type PickerGrant } from "@/components/permissions/ResourcePicker";

type MemberRole = "owner" | "admin" | "member" | "restricted";

type ResourceType =
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit";

type Permission = "read" | "write" | "admin";

interface ResourceGrant {
  id: string;
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  permissions: Permission[];
}

interface MemberRow {
  id: string;
  userId: string;
  role: MemberRole;
  createdAt: string;
  user: { id: string; name: string; email: string; image?: string | null };
}

interface InvitationRow {
  id: string;
  email: string;
  role: MemberRole;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Better Auth's React client wraps `authClient.organization` in a Proxy
 * whose property accesses return fresh references. Putting that proxy
 * (or any value derived from it) into a `useEffect` / `useCallback`
 * dependency array explodes into an infinite render loop:
 *
 *   render → new ref → useCallback rebuilds → useEffect re-fires
 *   → fetch → setState → render → ...
 *
 * Resolving the client ONCE at module load avoids the trap. Imports of
 * this module evaluate before any React tree mounts, so the captured
 * reference is stable for the lifetime of the page.
 */
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: MemberRow[] } }>;
    listInvitations: () => Promise<{ data?: InvitationRow[] }>;
    inviteMember: (opts: { email: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
    removeMember: (opts: { memberIdOrEmail: string }) => Promise<{ error?: { message?: string } }>;
    updateMemberRole: (opts: { memberId: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
    cancelInvitation: (opts: { invitationId: string }) => Promise<{ error?: { message?: string } }>;
  };
}).organization;

export function TeamTab() {
  const { data: session } = useSession();
  const { showToast } = useToast();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("member");
  const [inviting, setInviting] = useState(false);

  // Resource grants panel state
  const [selectedMember, setSelectedMember] = useState<MemberRow | null>(null);
  const [grants, setGrants] = useState<ResourceGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [addGrantOpen, setAddGrantOpen] = useState(false);
  // Catalog-picker-driven grants in the "Add grant" panel. The picker
  // handles type/id/permissions internally so we only track the resulting
  // selection array here.
  const [pickerGrants, setPickerGrants] = useState<PickerGrant[]>([]);
  const [savingGrant, setSavingGrant] = useState(false);

  // Invite-modal extras: pending grants picked when role = restricted.
  const [invitePickerGrants, setInvitePickerGrants] = useState<PickerGrant[]>([]);

  // Org-meta: drives personal-vs-team UX. Personal workspaces (auto-
  // created on signup) hide the invite UI; clicking "Create team org"
  // spawns a brand-new is_team=true org with the same owner.
  const [orgMeta, setOrgMeta] = useState<{ isTeam: boolean; memberCount: number } | null>(null);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, iRes, metaRes] = await Promise.all([
        orgClient.listMembers(),
        orgClient.listInvitations(),
        // org-meta drives the personal-vs-team UX. The backend ensures
        // a row exists for every org, so this always resolves.
        api.get<{ data: { isTeam: boolean; memberCount: number } }>(
          "permissions/org-meta",
        ).catch(() => ({ data: { isTeam: false, memberCount: 0 } })),
      ]);
      setMembers(mRes.data?.members ?? []);
      setInvitations(iRes.data ?? []);
      setOrgMeta(metaRes.data);
    } catch (err) {
      console.error("Failed to load members", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCreateTeam = async () => {
    const name = newTeamName.trim();
    if (!name) {
      showToast("Team name is required", "error", "Team");
      return;
    }
    setCreatingTeam(true);
    try {
      const res = await api.post<{ data: { id: string; name: string } }>(
        "permissions/create-team-org",
        { name },
      );
      const newOrgId = res.data?.id;
      if (!newOrgId) throw new Error("No org id returned");
      showToast(`Team "${name}" created — switching now…`, "success", "Team");
      setCreateTeamOpen(false);
      setNewTeamName("");
      // Switch the active org to the new one via Better Auth, then reload.
      try {
        const setActive = (
          authClient as unknown as {
            organization: {
              setActive: (opts: { organizationId: string }) => Promise<unknown>;
            };
          }
        ).organization.setActive;
        await setActive({ organizationId: newOrgId });
      } catch {
        /* fall through — page reload picks up the new org */
      }
      // Force a reload so every context (sidebar, header) picks up the
      // new active org cleanly.
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to create team"), "error", "Team");
    } finally {
      setCreatingTeam(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      // For role=restricted with inline grants, use invite-with-grants
      // so the grants land in pending storage and get materialized on
      // accept. For other roles, fall back to Better Auth's standard
      // inviteMember (no grants needed — they have org-wide access by
      // role definition).
      if (inviteRole === "restricted" && invitePickerGrants.length > 0) {
        await api.post("permissions/invite-with-grants", {
          email: inviteEmail.trim(),
          role: inviteRole,
          grants: invitePickerGrants,
        });
      } else {
        const res = await orgClient.inviteMember({
          email: inviteEmail.trim(),
          role: inviteRole,
        });
        if (res.error) {
          showToast(res.error.message ?? "Failed to send invite", "error", "Invitation");
          return;
        }
      }
      showToast(`Invitation sent to ${inviteEmail}`, "success", "Invitation");
      setInviteEmail("");
      setInviteRole("member");
      setInvitePickerGrants([]);
      setInviteOpen(false);
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to send invite"), "error", "Invitation");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (memberId: string, role: MemberRole) => {
    const res = await orgClient.updateMemberRole({ memberId, role });
    if (res.error) {
      showToast(res.error.message ?? "Failed to update role", "error", "Members");
      return;
    }
    await refresh();
  };

  const handleRemove = async (memberIdOrEmail: string) => {
    if (!confirm("Remove this member from the organization?")) return;
    const res = await orgClient.removeMember({ memberIdOrEmail });
    if (res.error) {
      showToast(res.error.message ?? "Failed to remove", "error", "Members");
      return;
    }
    await refresh();
  };

  const handleCancelInvite = async (invitationId: string) => {
    const res = await orgClient.cancelInvitation({ invitationId });
    if (res.error) {
      showToast(res.error.message ?? "Failed to cancel", "error", "Invitations");
      return;
    }
    await refresh();
  };

  const loadGrants = useCallback(async (userId: string) => {
    setGrantsLoading(true);
    try {
      const res = await api.get<{ grants?: ResourceGrant[] } | ResourceGrant[]>(
        "permissions/grants",
        { params: { userId } },
      );
      const list = Array.isArray(res) ? res : (res?.grants ?? []);
      setGrants(list);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to load grants"), "error", "Permissions");
      setGrants([]);
    } finally {
      setGrantsLoading(false);
    }
  }, [showToast]);

  const openMemberPanel = (m: MemberRow) => {
    if (m.role === "owner") return;
    setSelectedMember(m);
    setAddGrantOpen(false);
    setPickerGrants([]);
    void loadGrants(m.userId);
  };

  const closeMemberPanel = () => {
    setSelectedMember(null);
    setGrants([]);
    setAddGrantOpen(false);
    setPickerGrants([]);
  };

  const handleAddGrant = async () => {
    if (!selectedMember) return;
    if (pickerGrants.length === 0) {
      showToast("Pick at least one resource", "error", "Permissions");
      return;
    }
    setSavingGrant(true);
    try {
      // ResourcePicker emits one row per (resourceType, resourceId).
      // Persist them sequentially — backend upserts; partial failure
      // surfaces the offending row.
      for (const g of pickerGrants) {
        if (g.permissions.length === 0) continue;
        await api.post("permissions/grants", {
          userId: selectedMember.userId,
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          permissions: g.permissions,
        });
      }
      showToast(
        `${pickerGrants.length} grant${pickerGrants.length === 1 ? "" : "s"} added`,
        "success",
        "Permissions",
      );
      setAddGrantOpen(false);
      setPickerGrants([]);
      await loadGrants(selectedMember.userId);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to add grant"), "error", "Permissions");
    } finally {
      setSavingGrant(false);
    }
  };

  const handleRevokeGrant = async (grantId: string) => {
    if (!selectedMember) return;
    if (!confirm("Revoke this grant?")) return;
    try {
      await api.delete(`permissions/grants/${grantId}`);
      showToast("Grant revoked", "success", "Permissions");
      await loadGrants(selectedMember.userId);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to revoke grant"), "error", "Permissions");
    }
  };

  const myMembership = members.find((m) => m.userId === session?.user?.id);
  const isOwner = myMembership?.role === "owner";
  const isAdminOrOwner = myMembership?.role === "owner" || myMembership?.role === "admin";

  // Tri-state org kind: loading | personal | team. Render the invite
  // button ONLY when team is confirmed; render the "Create team" banner
  // ONLY when personal is confirmed. Anything else (initial null, fetch
  // failure) shows nothing — better than flashing a button that the
  // server would reject with "you are not allowed to invite".
  const orgKind: "loading" | "personal" | "team" =
    orgMeta === null ? "loading" : orgMeta.isTeam ? "team" : "personal";
  const isTeamOrg = orgKind === "team";
  const isPersonalOrg = orgKind === "personal";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            className="text-xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            Team
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isPersonalOrg
              ? "This is your personal workspace. Create a team organization to invite collaborators."
              : "People with access to this organization's projects, deployments, and servers."}
          </p>
        </div>
        {isAdminOrOwner && isTeamOrg && (
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="size-4" />
            Invite member
          </button>
        )}
      </div>

      {/* Personal-workspace banner — Cloudflare-style "create a team
          account to invite people" CTA. Only the owner of the personal
          workspace sees this (admins of a team org won't). */}
      {isPersonalOrg && isOwner && (
        <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/5 to-transparent p-5 flex items-start gap-4">
          <div className="size-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <Building2 className="size-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              Create a team organization
              <Sparkles className="size-3.5 text-primary" />
            </h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Personal workspaces are for solo use. To invite teammates,
              create a separate team organization — your personal projects
              and team projects stay isolated.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateTeamOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
          >
            <Plus className="size-3.5" />
            Create team
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Active members */}
          <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border/50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Active members ({members.length})
              </h2>
            </div>
            <div className="divide-y divide-border/40">
              {members.map((m) => {
                const clickable = m.role !== "owner";
                return (
                  <div
                    key={m.id}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => openMemberPanel(m) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openMemberPanel(m);
                            }
                          }
                        : undefined
                    }
                    className={`px-5 py-4 flex items-center gap-4 ${
                      clickable ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-foreground">
                      {(m.user.name || m.user.email).slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {m.user.name || m.user.email}
                        {m.userId === session?.user?.id && (
                          <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{m.user.email}</p>
                    </div>
                    {isOwner && m.userId !== session?.user?.id ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.id, e.target.value as MemberRole)}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs rounded-lg border border-border/50 bg-card px-2 py-1.5 text-foreground"
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="restricted">Restricted</option>
                      </select>
                    ) : (
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {m.role}
                      </span>
                    )}
                    {isAdminOrOwner && m.userId !== session?.user?.id && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemove(m.id);
                        }}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Remove member"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border/50">
                <h2 className="text-sm font-semibold text-foreground">
                  Pending invitations ({invitations.filter((i) => i.status === "pending").length})
                </h2>
              </div>
              <div className="divide-y divide-border/40">
                {invitations
                  .filter((i) => i.status === "pending")
                  .map((inv) => (
                    <div key={inv.id} className="px-5 py-4 flex items-center gap-4">
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="size-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          Invited as {inv.role} - expires{" "}
                          {new Date(inv.expiresAt).toLocaleDateString()}
                        </p>
                      </div>
                      {isAdminOrOwner && (
                        <button
                          type="button"
                          onClick={() => handleCancelInvite(inv.id)}
                          className="text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Resource grants panel */}
      {selectedMember && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
          onClick={closeMemberPanel}
        >
          <div
            className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-border/50 bg-card p-6 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-foreground shrink-0">
                  {(selectedMember.user.name || selectedMember.user.email).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-foreground truncate">
                    {selectedMember.user.name || selectedMember.user.email}
                  </h3>
                  <p className="text-xs text-muted-foreground truncate">
                    {selectedMember.user.email}
                  </p>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mt-1">
                    {selectedMember.role}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeMemberPanel}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                title="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="border-t border-border/50 pt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">Resource access</h4>
                {isAdminOrOwner && !addGrantOpen && (
                  <button
                    type="button"
                    onClick={() => setAddGrantOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Plus className="size-3.5" />
                    Add grant
                  </button>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Grants only apply to members with role = restricted. Members with
                owner/admin/member role have org-wide access by default.
              </p>

              {grantsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : grants.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center">
                  <p className="text-sm text-muted-foreground">No resource grants yet.</p>
                </div>
              ) : (
                <div className="rounded-xl border border-border/50 divide-y divide-border/40 overflow-hidden">
                  {grants.map((g) => (
                    <div
                      key={g.id}
                      className="px-4 py-3 flex items-center gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground mr-2">
                            {g.resourceType}
                          </span>
                          {g.resourceId === "*" ? (
                            <span className="text-muted-foreground">*</span>
                          ) : (
                            <span className="font-mono text-xs">{g.resourceId}</span>
                          )}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {g.permissions.map((p) => (
                            <span
                              key={p}
                              className="inline-flex items-center px-2 py-0.5 rounded-md bg-muted text-[10px] font-medium uppercase tracking-wider text-foreground/80"
                            >
                              {p}
                            </span>
                          ))}
                        </div>
                      </div>
                      {isAdminOrOwner && (
                        <button
                          type="button"
                          onClick={() => handleRevokeGrant(g.id)}
                          className="text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {addGrantOpen && (
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4 space-y-3">
                  {/* Catalog-driven picker. Lists Projects / Servers /
                      Mail servers / Backup destinations + a wildcard "All"
                      row. Per-resource permission chips inside the picker. */}
                  <ResourcePicker
                    value={pickerGrants}
                    onChange={setPickerGrants}
                    defaultPermissions={["read"]}
                    disabled={savingGrant}
                  />

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setAddGrantOpen(false);
                        setPickerGrants([]);
                      }}
                      disabled={savingGrant}
                      className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleAddGrant}
                      disabled={savingGrant || pickerGrants.length === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-xl text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {savingGrant && <Loader2 className="size-3.5 animate-spin" />}
                      Save {pickerGrants.length > 0 ? `${pickerGrants.length} grant${pickerGrants.length === 1 ? "" : "s"}` : "grant"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Invite modal — two-pane layout: left = invite form (email + role
          cards stacked vertically), right = ResourcePicker that appears
          only when role=restricted. Modal width animates from compact
          (max-w-lg) to wide (max-w-4xl) when the right pane is needed. */}
      {inviteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
          onClick={() => !inviting && setInviteOpen(false)}
        >
          <div
            className={`w-full max-h-[85vh] overflow-hidden rounded-2xl border border-border/50 bg-card transition-[max-width] duration-300 ease-out ${
              inviteRole === "restricted" ? "max-w-4xl" : "max-w-lg"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col md:flex-row max-h-[85vh]">
              {/* ── Left pane: email + role cards ──────────────────── */}
              <div
                className={`flex flex-col p-6 space-y-5 overflow-y-auto ${
                  inviteRole === "restricted"
                    ? "md:w-[420px] md:shrink-0 md:border-r md:border-border/50"
                    : "w-full"
                }`}
              >
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Invite a member</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    We'll email them a link to join this organization.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground block">Email</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="teammate@example.com"
                    disabled={inviting}
                    className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground block">Role</label>
                  <div className="space-y-2">
                    <RoleCard
                      icon={UsersIcon}
                      title="Member"
                      description="Read + write to all resources in this organization."
                      selected={inviteRole === "member"}
                      disabled={inviting}
                      onClick={() => {
                        setInviteRole("member");
                        setInvitePickerGrants([]);
                      }}
                    />
                    <RoleCard
                      icon={Shield}
                      title="Admin"
                      description="Everything Member can do, plus manage members + billing."
                      selected={inviteRole === "admin"}
                      disabled={inviting}
                      onClick={() => {
                        setInviteRole("admin");
                        setInvitePickerGrants([]);
                      }}
                    />
                    <RoleCard
                      icon={Lock}
                      title="Restricted"
                      description="No default access — pick exactly which resources to unlock."
                      selected={inviteRole === "restricted"}
                      disabled={inviting}
                      onClick={() => setInviteRole("restricted")}
                      badge={
                        inviteRole === "restricted" && invitePickerGrants.length > 0
                          ? `${invitePickerGrants.length} grant${invitePickerGrants.length === 1 ? "" : "s"}`
                          : undefined
                      }
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 mt-auto">
                  <button
                    type="button"
                    onClick={() => setInviteOpen(false)}
                    disabled={inviting}
                    className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleInvite}
                    disabled={inviting || !inviteEmail.trim()}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {inviting && <Loader2 className="size-4 animate-spin" />}
                    Send invite
                  </button>
                </div>
              </div>

              {/* ── Right pane: resource picker — only when Restricted ── */}
              {inviteRole === "restricted" && (
                <div className="flex-1 flex flex-col p-6 space-y-4 overflow-y-auto bg-muted/[0.04] border-t md:border-t-0 border-border/50">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      Initial resource access
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      Restricted members start with no access. Pick which
                      resources this invite will unlock once accepted —
                      you can grant more later from the member's row.
                    </p>
                  </div>
                  {/* The picker selection is sent to /invite-with-grants
                      on Send, and materialized as resource_grant rows when
                      the invitee accepts (see accept-invite/[id]/page.tsx). */}
                  <ResourcePicker
                    value={invitePickerGrants}
                    onChange={setInvitePickerGrants}
                    defaultPermissions={["read"]}
                    disabled={inviting}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Team org modal — Cloudflare-style separate account
          creation. Spawns a fresh org with is_team=true; user becomes
          owner. After creation we setActive() to it and reload so the
          whole app picks up the new active org. */}
      {createTeamOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
          onClick={() => !creatingTeam && setCreateTeamOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="size-9 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
                <Building2 className="size-4 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Create team organization</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Your personal workspace stays untouched. The team org has
                  its own projects, servers, and invited members.
                </p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">Team name</label>
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTeamName.trim()) {
                    void handleCreateTeam();
                  }
                }}
                placeholder="Acme Inc"
                autoFocus
                disabled={creatingTeam}
                className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateTeamOpen(false)}
                disabled={creatingTeam}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateTeam}
                disabled={creatingTeam || !newTeamName.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {creatingTeam && <Loader2 className="size-4 animate-spin" />}
                Create team
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── RoleCard ────────────────────────────────────────────────────── */

/**
 * Vertically-stackable selectable card for picking an org role. Three of
 * these replace the old <select> dropdown so the trade-offs of each role
 * are visible upfront — without that, operators (rightly) miss that
 * Restricted is where the resource picker lives.
 */
function RoleCard({
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onClick,
  badge,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full text-left flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-all disabled:opacity-50 ${
        selected
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/50 bg-muted/[0.05] hover:bg-muted/15 hover:border-border"
      }`}
    >
      <div
        className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${
          selected ? "bg-primary/15 text-primary" : "bg-muted/40 text-muted-foreground"
        }`}
      >
        <Icon className="size-4" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {badge && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-primary/15 text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          {description}
        </p>
      </div>
      <div
        className={`size-4 rounded-full border-2 shrink-0 mt-0.5 transition-colors ${
          selected ? "border-primary bg-primary" : "border-border/60"
        }`}
        aria-hidden
      >
        {selected && (
          <div className="size-1.5 bg-background rounded-full m-auto mt-[3px]" />
        )}
      </div>
    </button>
  );
}
