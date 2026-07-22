/**
 * Notification dispatcher.
 *
 * The fan-out point from "an event happened" to "N notification_delivery
 * rows enqueued, each pointing at one user × one channel". The actual
 * sending is done by per-channel workers in lib/notification-workers/.
 *
 * Call site:
 *   notification.emit({
 *     organizationId,
 *     eventType: "deployment.failed",
 *     resourceType: "deployment",
 *     resourceId: dep.id,
 *     auditEventId: optionalRowFromAudit,
 *     payload: { branch, errorMessage, ... },
 *   });
 *
 * Behavior:
 *   1. Map eventType → category. Unknown types are dropped silently.
 *   2. Look up every enabled subscription for (org, category).
 *   3. For each subscription, resolve the channel row.
 *   4. Skip if channel disabled / unverified.
 *   5. Insert one notification_delivery row per (user, channel) in
 *      "queued" status. The worker loop picks them up.
 *
 * Fire-and-forget by default — dispatch errors are logged but never
 * thrown to the caller. The audit_event already captured the original
 * event; failed notifications shouldn't break the action that caused
 * them.
 */

import { repos } from "@repo/db";
import { categoryForEventType } from "./notification-categories";
import { fireJobTriggers } from "../modules/jobs/job-events";

export interface NotificationEmitInput {
  organizationId: string;
  /** The audit_event.event_type. Used for category mapping + the
   *  payload-snapshot subject line. */
  eventType: string;
  /** Optional id of the audit_event row that caused this. Lets the
   *  Settings UI cross-link a notification to its source event. */
  auditEventId?: string;
  resourceType?: string;
  resourceId?: string;
  /** Free-form payload — channel workers render this with their own
   *  template (subject + body for email, JSON for webhook, etc.). */
  payload?: Record<string, unknown>;
}

async function dispatch(input: NotificationEmitInput): Promise<void> {
  const category = categoryForEventType(input.eventType);
  if (!category) return; // not a notifiable event — drop silently

  const subs = await repos.notificationSubscription
    .listEnabledForDispatch(input.organizationId, category)
    .catch(() => []);

  if (subs.length === 0) return;

  for (const sub of subs) {
    try {
      const channel = await repos.notificationChannel.findById(sub.channelId);
      if (!channel || !channel.enabled || !channel.verified) continue;

      await repos.notificationDelivery.create({
        userId: sub.userId,
        organizationId: input.organizationId,
        auditEventId: input.auditEventId ?? null,
        category,
        channelId: channel.id,
        channelKind: channel.kind,
        status: "queued",
        attempts: 0,
        payload: {
          eventType: input.eventType,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          ...input.payload,
        },
      });
    } catch (err) {
      console.error(
        `[notification] failed to enqueue for sub=${sub.id} category=${category}:`,
        err,
      );
    }
  }
}

export const notification = {
  /**
   * Fire-and-forget. Resolves immediately; the dispatch + delivery
   * inserts run in the background. Errors are swallowed (logged).
   * Use this for everything — there's no reason to await delivery
   * enqueuing in the request path.
   */
  emit(input: NotificationEmitInput): void {
    // Custom jobs can also be TRIGGERED by an event (cheap no-op when unarmed).
    fireJobTriggers(input.eventType);
    void dispatch(input).catch((err) => {
      console.error(
        `[notification] dispatch failed for eventType=${input.eventType}:`,
        err,
      );
    });
  },

  /**
   * Synchronous variant for unit tests + critical paths where you want
   * to surface a dispatch failure (e.g., security alerts where missing
   * the notification is itself an incident).
   */
  async emitSync(input: NotificationEmitInput): Promise<void> {
    fireJobTriggers(input.eventType);
    await dispatch(input);
  },
};
