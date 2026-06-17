/**
 * Audit emitter — fire-and-forget for non-critical events, sync for
 * security-sensitive events.
 *
 * Two entry points:
 *   - `audit.record(...)`        synchronous write, blocks the request
 *                                until the DB insert resolves. Use for
 *                                auth, member, billing, security events
 *                                where losing the audit row is a real
 *                                forensic gap.
 *   - `audit.recordAsync(...)`   queues the insert without blocking the
 *                                request. Best for high-volume events
 *                                (deployments, settings) where adding
 *                                30ms to every action isn't acceptable.
 *
 * Both paths swallow errors — a failed audit insert should never break
 * the action the user performed. Failures emit a console.error but the
 * caller's request continues.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";

export interface AuditContext {
  organizationId: string;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditEventInput {
  eventType: string;
  resourceType?: string | null;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
}

async function write(ctx: AuditContext, event: AuditEventInput): Promise<void> {
  try {
    await repos.auditEvent.create({
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId ?? null,
      eventType: event.eventType,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      before: (event.before ?? null) as never,
      after: (event.after ?? null) as never,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    console.error("[audit] failed to record event", event.eventType, err);
  }
}

export const audit = {
  /**
   * Synchronous write. Awaits the DB insert. Use for security-critical
   * events where we cannot lose the row (auth, member, billing, etc.).
   */
  async record(ctx: AuditContext, event: AuditEventInput): Promise<void> {
    return write(ctx, event);
  },

  /**
   * Fire-and-forget. Resolves immediately; the write happens in the
   * background. Errors are logged but never thrown to the caller. Use
   * for high-volume events (deployments, settings, project mutations).
   */
  recordAsync(ctx: AuditContext, event: AuditEventInput): void {
    void write(ctx, event);
  },
};

export function auditContextFrom(
  c: Context,
  organizationId: string,
  actorUserId?: string | null,
): AuditContext {
  return {
    organizationId,
    actorUserId: actorUserId ?? null,
    ipAddress: c.var.clientIp,
    userAgent: c.req.header("user-agent") ?? null,
  };
}
