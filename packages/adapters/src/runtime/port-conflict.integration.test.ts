import net from "node:net";
import { execFile } from "node:child_process";
import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../types";
import { probeListeningPort } from "./port-conflict";

/**
 * Real integration tests — no mocked executor. They open actual sockets and run
 * the real `ss` / `lsof` / `/proc/net/tcp` on this machine, so they exercise the
 * probe end-to-end the way #85 hit it in production. The mock-based unit tests
 * (`port-conflict.test.ts`) pin the parsing/tier logic deterministically; these
 * verify the shell commands actually behave.
 *
 * Skipped on Windows (no POSIX socket tools). Correct on every POSIX host: the
 * assertions ("null" for a non-listener) hold regardless of which tier resolves,
 * and they actively catch the #85 regression wherever `lsof` is the resolver
 * (macOS always; Linux when `ss` misses and `lsof` is present).
 */

/** Minimal real executor: run a command through the local shell, resolve stdout.
 *  Every probe command ends in `|| true` / `; true`, so exit code is 0. */
const shExecutor = {
  exec: (command: string, opts?: { timeout?: number }): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        { timeout: opts?.timeout ?? 5_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      );
    }),
} as unknown as CommandExecutor;

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function listenOnEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

describe.skipIf(process.platform === "win32")("probeListeningPort — real sockets", () => {
  test("detects a real listener on a bound port", async () => {
    const { server, port } = await listenOnEphemeral();
    try {
      const occ = await probeListeningPort(shExecutor, port);
      expect(occ).not.toBeNull(); // occupied
      // PID resolves via ss (root) / lsof; may be null under non-root ss. When
      // resolved, the listener is THIS test process.
      if (occ?.pid != null) expect(occ.pid).toBe(process.pid);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("does NOT report occupied for an established-but-not-listening socket (#85)", async () => {
    // Bind + accept a connection, then STOP listening while keeping the
    // established sockets alive. The port now carries ESTABLISHED sockets but no
    // LISTENER — the exact shape that fooled the unfiltered `lsof -ti tcp:PORT`.
    const { server, port } = await listenOnEphemeral();
    const accepted: net.Socket[] = [];
    server.on("connection", (s) => accepted.push(s));

    const client = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });
    await waitFor(() => accepted.length > 0);
    // Stop listening; the established connection persists. Don't await the close
    // callback — it only fires once all connections drain, and we keep one open
    // on purpose. close() drops the LISTEN socket promptly; a short beat lets the
    // kernel remove it from the socket table before we probe.
    server.close();
    await new Promise((r) => setTimeout(r, 150));

    try {
      const occ = await probeListeningPort(shExecutor, port);
      expect(occ).toBeNull(); // established-only is not a listener → free
    } finally {
      client.destroy();
      accepted.forEach((s) => s.destroy());
    }
  });

  test("returns null for a port with nothing on it", async () => {
    // Reserve then immediately release an ephemeral port so we know it's free.
    const { server, port } = await listenOnEphemeral();
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probeListeningPort(shExecutor, port)).toBeNull();
  });
});
