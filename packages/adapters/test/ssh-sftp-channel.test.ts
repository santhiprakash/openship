import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for #34: file ops must share ONE SFTP subsystem channel
// instead of opening (and leaking) a new one per call, which exhausted the
// server's MaxSessions and took the whole connection down mid-build.

vi.mock("../src/system/ssh-client", () => {
  // Required inside the factory: vi.mock is hoisted above the top-level import,
  // so the module-scope EventEmitter binding isn't initialized yet here.
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
  }
  class FakeSftp extends EventEmitter {
    writeFile(_p: string, _c: string, _o: unknown, cb: (e: Error | null) => void) {
      queueMicrotask(() => cb(null));
    }
    readFile(_p: string, _o: unknown, cb: (e: Error | null, d: Buffer) => void) {
      queueMicrotask(() => cb(null, Buffer.from("data")));
    }
    stat(_p: string, cb: (e: Error | null) => void) {
      queueMicrotask(() => cb(null));
    }
    end() {
      this.emit("close");
    }
  }
  class FakeClient extends EventEmitter {
    exec(_cmd: string, cb: (e: Error | null, s: FakeStream) => void) {
      const s = new FakeStream();
      cb(null, s);
      queueMicrotask(() => s.emit("close", 0));
    }
    end() {
      this.emit("close");
    }
  }
  return {
    connectSshClient: vi.fn(async () => new FakeClient()),
    openSftp: vi.fn(async () => new FakeSftp()),
    openSshUnixSocket: vi.fn(),
  };
});

import { openSftp } from "../src/system/ssh-client";
import { SshExecutor } from "../src/system/ssh-executor";

const openSftpMock = vi.mocked(openSftp);

function makeExecutor() {
  return new SshExecutor({ host: "h", port: 22, username: "root", privateKey: "k" });
}

beforeEach(() => {
  openSftpMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SshExecutor SFTP channel reuse (#34)", () => {
  it("opens exactly one SFTP channel across many file ops", async () => {
    const exec = makeExecutor();
    await exec.writeFile("/tmp/a.txt", "x");
    await exec.readFile("/tmp/a.txt");
    await exec.exists("/tmp/a.txt");
    await exec.writeFile("/tmp/b.txt", "y");
    await exec.exists("/tmp/b.txt");

    expect(openSftpMock).toHaveBeenCalledTimes(1);
  });

  it("reopens the channel after it closes, but not before", async () => {
    const exec = makeExecutor();
    await exec.exists("/tmp/a.txt");
    expect(openSftpMock).toHaveBeenCalledTimes(1);

    // Simulate the channel dying (idle drop / server-side close): the cached
    // wrapper emits 'close', so the next op must open a fresh channel.
    const wrapper = (await openSftpMock.mock.results[0]!.value) as EventEmitter;
    wrapper.emit("close");

    await exec.exists("/tmp/a.txt");
    expect(openSftpMock).toHaveBeenCalledTimes(2);
  });
});
