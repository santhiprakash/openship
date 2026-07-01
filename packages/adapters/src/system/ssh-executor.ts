import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { Transform } from "node:stream";

import { getTarCreateEnv } from "../archive";
import type {
  CommandExecutor,
  LogEntry,
  ShellOptions,
  ShellSession,
  SshConfig,
} from "../types";
import { logEntry, sq } from "./local-shell";
import {
  canUseRemoteRsync,
  transferRemoteDirectoryWithRsync,
  transferRemoteDirectoryWithTar,
} from "./remote-transfer";
import type { Client as SshClient, SFTPWrapper } from "ssh2";
import type { Readable, Duplex } from "node:stream";
import { connectSshClient, openSftp, openSshUnixSocket, type StreamLocalCapableClient } from "./ssh-client";
import { safeErrorMessage } from "@repo/core";

/** Clamp a window dimension to a sane range to avoid garbage values
 *  reaching ssh2.Client.shell() / channel.setWindow(). */
function clampWindow(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Runs commands on a remote server via SSH.
 * File operations use SFTP.
 */
export class SshExecutor implements CommandExecutor {
  private client: SshClient | null = null;
  private connecting: Promise<SshClient> | null = null;
  private readonly config: SshConfig;
  /** Reverse-forward handlers keyed by the remote bound port (see reverseForward). */
  private readonly reverseHandlers = new Map<number, (stream: Duplex) => void>();
  /** The client the single 'tcp connection' dispatcher is attached to (re-attached on reconnect). */
  private reverseListenerClient: SshClient | null = null;

  constructor(config: SshConfig) {
    if (!config.privateKey && !config.sshAgent && !config.password) {
      throw new Error("SSH requires one of privateKey, sshAgent, or password.");
    }
    this.config = config;
  }

  private async connect(): Promise<SshClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = await connectSshClient(this.config);

      const resetClient = () => {
        if (this.client === client) {
          this.client = null;
        }
      };

      client.on("close", resetClient);
      client.on("end", resetClient);
      client.on("error", resetClient);

      this.client = client;
      this.connecting = null;
      return client;
    })();

    return this.connecting;
  }

  private async sftp(): Promise<SFTPWrapper> {
    const client = await this.connect();
    return openSftp(client);
  }

  /**
   * Force-close the current connection so the next call reconnects.
   */
  private resetConnection(): void {
    if (this.client) {
      try { this.client.end(); } catch {}
      this.client = null;
    }
    this.connecting = null;
  }

  /** Returns true if the error is an SSH channel-open failure. */
  private static isChannelError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("channel open failure") || msg.includes("open failed");
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<string> {
    try {
      return await this._exec(command, opts);
    } catch (err) {
      if (SshExecutor.isChannelError(err)) {
        this.resetConnection();
        return this._exec(command, opts);
      }
      throw err;
    }
  }

  /** Prefix applied to every SSH command - keeps dpkg non-interactive. */
  private static readonly ENV_PREFIX =
    'export DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew && ';

  private async _exec(command: string, opts?: { timeout?: number }): Promise<string> {
    const client = await this.connect();
    const timeout = opts?.timeout ?? 30_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
      }, timeout);

      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Exit code ${code}`));
          } else {
            resolve(stdout.trim());
          }
        });
      });
    });
  }

  streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    return this._streamExec(command, onLog).catch((err) => {
      if (SshExecutor.isChannelError(err)) {
        this.resetConnection();
        return this._streamExec(command, onLog);
      }
      throw err;
    });
  }

  private async _streamExec(
    command: string,
    onLog: (log: LogEntry) => void,
  ): Promise<{ code: number; output: string }> {
    const client = await this.connect();

    return new Promise((resolve, reject) => {
      client.exec(SshExecutor.ENV_PREFIX + command, (err, stream) => {
        if (err) return reject(err);

        // Raw passthrough (see LocalExecutor.streamExec): forward the untouched
        // byte stream as rawData so the client's xterm renders "\r"/ANSI
        // natively — progress lines repaint in place instead of new lines.
        const chunks: string[] = [];

        const onChunk = (data: Buffer, level: LogEntry["level"]) => {
          const text = data.toString();
          if (!text) return;
          chunks.push(text);
          onLog(logEntry(text, level, data.toString("base64")));
        };

        stream.on("data", (data: Buffer) => onChunk(data, "info"));
        stream.stderr.on("data", (data: Buffer) => onChunk(data, "warn"));

        stream.on("close", (code: number) => {
          resolve({ code: code ?? 1, output: chunks.join("") });
        });
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = dirname(path);
    try {
      await this.exec(`mkdir -p ${sq(dir)}`);
    } catch {
      // Best effort
    }

    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.writeFile(path, content, { encoding: "utf-8" }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async readFile(path: string): Promise<string> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(path, { encoding: "utf-8" }, (err, data) => {
        if (err) reject(err);
        else resolve(data.toString());
      });
    });
  }

  async exists(path: string): Promise<boolean> {
    const sftp = await this.sftp();
    return new Promise((resolve) => {
      sftp.stat(path, (err) => {
        resolve(!err);
      });
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.exec(`mkdir -p ${sq(path)}`);
  }

  async rm(path: string): Promise<void> {
    try {
      await this.exec(`rm -rf ${sq(path)}`);
    } catch {
      // Already gone
    }
  }

  rawExec(command: string): Promise<{
    stdout: Readable;
    stderr: Readable;
    onClose: Promise<number>;
    kill: () => void;
  }> {
    return (async () => {
      const client = await this.connect();
      return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) return reject(err);
          const onClose = new Promise<number>((res) => {
            stream.on("close", (code: number) => res(code ?? 1));
          });
          resolve({
            stdout: stream,
            stderr: stream.stderr,
            onClose,
            kill: () => { try { stream.close(); } catch {} },
          });
        });
      });
    })();
  }

  /**
   * Open an interactive PTY shell on the remote host. The returned
   * ShellSession wraps an ssh2 ClientChannel: writes go to stdin,
   * stdout/stderr emit on the readable streams, setWindow forwards to
   * channel.setWindow, close ends the channel. Lifetime is bound to the
   * channel - the underlying ssh2.Client stays cached by sshManager, so
   * callers must wrap with `sshManager.retain(serverId)` / `release()`
   * to avoid the 5-minute idle drop on the parent connection.
   */
  async openShell(opts?: ShellOptions): Promise<ShellSession> {
    const client = await this.connect();
    const cols = clampWindow(opts?.cols, 80, 1, 1000);
    const rows = clampWindow(opts?.rows, 24, 1, 500);
    const term = opts?.term || "xterm-256color";

    const channel = await new Promise<import("ssh2").ClientChannel>(
      (resolve, reject) => {
        client.shell(
          { term, cols, rows, width: 0, height: 0, modes: {} },
          (err, ch) => (err ? reject(err) : resolve(ch)),
        );
      },
    );

    const closeListeners: Array<(code: number | null, signal?: string) => void> = [];
    let closed = false;
    const fireClose = (code: number | null, signal?: string) => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try { cb(code, signal); } catch { /* listener bug shouldn't kill cleanup */ }
      }
    };

    // ssh2 emits 'exit' with the remote exit code (or signal), then
    // 'close' once the channel teardown finishes. We fire on whichever
    // arrives first and de-dup via the `closed` flag.
    channel.on("exit", (code: number | null, signal?: string) => {
      fireClose(code, signal);
    });
    channel.on("close", () => fireClose(null));
    channel.on("error", () => fireClose(null));

    return {
      stdin: channel,
      stdout: channel,
      stderr: channel.stderr,
      setWindow: (c: number, r: number) => {
        const sc = clampWindow(c, 80, 1, 1000);
        const sr = clampWindow(r, 24, 1, 500);
        try { channel.setWindow(sr, sc, 0, 0); } catch { /* channel may be closing */ }
      },
      close: (_signal?: string) => {
        try { channel.end(); } catch { /* already ending */ }
        try { channel.close(); } catch { /* already closed */ }
      },
      onClose: (cb) => { closeListeners.push(cb); },
    };
  }

  async forwardUnixSocket(socketPath: string): Promise<Duplex> {
    const client = await this.connect();
    return openSshUnixSocket(client as StreamLocalCapableClient, socketPath);
  }

  async forwardPort(remoteHost: string, remotePort: number): Promise<Duplex> {
    const client = await this.connect();
    return new Promise<Duplex>((resolve, reject) => {
      client.forwardOut(
        "127.0.0.1", 0,
        remoteHost, remotePort,
        (err, stream) => {
          if (err) return reject(err);
          resolve(stream as unknown as Duplex);
        },
      );
    });
  }

  /**
   * Open a reverse tunnel: the remote listens on an ephemeral 127.0.0.1 port
   * and every connection to it is handed to `onConnection` as a duplex stream
   * over this SSH connection. ssh2's 'tcp connection' event is client-wide, so
   * a single dispatcher routes by the bound `destPort` to the right handler.
   */
  async reverseForward(
    onConnection: (stream: Duplex) => void,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const client = await this.connect();
    this.attachReverseListener(client);

    const port = await new Promise<number>((resolve, reject) => {
      client.forwardIn("127.0.0.1", 0, (err, boundPort) => {
        if (err) return reject(err);
        resolve(boundPort);
      });
    });
    this.reverseHandlers.set(port, onConnection);

    return {
      port,
      close: async () => {
        this.reverseHandlers.delete(port);
        await new Promise<void>((resolve) => {
          try {
            client.unforwardIn("127.0.0.1", port, () => resolve());
          } catch {
            resolve();
          }
        });
      },
    };
  }

  /** Attach the single client-wide 'tcp connection' dispatcher (idempotent per client). */
  private attachReverseListener(client: SshClient): void {
    if (this.reverseListenerClient === client) return;
    this.reverseListenerClient = client;
    client.on("tcp connection", (details, accept, reject) => {
      const handler = this.reverseHandlers.get(details.destPort);
      if (!handler) {
        // No relay registered on this port — refuse rather than leak a channel.
        try { reject(); } catch { /* already gone */ }
        return;
      }
      const channel = accept();
      handler(channel as unknown as Duplex);
    });
  }

  async dispose(): Promise<void> {
    this.connecting = null;
    this.reverseHandlers.clear();
    this.reverseListenerClient = null;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  private async pipeLocal(
    localCmd: string,
    remoteCmd: string,
    onLog?: (log: LogEntry) => void,
    onBytes?: (bytes: number) => void,
  ): Promise<{ code: number }> {
    const client = await this.connect();

    return new Promise((resolve, reject) => {
      // Surface the local command so a hang at "0 B sent" tells the
      // operator exactly what to run by hand to reproduce.
      onLog?.(logEntry(`local: ${localCmd}`));

      client.exec(remoteCmd, (err, channel) => {
        if (err) return reject(err);

        const local = spawn("sh", ["-c", localCmd], {
          stdio: ["ignore", "pipe", "pipe"],
          env: getTarCreateEnv(),
        });

        let localExited = false;
        let localExitCode: number | null = null;
        let localStderrBuffer = "";

        if (onBytes) {
          // Backpressure-preserving Transform between local.stdout and the
          // SSH channel - counts every chunk passing through without
          // breaking node's pipe flow control. The pipe still closes the
          // channel on local.stdout end.
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              onBytes(chunk.length);
              cb(null, chunk);
            },
          });
          local.stdout.pipe(counter).pipe(channel);
        } else {
          local.stdout.pipe(channel);
        }

        local.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          localStderrBuffer += text;
          const trimmed = text.trim();
          if (trimmed && onLog) onLog(logEntry(`local stderr: ${trimmed}`, "warn"));
        });

        channel.stderr.on("data", (data: Buffer) => {
          const text = data.toString().trim();
          if (text && onLog) onLog(logEntry(`remote stderr: ${text}`, "warn"));
        });

        // Local process exit - distinct from the SSH channel close. If
        // local exits non-zero we MUST surface that, otherwise the channel
        // keeps the heartbeat ticking and the operator sees "0 B sent"
        // forever with no clue why.
        local.on("exit", (code, signal) => {
          localExited = true;
          localExitCode = code;
          if (onLog) {
            const detail = signal
              ? `signal=${signal}`
              : `code=${code ?? "null"}`;
            onLog(
              logEntry(
                `local process exited (${detail})${localStderrBuffer ? ` · stderr=${localStderrBuffer.trim()}` : ""}`,
                code === 0 ? "info" : "error",
              ),
            );
          }
          if (code !== 0) {
            // Force-close the channel so the outer promise resolves and
            // the caller can surface the real failure instead of hanging.
            try {
              channel.end();
              channel.close();
            } catch {
              /* channel may already be gone */
            }
            return;
          }
          // Clean local exit. Two-step shutdown:
          //
          //   1. Send EOF politely via channel.end() so the remote tar
          //      sees end-of-stdin and finishes extracting. We wait one
          //      tick first so any data still in the Transform's
          //      internal buffer can drain to the channel.
          //
          //   2. Arm a watchdog. If the channel still hasn't closed
          //      after `REMOTE_DRAIN_GRACE_MS`, the remote side is
          //      stuck (slow disk, hung tar, network anomaly, ssh2 EOF
          //      not propagating - we've seen all four). At that point
          //      all bytes are already on the wire so it's safe to
          //      force-close. Without this, the channel hangs at "82%"
          //      indefinitely until the 15-min idle timeout fires.
          //
          // The watchdog is cancelled if channel.on('close') fires
          // naturally, which it does on healthy networks within ~1s.
          setImmediate(() => {
            try {
              channel.end();
            } catch {
              /* channel may already be ending */
            }
          });
          const REMOTE_DRAIN_GRACE_MS = 30_000;
          const watchdog = setTimeout(() => {
            if (onLog) {
              onLog(
                logEntry(
                  `Local pipe finished but SSH channel didn't close after ${
                    REMOTE_DRAIN_GRACE_MS / 1000
                  }s - forcing close (remote tar may be stuck or ssh2 EOF didn't propagate).`,
                  "warn",
                ),
              );
            }
            try {
              channel.close();
            } catch {
              /* channel may already be closed */
            }
          }, REMOTE_DRAIN_GRACE_MS);
          (watchdog as { unref?: () => void }).unref?.();
          channel.once("close", () => clearTimeout(watchdog));
        });

        channel.on("close", (code: number) => {
          // If the channel closes "cleanly" (code 0) but the local
          // process actually failed, surface the local failure instead.
          if (localExited && localExitCode !== null && localExitCode !== 0) {
            return reject(
              new Error(
                `Local pipe command failed (exit ${localExitCode})${localStderrBuffer ? ": " + localStderrBuffer.trim() : ""}`,
              ),
            );
          }
          resolve({ code: code ?? 1 });
        });

        local.on("error", (e) => {
          reject(new Error(`Local process failed to start: ${e.message}`));
        });
      });
    });
  }

  private async hasRemoteCommand(command: string): Promise<boolean> {
    try {
      await this.exec(`command -v ${command} >/dev/null 2>&1 && echo ok`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async transferIn(
    localPath: string,
    remotePath: string,
    onLog?: (log: LogEntry) => void,
    options?: { excludes?: string[]; includes?: string[]; mode?: "auto" | "tar" },
  ): Promise<void> {
    const deps = {
      config: this.config,
      hasRemoteCommand: (command: string) => this.hasRemoteCommand(command),
      ensureRemoteDir: (path: string) => this.exec(`mkdir -p ${sq(path)}`).then(() => undefined),
      pipeLocal: (
        localCmd: string,
        remoteCmd: string,
        logCb?: (log: LogEntry) => void,
        onBytes?: (bytes: number) => void,
      ) => this.pipeLocal(localCmd, remoteCmd, logCb, onBytes),
    };

    if (options?.mode === "tar") {
      // The tar helper itself emits a "Streaming X MB…" line once it has
      // sized the directory, plus per-checkpoint progress and a final
      // throughput line. No need for a redundant pre-log here.
      await transferRemoteDirectoryWithTar(localPath, remotePath, deps, onLog, options);
      return;
    }

    const rsync = await canUseRemoteRsync(deps);
    if (rsync.ok) {
      try {
        await transferRemoteDirectoryWithRsync(localPath, remotePath, deps, onLog, options);
        return;
      } catch (err) {
        // rsync uses a SEPARATE /usr/bin/ssh subprocess with its own auth
        // path - when the VPS's pubkey/password state desyncs (perms
        // changed, fail2ban ban, authorized_keys edited), rsync fails
        // even though openship's own ssh2 connection still works.
        //
        // Fall back to tar-piped-through-pipeLocal, which RIDES the
        // existing ssh2 connection - same auth as every other openship
        // command. If steps 1-N succeeded, this will succeed too.
        const message = safeErrorMessage(err);
        onLog?.(
          logEntry(
            `rsync transfer failed (${message}); falling back to tar stream through the existing SSH connection.`,
            "warn",
          ),
        );
      }
    } else {
      onLog?.(logEntry(`rsync unavailable (${rsync.reason}); falling back to tar stream transfer.`, "warn"));
    }

    await transferRemoteDirectoryWithTar(localPath, remotePath, deps, onLog, options);
  }
}