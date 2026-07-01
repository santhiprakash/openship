"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, Plus, Trash2, Copy, Check, Loader2, ShieldCheck } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { tokensApi, getApiErrorMessage, type AccessToken } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

const EXPIRY_OPTIONS = [
  { label: "No expiry", days: 0 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function PersonalAccessTokens() {
  const { showToast } = useToast();
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [expiryDays, setExpiryDays] = useState(0);
  // The one-time plaintext token, shown until dismissed.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await tokensApi.list();
      setTokens(res?.data ?? []);
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to load tokens"), "error", "Access tokens");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim()) {
      showToast("Give the token a name", "error", "Access tokens");
      return;
    }
    setCreating(true);
    try {
      const res = await tokensApi.create({
        name: name.trim(),
        readOnly,
        ...(expiryDays > 0 ? { expiresInDays: expiryDays } : {}),
      });
      setNewToken(res.data.token);
      setShowForm(false);
      setName("");
      setReadOnly(false);
      setExpiryDays(0);
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to create token"), "error", "Access tokens");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string, tokenName: string) => {
    try {
      await tokensApi.revoke(id);
      showToast(`Revoked "${tokenName}"`, "success", "Access tokens");
      await refresh();
    } catch (err) {
      showToast(getApiErrorMessage(err, "Failed to revoke token"), "error", "Access tokens");
    }
  };

  const copyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  const active = tokens.filter((t) => !t.revokedAt);

  return (
    <SettingsSection
      icon={KeyRound}
      title="Personal Access Tokens"
      description="Bearer tokens for the API, CLI, and MCP clients. Each token acts as you."
    >
      {/* What a token can actually do — set expectations honestly */}
      <div className="mb-4 flex gap-2.5 rounded-xl border border-border/50 bg-muted/30 p-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="text-xs leading-relaxed text-muted-foreground">
          Each token <span className="font-medium text-foreground">acts as you</span> — it carries your role&apos;s
          permissions in this organization. <span className="font-medium text-foreground">Read-only</span> blocks all
          writes. Need a narrower, resource-scoped token? Invite a teammate with a limited role (Member / Restricted)
          in{" "}
          <Link
            href="/settings?tab=team"
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
          >
            Team
          </Link>{" "}
          and have them create it.
        </div>
      </div>

      {/* One-time reveal after create */}
      {newToken && (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
          <p className="text-sm font-medium text-foreground mb-1">Copy your new token now</p>
          <p className="text-xs text-muted-foreground mb-3">
            This is the only time it&apos;s shown. Store it somewhere safe.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {newToken}
            </code>
            <button
              onClick={copyToken}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setNewToken(null)}
            className="mt-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Done
          </button>
        </div>
      )}

      {/* Create form */}
      {showForm ? (
        <div className="mb-4 rounded-xl border border-border/50 p-4 space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. MCP client)"
            className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
                className="size-4 rounded border-border/60"
              />
              Read-only
            </label>
            <select
              value={expiryDays}
              onChange={(e) => setExpiryDays(Number(e.target.value))}
              className="px-3 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create token
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="mb-4 inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-lg hover:bg-muted transition-colors"
        >
          <Plus className="size-4" />
          New token
        </button>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No active tokens.</p>
      ) : (
        <div className="divide-y divide-border/50">
          {active.map((t) => (
            <div key={t.id} className="flex items-center gap-3 py-3">
              <KeyRound className="size-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{t.name}</p>
                  {t.readOnly && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <ShieldCheck className="size-3" /> read-only
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  {t.tokenPrefix}…
                  <span className="font-sans"> · last used {fmtDate(t.lastUsedAt)} · expires {fmtDate(t.expiresAt)}</span>
                </p>
              </div>
              <button
                onClick={() => void handleRevoke(t.id, t.name)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-red-600 hover:border-red-500/30 transition-colors"
              >
                <Trash2 className="size-3.5" />
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
