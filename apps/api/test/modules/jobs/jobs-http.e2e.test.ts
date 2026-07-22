/**
 * Jobs HTTP E2E — real router + real auth + real permission + real DB.
 *
 * Covers: auth rejection, custom-job create/list/get/delete, the write-side
 * server authorization, system-job immutability, and FIX #1 — command-job
 * config + run output are not readable across orgs (only server-admins of the
 * job's target servers; builtins stay member-visible).
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { makeApp, seedOwner, seedServer, resetJobs, installFakeRunner, req, db, schema, repos } from "./_harness";

const app = makeApp();

beforeAll(() => {
  installFakeRunner();
});
beforeEach(async () => {
  await resetJobs();
});

describe("jobs HTTP — auth + CRUD", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await req(app, "GET", "/")).status).toBe(401);
    expect((await req(app, "POST", "/", { body: { label: "x", command: "true" } })).status).toBe(401);
  });

  it("owner creates a custom command job; it persists and is listed + readable", async () => {
    const o = await seedOwner();
    const server = await seedServer(o.orgId);
    const create = await req(app, "POST", "/", {
      auth: o.auth,
      body: { label: "deploy", command: "echo hi", serverIds: [server], scheduleType: "manual" },
    });
    expect(create.status).toBe(201);
    const key: string = create.body.data.key;
    expect(key).toMatch(/^custom:/);

    // persisted for real
    const row = await repos.job.findByKey(key);
    expect(row?.actionType).toBe("command");
    expect((row?.actionConfig as { command: string }).command).toBe("echo hi");

    // listed + individually readable by the owner
    const list = await req(app, "GET", "/", { auth: o.auth });
    expect(list.body.data.some((j: { key: string }) => j.key === key)).toBe(true);
    expect((await req(app, "GET", `/${key}`, { auth: o.auth })).status).toBe(200);
  });

  it("denies creating a command job pointed at a server outside the caller's org", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const foreignServer = await seedServer(b.orgId);
    const res = await req(app, "POST", "/", {
      auth: a.auth,
      body: { label: "evil", command: "id", serverIds: [foreignServer], scheduleType: "manual" },
    });
    expect(res.status).toBe(404); // isServerInOrg=false → "Server not found"
    // nothing was created
    const list = await req(app, "GET", "/", { auth: a.auth });
    expect(list.body.data.length).toBe(0);
  });

  it("custom jobs are deletable; system jobs are not", async () => {
    const o = await seedOwner();
    const server = await seedServer(o.orgId);
    const key: string = (
      await req(app, "POST", "/", {
        auth: o.auth,
        body: { label: "tmp", command: "true", serverIds: [server], scheduleType: "manual" },
      })
    ).body.data.key;
    expect((await req(app, "DELETE", `/${key}`, { auth: o.auth })).status).toBe(200);
    expect(await repos.job.findByKey(key)).toBeNull();

    await seedSystemJob("test:builtin-del");
    expect((await req(app, "DELETE", "/test:builtin-del", { auth: o.auth })).status).toBeGreaterThanOrEqual(400);
    expect(await repos.job.findByKey("test:builtin-del")).not.toBeNull();
  });
});

describe("jobs HTTP — fix #1: cross-org read isolation", () => {
  it("a command job's config + run output are not readable across orgs", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    const serverA = await seedServer(a.orgId);
    const key: string = (
      await req(app, "POST", "/", {
        auth: a.auth,
        body: {
          label: "secret-job",
          command: "cat /etc/shadow",
          serverIds: [serverA],
          env: { TOKEN: "hunter2" },
          scheduleType: "manual",
        },
      })
    ).body.data.key;

    // a run with sensitive captured output
    const run = await repos.jobRun.start({ jobId: key, kind: "custom", trigger: "manual", serverId: serverA });
    await repos.jobRun.finish(run.id, {
      status: "success",
      durationMs: 1,
      summary: { exitCode: 0 },
      output: "root:$6$deadbeef",
    });

    // owner A (server admin of the target) sees everything
    expect((await req(app, "GET", `/${key}`, { auth: a.auth })).status).toBe(200);
    expect((await req(app, "GET", `/runs/${run.id}`, { auth: a.auth })).body.data.output).toContain("root:");
    expect((await req(app, "GET", `/${key}/runs`, { auth: a.auth })).status).toBe(200);
    expect((await req(app, "GET", "/", { auth: a.auth })).body.data.some((j: { key: string }) => j.key === key)).toBe(true);

    // owner B (different org, no access to serverA) is denied — 404, not existence-leaking
    expect((await req(app, "GET", `/${key}`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "GET", `/runs/${run.id}`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "GET", `/${key}/runs`, { auth: b.auth })).status).toBe(404);
    expect((await req(app, "GET", "/", { auth: b.auth })).body.data.some((j: { key: string }) => j.key === key)).toBe(false);
  });

  it("builtin/system jobs stay readable by any member (no server gate)", async () => {
    const a = await seedOwner();
    const b = await seedOwner();
    await seedSystemJob("test:builtin-read");
    for (const who of [a, b]) {
      expect((await req(app, "GET", "/test:builtin-read", { auth: who.auth })).status).toBe(200);
      expect(
        (await req(app, "GET", "/", { auth: who.auth })).body.data.some((j: { key: string }) => j.key === "test:builtin-read"),
      ).toBe(true);
    }
  });
});

/** Seed a builtin/system job row directly (reconcileJobs seeds these at boot). */
async function seedSystemJob(key: string) {
  const now = new Date();
  await db.insert(schema.job).values({
    id: `job_${key.replace(/[^a-z0-9]/gi, "_")}`,
    key,
    kind: "system",
    label: "System job",
    cronExpression: "0 3 * * *",
    scheduleType: "recurring",
    enabled: true,
    actionType: "builtin",
    dependsOn: [],
    triggerEvents: [],
    createdAt: now,
    updatedAt: now,
  });
}
