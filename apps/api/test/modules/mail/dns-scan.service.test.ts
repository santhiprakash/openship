import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

const dns = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  resolveMx: vi.fn(),
  resolveTxt: vi.fn(),
  reverse: vi.fn(),
}));

vi.mock("node:dns/promises", () => dns);

const state = {
  version: 1,
  serverId: "srv_test",
  domain: "example.com",
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  finishedAt: null,
  completedSteps: {},
  secrets: {},
  dnsAcknowledged: true,
  ptrAcknowledged: true,
  resumeStep: null,
  errorMessage: null,
  dnsRecords: {
    spf: {
      type: "TXT",
      name: "example.com",
      value: "v=spf1 mx -all",
      required: true,
    },
  },
};

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (exec: unknown) => unknown) => fn({}),
  },
}));

vi.mock("../../../src/modules/mail/mail-state", () => ({
  readState: async () => state,
}));

import { scanDns } from "../../../src/modules/mail/admin/dns-scan.service";

describe("scanDns SPF checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dns.resolveTxt.mockResolvedValue([["v=spf1 mx -all"]]);
  });

  test("fails when no SPF record exists", async () => {
    dns.resolveTxt.mockResolvedValue([["google-site-verification=abc"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "fail",
      }),
    );
  });

  test("passes when the single SPF record authorizes mx", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 mx -all"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "pass",
      }),
    );
  });

  test("warns when the single SPF record does not authorize mx", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 include:example.net -all"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "warn",
      }),
    );
  });

  test("fails when a domain publishes multiple SPF records", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 mx -all"], ["v=spf1 include:example.net -all"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "fail",
      }),
    );
    expect(result.checks.find((c) => c.key === "spf")?.message).toMatch(/multiple SPF records/i);
  });

  test("fails when duplicate SPF records differ only by casing", async () => {
    dns.resolveTxt.mockResolvedValue([
      ["V=SPF1 mx -all"],
      ["v=spf1 include:example.net -all"],
      ["v=spf1 ip4:203.0.113.10 -all"],
    ]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "fail",
      }),
    );
    expect(result.checks.find((c) => c.key === "spf")?.message).toMatch(/multiple SPF records/i);
  });
});
