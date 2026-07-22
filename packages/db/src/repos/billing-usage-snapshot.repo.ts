/**
 * Billing usage-snapshot repo — the sink for Oblien `credits.usage`
 * webhook deliveries. One row per org (upsert on organization_id) holding
 * the latest metered balance/usage so the dashboard renders instantly
 * without a live Oblien round-trip.
 *
 * Oblien is still the authoritative meter; this is a display cache. Credit
 * fields are stored in openship MILLI-credits (Oblien-credit ×1000); the
 * per-resource fields are raw physical units. The webhook handler does the
 * unit conversion before calling `upsert` — this repo is unit-agnostic.
 */

import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { billingUsageSnapshot } from "../schema/billing";

export interface UsageSnapshotInput {
  organizationId: string;
  balance?: number | null;
  creditsUsed?: number | null;
  cpuTimeMinutes?: number | null;
  memoryGbMinutes?: number | null;
  diskIoGb?: number | null;
  networkGb?: number | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

export interface UsageSnapshot {
  organizationId: string;
  balance: number | null;
  creditsUsed: number | null;
  cpuTimeMinutes: number | null;
  memoryGbMinutes: number | null;
  diskIoGb: number | null;
  networkGb: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  updatedAt: Date;
}

export function createBillingUsageSnapshotRepo(db: Database) {
  return {
    /** Upsert the latest snapshot for an org. Overwrites the single row. */
    async upsert(input: UsageSnapshotInput): Promise<void> {
      const values = {
        organizationId: input.organizationId,
        balance: input.balance ?? null,
        creditsUsed: input.creditsUsed ?? null,
        cpuTimeMinutes: input.cpuTimeMinutes ?? null,
        memoryGbMinutes: input.memoryGbMinutes ?? null,
        diskIoGb: input.diskIoGb ?? null,
        networkGb: input.networkGb ?? null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        updatedAt: new Date(),
      };
      await db
        .insert(billingUsageSnapshot)
        .values(values)
        .onConflictDoUpdate({
          target: billingUsageSnapshot.organizationId,
          set: {
            balance: values.balance,
            creditsUsed: values.creditsUsed,
            cpuTimeMinutes: values.cpuTimeMinutes,
            memoryGbMinutes: values.memoryGbMinutes,
            diskIoGb: values.diskIoGb,
            networkGb: values.networkGb,
            periodStart: values.periodStart,
            periodEnd: values.periodEnd,
            updatedAt: values.updatedAt,
          },
        });
    },

    /** Read an org's latest snapshot, or null if none ingested yet. */
    async findByOrg(organizationId: string): Promise<UsageSnapshot | null> {
      const [row] = await db
        .select()
        .from(billingUsageSnapshot)
        .where(eq(billingUsageSnapshot.organizationId, organizationId))
        .limit(1);
      return row ?? null;
    },
  };
}
