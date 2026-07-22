import { connect as netConnect } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openSystemSshReverseTunnel } from "../src/system/reverse-tunnel";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Write a self-executable node stub standing in for `ssh`. It logs argv (one
 *  JSON line per call) and, for `-O forward`, prints `printPort` to stdout. */
async function makeStubSsh(printPort: string): Promise<{ sshBin: string; logPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "stub-ssh-"));
  dirs.push(dir);
  const logPath = join(dir, "calls.log");
  const sshBin = join(dir, "stub-ssh.js");
  await writeFile(
    sshBin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');",
      `if (args.includes('forward')) { process.stdout.write(${JSON.stringify(printPort)} + '\\n'); }`,
      "process.exit(0);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { sshBin, logPath };
}

async function readCalls(logPath: string): Promise<string[][]> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  return raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
}

describe("openSystemSshReverseTunnel", () => {
  it("parses the allocated port, wires the listener, and cancels on close", async () => {
    const { sshBin, logPath } = await makeStubSsh("54321");
    const received: Duplex[] = [];

    const tunnel = await openSystemSshReverseTunnel({
      baseArgs: ["-p", "22", "-o", "ControlPath=/tmp/x.sock"],
      target: "root@host",
      env: { ...process.env, STUB_LOG: logPath },
      sshBin,
      onConnection: (s) => {
        received.push(s);
        s.end();
      },
    });

    expect(tunnel.port).toBe(54321);

    const calls = await readCalls(logPath);
    const forward = calls.find((c) => c.includes("forward"));
    expect(forward).toBeDefined();
    // dynamic remote port (0), forwarding back to the local listener
    const spec = forward![forward!.indexOf("-R") + 1];
    expect(spec).toMatch(/^127\.0\.0\.1:0:127\.0\.0\.1:\d+$/);
    const localPort = Number(spec.split(":")[3]);
    expect(localPort).toBeGreaterThan(0);

    // A connection to the local listener (what the ssh -R forward delivers)
    // must reach onConnection.
    await new Promise<void>((resolve, reject) => {
      const c = netConnect(localPort, "127.0.0.1", () => {
        c.end();
        resolve();
      });
      c.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThan(0);

    await tunnel.close();
    const cancel = (await readCalls(logPath)).find((c) => c.includes("cancel"));
    expect(cancel).toBeDefined();
    expect(cancel).toContain(`127.0.0.1:54321:127.0.0.1:${localPort}`);

    // Listener freed: connecting again fails.
    await expect(
      new Promise((resolve, reject) => {
        const c = netConnect(localPort, "127.0.0.1", () => {
          c.end();
          resolve(null);
        });
        c.on("error", reject);
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects (and frees the listener) when ssh returns no port", async () => {
    const { sshBin, logPath } = await makeStubSsh(""); // prints nothing
    await expect(
      openSystemSshReverseTunnel({
        baseArgs: ["-p", "22"],
        target: "root@host",
        env: { ...process.env, STUB_LOG: logPath },
        sshBin,
        onConnection: () => {},
      }),
    ).rejects.toThrow(/no port/i);
  });
});
