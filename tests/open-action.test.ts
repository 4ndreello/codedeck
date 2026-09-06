import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcClient } from "../src/daemon/ipc.js";
import { registerOpenCommand } from "../src/cli/commands/open.js";
import * as opencodeLauncher from "../src/open/launchers/opencode.js";
import * as runtime from "../src/open/runtime.js";

const originalCwd = process.cwd();
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-action-"));
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ agents: { reviewer: { harness: "opencode", model: "prov/m" } } }),
  );
  vi.spyOn(IpcClient.prototype, "ensureDaemonStarted").mockResolvedValue(undefined as never);
  vi.spyOn(opencodeLauncher, "preflight").mockResolvedValue(undefined);
  vi.spyOn(opencodeLauncher, "resolveBinary").mockResolvedValue("/bin/opencode");
  vi.spyOn(runtime, "spawnHarness").mockResolvedValue(undefined);
  vi.spyOn(runtime, "finishOpenSession").mockImplementation(() => {});
  vi.spyOn(runtime, "renderBanner").mockReturnValue("");
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runOpen(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerOpenCommand(program);
  await program.parseAsync(["node", "codedeck", "open", ...argv], { from: "node" });
}

describe("opencode dispatch", () => {
  it("guarantees the daemon before spawning, in order", async () => {
    await runOpen(["reviewer", "--no-theme"]);

    const ensureOrder = vi.mocked(IpcClient.prototype.ensureDaemonStarted).mock
      .invocationCallOrder[0];
    const spawnOrder = vi.mocked(runtime.spawnHarness).mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(spawnOrder);
  });

  it("spawns opencode with the inline contract and wires the farewell", async () => {
    await runOpen(["reviewer", "--no-theme"]);

    const [bin, args, opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(bin).toBe("/bin/opencode");
    expect(args.slice(0, 5)).toEqual(["--agent", "codedeck-reviewer", "--model", "prov/m", "--auto"]);
    const inline = JSON.parse((opts.envExtra as Record<string, string>).OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(inline).sort()).toEqual(["agent", "instructions"]);
    expect(typeof opts.onClose).toBe("function");

    opts.onClose();
    expect(runtime.finishOpenSession).toHaveBeenCalledWith(
      "reviewer",
      expect.stringContaining("codedeck-session-"),
    );
  });

  it("warns on --worktree and still spawns", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await runOpen(["reviewer", "--no-theme", "--worktree"]);

    expect(err).toHaveBeenCalledWith(expect.stringContaining("no effect on opencode"));
    expect(runtime.spawnHarness).toHaveBeenCalledTimes(1);
  });

  it("accepts --no-theme without touching the inline contract", async () => {
    await runOpen(["reviewer", "--no-theme"]);

    const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    const inline = JSON.parse((opts.envExtra as Record<string, string>).OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(inline).sort()).toEqual(["agent", "instructions"]);
  });

  it("never spawns when the contract cannot be built", async () => {
    vi.spyOn(opencodeLauncher, "buildInlineConfig").mockImplementationOnce(() => {
      throw new Error("no contract");
    });

    await expect(runOpen(["reviewer", "--no-theme"])).rejects.toThrow("no contract");
    expect(runtime.spawnHarness).not.toHaveBeenCalled();
  });

  it("starts outside a git repo without complaint", async () => {
    process.chdir(os.tmpdir());

    await runOpen(["reviewer", "--no-theme"]);

    expect(runtime.spawnHarness).toHaveBeenCalledTimes(1);
  });
});

describe("currentWorkingDirectory", () => {
  it("throws when the cwd was deleted underneath", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-dead-cwd-"));
    process.chdir(dir);
    fs.rmdirSync(dir);
    try {
      expect(() => runtime.currentWorkingDirectory()).toThrow(/no longer exists/);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
