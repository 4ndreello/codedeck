import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcClient } from "../src/daemon/ipc.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

vi.mock("node:child_process", () => ({ spawn }));

describe("IpcClient.ensureDaemonStarted", () => {
  let tempDir: string;
  let server: net.Server | undefined;
  let previousRunAgentDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-agent-ipc-start-"));
    previousRunAgentDir = process.env.RUN_AGENT_DIR;
    previousConfigDir = process.env.RUN_AGENT_CONFIG_DIR;
    process.env.RUN_AGENT_DIR = tempDir;
    process.env.RUN_AGENT_CONFIG_DIR = path.join(tempDir, "config");
    spawn.mockClear();
    server = undefined;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllTimers();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
    else process.env.RUN_AGENT_DIR = previousRunAgentDir;
    if (previousConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
    else process.env.RUN_AGENT_CONFIG_DIR = previousConfigDir;
  });

  it("resolves within 50 ms after the socket starts accepting connections", async () => {
    const socketPath = path.join(tempDir, "daemon.sock");
    const offsets = [5, 30, 55, 80, 105, 130];

    for (const [index, offset] of offsets.entries()) {
      server = net.createServer();
      const attemptServer = server;
      let listeningAt = 0;
      const started = new IpcClient().ensureDaemonStarted().then(() => Date.now());
      const listening = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          attemptServer.once("error", reject);
          attemptServer.listen(socketPath, () => {
            listeningAt = Date.now();
            resolve();
          });
        }, offset);
      });

      const [resolvedAt] = await Promise.all([started, listening.then(() => undefined)]);
      expect(resolvedAt - listeningAt).toBeLessThanOrEqual(50);
      expect(spawn).toHaveBeenCalledTimes(index + 1);

      await new Promise<void>((resolve, reject) => {
        attemptServer.close((error) => error ? reject(error) : resolve());
      });
      fs.rmSync(socketPath, { force: true });
      server = undefined;
    }
  });

  it("rejects after the six second startup budget when the socket never accepts", async () => {
    vi.useFakeTimers();
    let settled = false;
    const started = new IpcClient().ensureDaemonStarted();
    started.finally(() => { settled = true; }).catch(() => {});

    await vi.advanceTimersByTimeAsync(5999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(started).rejects.toThrow("Failed to start daemon");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not spawn when the daemon already accepts on the socket", async () => {
    const socketPath = path.join(tempDir, "daemon.sock");
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, resolve);
    });

    await new IpcClient().ensureDaemonStarted();

    expect(spawn).not.toHaveBeenCalled();
  });
});
