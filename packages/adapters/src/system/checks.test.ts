import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../types";
import { checkDocker } from "./checks";

function fakeExecutor(responses: Record<string, string | Error>): CommandExecutor {
  return {
    exec: vi.fn(async (command: string) => {
      const response = responses[command];
      if (response instanceof Error) throw response;
      return response ?? "";
    }),
  } as unknown as CommandExecutor;
}

describe("checkDocker", () => {
  it("is healthy when the daemon responds to docker version", async () => {
    const executor = fakeExecutor({
      "docker --version": "Docker version 29.1.3, build 29.1.3-0ubuntu3~24.04.2",
      "docker version --format '{{.Server.Version}}'": "29.1.3",
    });

    const status = await checkDocker(executor);

    expect(status.installed).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.running).toBe(true);
    expect(status.version).toBe("29.1.3");
  });

  it("is not running when the daemon probe fails", async () => {
    const executor = fakeExecutor({
      "docker --version": "Docker version 29.1.3, build 29.1.3-0ubuntu3~24.04.2",
      "docker version --format '{{.Server.Version}}'": new Error(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    });

    const status = await checkDocker(executor);

    expect(status.installed).toBe(true);
    expect(status.healthy).toBe(false);
    expect(status.running).toBe(false);
    expect(status.message).toBe("Docker is installed but the daemon is not running");
  });

  it("is missing when docker is not installed", async () => {
    const executor = fakeExecutor({
      "docker --version": new Error("docker: command not found"),
    });

    const status = await checkDocker(executor);

    expect(status.installed).toBe(false);
    expect(status.healthy).toBe(false);
    expect(status.message).toBe("Docker is not installed");
  });
});
