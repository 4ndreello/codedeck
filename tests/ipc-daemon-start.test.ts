import fs from "node:fs";
import { EventEmitter } from "node:events";
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
    vi.useFakeTimers();
    const socketPath = path.join(tempDir, "daemon.sock");
    const originalExistsSync = fs.existsSync.bind(fs);
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((file) =>
      file === socketPath ? true : originalExistsSync(file),
    );
    let ready = false;
    let readinessAt = 0;
    let resolvedAt = 0;
    let settled = false;
    const createConnection = vi.spyOn(net, "createConnection").mockImplementation(((...args: unknown[]) => {
      const socket = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      socket.end = vi.fn();
      socket.destroy = vi.fn();
      queueMicrotask(() => {
        if (ready) (args[1] as () => void)();
        else socket.emit("error", new Error("Daemon is not ready"));
      });
      return socket;
    }) as typeof net.createConnection);

    try {
      const started = new IpcClient().ensureDaemonStarted().then(() => {
        resolvedAt = Date.now();
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(createConnection).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      ready = true;
      readinessAt = Date.now();
      await vi.advanceTimersByTimeAsync(50);

      expect(settled).toBe(true);
      expect(resolvedAt - readinessAt).toBeLessThanOrEqual(50);
      expect(spawn).toHaveBeenCalledTimes(1);
      await started;
    } finally {
      existsSync.mockRestore();
      createConnection.mockRestore();
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
