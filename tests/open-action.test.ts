import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { IpcClient } from "../src/daemon/ipc.js";
import * as opencodeLauncher from "../src/open/launchers/opencode.js";
import * as runtime from "../src/open/runtime.js";
import { setupOpenHarness } from "./helpers/open-harness.js";

const originalCwd = process.cwd();
const { runOpen } = setupOpenHarness({ prefix: "codedeck-action-", restoreCwd: true });

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

  it("selects the managed theme through an ephemeral dir unless --no-theme", async () => {
    vi.spyOn(runtime, "playBoot").mockResolvedValue(undefined);
    vi.spyOn(opencodeLauncher, "ensureOpencodeTheme").mockReturnValue(true);
    vi.spyOn(opencodeLauncher, "createEphemeralTuiDir").mockReturnValue("/tmp/fake-tui");
    const remove = vi.spyOn(opencodeLauncher, "removeEphemeralTuiDir").mockImplementation(() => {});

    await runOpen(["reviewer"]);

    const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    const envExtra = opts.envExtra as Record<string, string>;
    expect(envExtra.OPENCODE_CONFIG_CONTENT).toContain("codedeck-reviewer");
    expect(envExtra.OPENCODE_CONFIG_DIR).toBe("/tmp/fake-tui");
    expect(typeof opts.onClose).toBe("function");

    opts.onClose();
    expect(remove).toHaveBeenCalledWith("/tmp/fake-tui");
    expect(runtime.finishOpenSession).toHaveBeenCalled();
  });

  it("leaves the user theme alone with --no-theme", async () => {
    const ensure = vi.spyOn(opencodeLauncher, "ensureOpencodeTheme");
    const create = vi.spyOn(opencodeLauncher, "createEphemeralTuiDir");

    await runOpen(["reviewer", "--no-theme"]);

    const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(ensure).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(opts.envExtra as Record<string, string>).not.toHaveProperty("OPENCODE_CONFIG_DIR");
  });

  it("launches unthemed when the theme cannot be ensured", async () => {
    vi.spyOn(runtime, "playBoot").mockResolvedValue(undefined);
    vi.spyOn(opencodeLauncher, "ensureOpencodeTheme").mockReturnValue(false);
    const create = vi.spyOn(opencodeLauncher, "createEphemeralTuiDir");

    await runOpen(["reviewer"]);

    const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(create).not.toHaveBeenCalled();
    expect(opts.envExtra as Record<string, string>).not.toHaveProperty("OPENCODE_CONFIG_DIR");
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
