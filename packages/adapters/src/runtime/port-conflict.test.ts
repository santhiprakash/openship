import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../types";
import { probeListeningPort } from "./port-conflict";

/** Fake host: maps a command (by substring) to canned stdout; unmatched → "". */
function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  const exec = async (cmd: string): Promise<string> => {
    for (const [needle, out] of rules) {
      if (cmd.includes(needle)) return out;
    }
    return "";
  };
  return { exec } as unknown as CommandExecutor;
}

/** A single /proc/net/tcp data row in LISTEN state (0A) on the given port. */
function procListenRow(port: number): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return `  1: 00000000:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345 1 0000 100 0 0 10 0`;
}

/**
 * The port is only touched by an OUTBOUND connection — nothing is LISTENing.
 * An unfiltered `lsof -ti tcp:PORT` returns that PID; a `-sTCP:LISTEN`-filtered
 * lsof returns nothing, and procfs shows no LISTEN row. Regression for #85.
 */
function outboundOnlyHost(port: number, outboundPid: number): CommandExecutor {
  const exec = async (cmd: string): Promise<string> => {
    if (cmd.includes(`lsof -ti tcp:${port}`)) {
      return cmd.includes("-sTCP:LISTEN") ? "" : `${outboundPid}\n`;
    }
    return ""; // procfs (no LISTEN row) + ps/cgroup follow-ups: nothing.
  };
  return { exec } as unknown as CommandExecutor;
}

describe("probeListeningPort — LISTEN-state filter (regression #85)", () => {
  // Behavioral: an outbound-only host must probe as free (null). Fails on the
  // unfiltered probe (lsof returns the outbound PID); passes once filtered.
  test("returns null when only an outbound connection uses the port", async () => {
    expect(await probeListeningPort(outboundOnlyHost(443, 4242), 443)).toBeNull();
  });

  // Command-shape: the emitted lsof fallback must carry the LISTEN state filter.
  test("emitted lsof fallback carries -sTCP:LISTEN", async () => {
    const seen: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        seen.push(cmd);
        return "";
      },
    } as unknown as CommandExecutor;

    await probeListeningPort(executor, 443);

    const probe = seen.find((c) => c.includes("lsof -ti tcp:443"));
    expect(probe).toBeDefined();
    expect(probe).toContain("-sTCP:LISTEN");
  });
});

describe("probeListeningPort — tiered fallback", () => {
  test("tier 1: ss resolves the owner PID and command", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["sport = :443", 'LISTEN 0 511 *:443 *:* users:(("nginx",pid=555,fd=8))'],
        ["-p 555 -o args=", "nginx: master process /usr/sbin/nginx"],
      ]),
      443,
    );
    expect(occ?.pid).toBe(555);
    expect(occ?.command).toContain("nginx");
  });

  test("tier 2: lsof fallback resolves the PID when ss is empty", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["lsof -ti tcp:443", "777\n"],
        ["-p 777 -o args=", "python3 -m http.server 443"],
      ]),
      443,
    );
    expect(occ?.pid).toBe(777);
    expect(occ?.command).toContain("python3");
  });

  test("tier 3: procfs reports occupancy with unknown owner when ss+lsof are absent", async () => {
    const occ = await probeListeningPort(
      makeExecutor([["/proc/net/tcp", procListenRow(443)]]),
      443,
    );
    expect(occ).not.toBeNull();
    expect(occ?.pid).toBeNull();
    expect(occ?.command).toBe("unknown listener");
  });

  test("non-root ss (LISTEN line without a PID) still reports occupancy via procfs", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["sport = :443", "LISTEN 0 511 *:443 *:*"], // no users:((pid=...)) without privilege
        ["/proc/net/tcp", procListenRow(443)],
      ]),
      443,
    );
    expect(occ?.pid).toBeNull();
    expect(occ?.command).toBe("unknown listener");
  });

  test("free port: no tool and no procfs row → null", async () => {
    expect(await probeListeningPort(makeExecutor([]), 443)).toBeNull();
  });

  // SO_REUSEPORT: lsof prints one PID per line. The old `^(\d+)$` full-string
  // regex matched none of them → false "free"; the per-line regex takes the first.
  test("multiple listener PIDs (SO_REUSEPORT) resolves the first, not free", async () => {
    const occ = await probeListeningPort(
      makeExecutor([
        ["lsof -ti tcp:8080", "1001\n1002\n1003"],
        ["-p 1001 -o args=", "envoy -c /etc/envoy.yaml"],
      ]),
      8080,
    );
    expect(occ?.pid).toBe(1001);
    expect(occ?.command).toContain("envoy");
  });
});
