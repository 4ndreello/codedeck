import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../src/config/config.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { SessionRuntime } from "../src/drivers/session-runtime.js";

let configDir: string;
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-driver-sandbox-config-"));
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("stored sandbox on Codex follow-up turns", () => {
  it("reuses the creation-time sandbox and omits it on resume", async () => {
    const runtime = {
      nativeSessionId: "thread-created",
      pid: 4242,
    } as unknown as SessionRuntime;
    const spawn = vi.spyOn(SessionRuntime, "spawn").mockReturnValue(runtime);
    const driver = new CodexDriver();

    const created = await driver.start({
      sessionId: "session-sandbox",
      prompt: "first turn",
      cwd: "/tmp",
      sandbox: "danger-full-access",
    });
    saveConfig({ defaultSandbox: "read-only" });

    await driver.send(created, "follow-up turn");

    expect(created.sandbox).toBe("danger-full-access");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][0].args).toEqual(expect.arrayContaining(["-s", "danger-full-access"]));
    expect(spawn.mock.calls[1][0]).toMatchObject({
      nativeSessionId: "thread-created",
      args: expect.not.arrayContaining(["-s"]),
    });
  });
});
