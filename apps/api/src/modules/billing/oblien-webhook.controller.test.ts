import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * End-to-end dispatch test for the Oblien webhook handler with every heavy
 * dependency (db / quota wrapper / mail / audit / notifications / env) mocked,
 * so it stays self-contained (no DB, no Oblien, no network). Verifies the
 * signature gate + that each event routes to the right side effect.
 */

const SECRET = "whsec_test_oblien";

const h = vi.hoisted(() => ({
  secret: undefined as string | undefined,
  usageUpsert: vi.fn(),
  orgFindById: vi.fn(),
  auditRecord: vi.fn(),
  notificationEmit: vi.fn(),
  sendMail: vi.fn(),
  orgRows: [{ id: "org_1" }] as Array<{ id: string }>,
  existingRows: [] as Array<{ processedAt: Date | null }>,
}));

vi.mock("../../config/env", () => ({
  env: {
    get OBLIEN_WEBHOOK_SECRET() {
      return h.secret;
    },
  },
}));
vi.mock("../../lib/mail", () => ({ sendMail: h.sendMail }));
vi.mock("../../lib/audit", () => ({ audit: { record: h.auditRecord } }));
vi.mock("../../lib/notification-dispatcher", () => ({
  notification: { emit: h.notificationEmit },
}));
vi.mock("../../lib/org-actor", () => ({
  resolveOrgOwner: async () => ({ user: { email: "owner@example.com", name: "Owner" } }),
}));
vi.mock("./billing-oblien-quota", () => ({
  fromOblienCredits: (c: number) => c * 1000,
}));
vi.mock("@repo/db", () => {
  const tx = {
    execute: async () => ({ rows: [{ acquired: true }] }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => h.existingRows }) }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  };
  return {
    db: {
      transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => h.orgRows }) }) }),
    },
    schema: {
      organization: { id: {}, oblienNamespace: {} },
      oblienWebhookEvent: { oblienEventId: {}, processedAt: {} },
    },
    repos: {
      billingUsageSnapshot: { upsert: h.usageUpsert },
      organization: { findById: h.orgFindById },
    },
    eq: () => ({}),
    sql: (..._a: unknown[]) => ({}),
    hashStringToInt: () => 1,
  };
});

// Import AFTER the mocks are registered.
import { oblienWebhook } from "./oblien-webhook.controller";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

interface JsonResult {
  obj: unknown;
  status: number;
}

function makeCtx(body: string, sig?: string) {
  return {
    req: {
      header: (n: string) => (n.toLowerCase() === "x-webhook-signature" ? sig : undefined),
      text: async () => body,
    },
    json: (obj: unknown, status = 200): JsonResult => ({ obj, status }),
  } as never;
}

beforeEach(() => {
  h.secret = SECRET;
  h.orgRows = [{ id: "org_1" }];
  h.existingRows = [];
  h.orgFindById.mockReset();
  h.usageUpsert.mockReset();
  h.auditRecord.mockReset();
  h.notificationEmit.mockReset();
  h.sendMail.mockReset();
});

describe("oblienWebhook — signature gate", () => {
  it("503 when the secret isn't configured", async () => {
    h.secret = undefined;
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(503);
  });

  it("401 on a bad signature", async () => {
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body, "wrong")))) as unknown as JsonResult;
    expect(res.status).toBe(401);
  });

  it("401 when the signature header is missing", async () => {
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, undefined))) as unknown as JsonResult;
    expect(res.status).toBe(401);
  });
});

describe("oblienWebhook — dispatch", () => {
  it("credits.usage → upserts the snapshot with credits converted to milli (×1000)", async () => {
    const body = JSON.stringify({
      event: "credits.usage",
      timestamp: "t1",
      data: {
        namespace: "os-abc",
        balance: 5,
        credits_used: 2,
        usage: { cpu_time_minutes: 120, memory_gb_minutes: 30, disk_io_gb: 1, network_gb: 0.5 },
      },
    });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.usageUpsert).toHaveBeenCalledTimes(1);
    const arg = h.usageUpsert.mock.calls[0][0];
    expect(arg.organizationId).toBe("org_1");
    expect(arg.balance).toBe(5000); // 5 Oblien credits → 5000 milli
    expect(arg.creditsUsed).toBe(2000);
    expect(arg.cpuTimeMinutes).toBe(120); // physical unit, not converted
  });

  it("credits.depleted → records audit + emits notification (Oblien owns the stop, we don't suspend)", async () => {
    h.orgFindById.mockResolvedValue({
      id: "org_1",
      subscriptionStatus: "active",
      planTierId: "pro",
      oblienNamespace: "os-abc",
    });
    const body = JSON.stringify({
      event: "credits.depleted",
      timestamp: "t1",
      data: { namespace: "os-abc" },
    });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.auditRecord).toHaveBeenCalledTimes(1);
    expect(h.notificationEmit).toHaveBeenCalledTimes(1);
  });

  it("namespace.quota.threshold → emails + emits", async () => {
    const body = JSON.stringify({
      event: "namespace.quota.threshold",
      data: { namespace: "os-abc", percent: 80, used: 8000, limit: 10000 },
    });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect(h.notificationEmit).toHaveBeenCalledTimes(1);
  });

  it("unrouted event → 200 no-op (no side effects)", async () => {
    const body = JSON.stringify({ event: "vm.stopped", data: { namespace: "os-abc" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.usageUpsert).not.toHaveBeenCalled();
    expect(h.auditRecord).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it("unknown namespace → 200 no-op", async () => {
    h.orgRows = [];
    const body = JSON.stringify({ event: "credits.usage", data: { namespace: "os-nope" } });
    const res = (await oblienWebhook(makeCtx(body, sign(body)))) as unknown as JsonResult;
    expect(res.status).toBe(200);
    expect(h.usageUpsert).not.toHaveBeenCalled();
  });
});
