"use client";

/**
 * NotificationsTab — full notification preferences UI.
 *
 * Three sections, each in its own card:
 *
 *   1. Channels — list / create / delete the user's delivery channels
 *      (email, webhook, slack, in-app). Channel configs are surfaced
 *      via a small inline form that switches shape per kind.
 *
 *   2. Subscriptions — a category × channel matrix. Each row is a
 *      stable category; each column is one of the user's channels.
 *      Cells are checkboxes that upsert/disable subscriptions.
 *
 *   3. Org defaults — admin-only section to set per-category
 *      defaults that apply when a NEW member joins this org.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Mail, Webhook, MessageSquare, Smartphone, Plus, Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import {
  notificationsApi,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationSubscription,
  type NotificationDefault,
  type ChannelKind,
} from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

const CHANNEL_ICONS: Record<ChannelKind, React.ElementType> = {
  email: Mail,
  webhook: Webhook,
  slack: MessageSquare,
  in_app: Smartphone,
};

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  email: "Email",
  webhook: "Webhook",
  slack: "Slack",
  in_app: "In-app",
};

export function NotificationsTab() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<NotificationCategory[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [subscriptions, setSubscriptions] = useState<NotificationSubscription[]>([]);
  const [defaults, setDefaults] = useState<NotificationDefault[]>([]);
  const [role, setRole] = useState<string | null>(null);

  const isAdmin = role === "owner" || role === "admin";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, ch, subs, defs] = await Promise.all([
        notificationsApi.listCategories(),
        notificationsApi.listChannels(),
        notificationsApi.listSubscriptions(),
        notificationsApi.listDefaults().catch(() => ({ defaults: [] })),
      ]);
      setCategories(cats.categories);
      setChannels(ch.channels);
      setSubscriptions(subs.subscriptions);
      setDefaults(defs.defaults);
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", "Notifications");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Resolve caller's role in active org so we can gate the defaults UI.
  useEffect(() => {
    (async () => {
      try {
        const result = await (authClient as unknown as {
          organization: {
            getFullOrganization: () => Promise<{
              data?: { members?: Array<{ userId: string; role: string }>; id: string } | null;
            }>;
          };
        }).organization.getFullOrganization();
        const session = await authClient.getSession();
        const userId = session.data?.user?.id;
        const me = result.data?.members?.find((m) => m.userId === userId);
        setRole(me?.role ?? null);
      } catch {
        setRole(null);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ChannelsCard channels={channels} onChange={refresh} />
      <SubscriptionsCard
        categories={categories}
        channels={channels}
        subscriptions={subscriptions}
        onChange={refresh}
      />
      {isAdmin && (
        <OrgDefaultsCard
          categories={categories}
          defaults={defaults}
          onChange={refresh}
        />
      )}
    </div>
  );
}

/* ─── Channels card ──────────────────────────────────────────────── */

function ChannelsCard({
  channels,
  onChange,
}: {
  channels: NotificationChannel[];
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [showForm, setShowForm] = useState(false);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this channel? Subscriptions using it will stop.")) return;
    try {
      await notificationsApi.deleteChannel(id);
      showToast("Channel removed", "success", "Notifications");
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", "Notifications");
    }
  };

  return (
    <SettingsSection
      icon={Bell}
      title="Delivery channels"
      description="Where your notifications go. Verified channels are reachable; unverified ones are skipped."
    >
      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No channels yet. Add one to start receiving notifications.</p>
      ) : (
        <ul className="divide-y divide-border/40">
          {channels.map((ch) => {
            const Icon = CHANNEL_ICONS[ch.kind];
            return (
              <li key={ch.id} className="flex items-center gap-3 py-3">
                <div className="size-9 rounded-lg bg-muted flex items-center justify-center">
                  <Icon className="size-4 text-foreground" strokeWidth={1.7} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{ch.label}</p>
                  <p className="text-xs text-muted-foreground truncate">{describeChannel(ch)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {ch.verified ? (
                    <span className="text-[11px] uppercase tracking-wide text-emerald-500">Verified</span>
                  ) : ch.kind !== "in_app" ? (
                    <span className="text-[11px] uppercase tracking-wide text-amber-500">Unverified</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleDelete(ch.id)}
                    className="p-1.5 rounded-md hover:bg-foreground/[0.04] text-muted-foreground hover:text-destructive transition"
                    aria-label="Delete channel"
                  >
                    <Trash2 className="size-4" strokeWidth={1.7} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4">
        {showForm ? (
          <NewChannelForm
            onCancel={() => setShowForm(false)}
            onSaved={async () => {
              setShowForm(false);
              await onChange();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/50 text-sm hover:bg-foreground/[0.04] transition"
          >
            <Plus className="size-4" strokeWidth={1.7} />
            Add channel
          </button>
        )}
      </div>
    </SettingsSection>
  );
}

function describeChannel(ch: NotificationChannel): string {
  switch (ch.kind) {
    case "email":
      return String((ch.config as { address?: string }).address ?? "");
    case "webhook":
      return String((ch.config as { url?: string }).url ?? "");
    case "slack":
      return String((ch.config as { channelName?: string | null }).channelName ?? "Slack webhook");
    case "in_app":
      return "Dashboard bell icon";
    default:
      return "";
  }
}

function NewChannelForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const [kind, setKind] = useState<ChannelKind>("email");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [url, setUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim()) {
      showToast("Label is required", "error", "Notifications");
      return;
    }
    let config: Record<string, unknown> = {};
    if (kind === "email") config = { address: address.trim() };
    else if (kind === "webhook") config = { url: url.trim() };
    else if (kind === "slack") config = { webhookUrl: webhookUrl.trim() };

    setBusy(true);
    try {
      await notificationsApi.createChannel({ kind, label: label.trim(), config });
      showToast("Channel added", "success", "Notifications");
      await onSaved();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", "Notifications");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-border/50 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ChannelKind)}
          className="bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        >
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
          <option value="slack">Slack</option>
          <option value="in_app">In-app</option>
        </select>
        <input
          type="text"
          placeholder="Label (e.g. On-call email)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      {kind === "email" && (
        <input
          type="email"
          placeholder="you@example.com"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {kind === "webhook" && (
        <input
          type="url"
          placeholder="https://example.com/openship-hook"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}
      {kind === "slack" && (
        <input
          type="url"
          placeholder="https://hooks.slack.com/services/..."
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm"
        />
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-foreground text-background text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
        >
          {busy ? "Adding…" : "Add channel"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-foreground/[0.04] transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ─── Subscriptions card ─────────────────────────────────────────── */

function SubscriptionsCard({
  categories,
  channels,
  subscriptions,
  onChange,
}: {
  categories: NotificationCategory[];
  channels: NotificationChannel[];
  subscriptions: NotificationSubscription[];
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Look-up index: subscriptions[catId][channelId] → enabled?
  const subIndex = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const s of subscriptions) m.set(`${s.category}::${s.channelId}`, s.enabled);
    return m;
  }, [subscriptions]);

  const toggle = async (category: string, channelId: string, enabled: boolean) => {
    const key = `${category}::${channelId}`;
    setBusyKey(key);
    try {
      await notificationsApi.upsertSubscription({ category, channelId, enabled });
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", "Notifications");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <SettingsSection
      icon={Bell}
      title="What to be notified about"
      description="Pick which events go to which channel. Each cell is one subscription."
    >
      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a channel first to subscribe to events.</p>
      ) : (
        <div className="overflow-x-auto -mx-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-medium">Event</th>
                {channels.map((ch) => (
                  <th key={ch.id} className="px-3 py-2 font-medium text-center min-w-[100px]">
                    {ch.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <tr key={cat.id} className="border-t border-border/30">
                  <td className="px-5 py-3 align-top">
                    <p className="font-medium text-foreground">{cat.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{cat.description}</p>
                  </td>
                  {channels.map((ch) => {
                    const key = `${cat.id}::${ch.id}`;
                    const enabled = subIndex.get(key) ?? false;
                    const isBusy = busyKey === key;
                    return (
                      <td key={ch.id} className="px-3 py-3 text-center align-top">
                        <input
                          type="checkbox"
                          disabled={isBusy}
                          checked={enabled}
                          onChange={(e) => toggle(cat.id, ch.id, e.target.checked)}
                          className="size-4 rounded border-border/50 cursor-pointer accent-foreground"
                          aria-label={`${cat.label} via ${ch.label}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}

/* ─── Org defaults card (admin) ─────────────────────────────────── */

function OrgDefaultsCard({
  categories,
  defaults,
  onChange,
}: {
  categories: NotificationCategory[];
  defaults: NotificationDefault[];
  onChange: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [busyCat, setBusyCat] = useState<string | null>(null);

  const defIndex = useMemo(() => {
    const m = new Map<string, NotificationDefault>();
    for (const d of defaults) m.set(d.category, d);
    return m;
  }, [defaults]);

  const set = async (category: string, enabled: boolean, kind: ChannelKind) => {
    setBusyCat(category);
    try {
      await notificationsApi.upsertDefault({
        category,
        defaultEnabled: enabled,
        defaultChannelKind: kind,
      });
      await onChange();
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", "Notifications");
    } finally {
      setBusyCat(null);
    }
  };

  return (
    <SettingsSection
      icon={Bell}
      title="Organization defaults"
      description="Defaults applied when a new member joins this organization. Members can override per-channel."
    >
      <div className="space-y-2">
        {categories.map((cat) => {
          const def = defIndex.get(cat.id);
          const enabled = def?.defaultEnabled ?? cat.defaultEnabled;
          const kind = (def?.defaultChannelKind ?? "email") as ChannelKind;
          const isBusy = busyCat === cat.id;
          return (
            <div
              key={cat.id}
              className="flex items-center gap-3 py-2 border-b border-border/30 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{cat.label}</p>
                <p className="text-xs text-muted-foreground">{cat.description}</p>
              </div>
              <select
                value={kind}
                disabled={isBusy}
                onChange={(e) => set(cat.id, enabled, e.target.value as ChannelKind)}
                className="bg-background border border-border/50 rounded-lg px-2 py-1.5 text-sm"
              >
                <option value="email">Email</option>
                <option value="webhook">Webhook</option>
                <option value="slack">Slack</option>
                <option value="in_app">In-app</option>
              </select>
              <input
                type="checkbox"
                disabled={isBusy}
                checked={enabled}
                onChange={(e) => set(cat.id, e.target.checked, kind)}
                className="size-4 rounded border-border/50 cursor-pointer accent-foreground"
              />
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

// CHANNEL_LABELS exported in case other modules need it.
export { CHANNEL_LABELS };
