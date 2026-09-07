import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { IpcClient } from "../src/daemon/ipc.js";
import { diffOpencodeSession } from "../src/cli/commands/open.js";
import * as claudeLauncher from "../src/open/launchers/claude.js";
import * as opencodeLauncher from "../src/open/launchers/opencode.js";
import * as runtime from "../src/open/runtime.js";
import { setupOpenHarness } from "./helpers/open-harness.js";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, execFileSync: vi.fn() };
});

const originalCwd = process.cwd();
const { runOpen } = setupOpenHarness({ prefix: "codedeck-action-", restoreCwd: true });

function writeConfig(config: Record<string, unknown>): void {
  const configDir = process.env.RUN_AGENT_CONFIG_DIR;
  if (!configDir) throw new Error("test config directory is missing");
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
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
    expect(Object.keys(inline).sort()).toEqual(["agent", "command", "instructions"]);
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
    expect(Object.keys(inline).sort()).toEqual(["agent", "command", "instructions"]);
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

describe("diffOpencodeSession", () => {
  it("returns the one session that appeared between snapshots", () => {
    expect(
      diffOpencodeSession(
        [{ id: "ses_old1", created: 1 }],
        [
          { id: "ses_old1", created: 1 },
          { id: "ses_f87425ee9ffejNZXkRaHKoEc3G", created: 2 },
        ],
      ),
    ).toBe("ses_f87425ee9ffejNZXkRaHKoEc3G");
  });

  it("returns undefined when zero or several sessions are new", () => {
    const same = [{ id: "ses_old1", created: 1 }];
    expect(diffOpencodeSession(same, same)).toBeUndefined();
    expect(
      diffOpencodeSession(same, [
        ...same,
        { id: "ses_new1", created: 2 },
        { id: "ses_new2", created: 3 },
      ]),
    ).toBeUndefined();
  });

  it("ignores rows without string ids on either side", () => {
    expect(
      diffOpencodeSession(
        [{ id: 42, created: 1 }],
        [{ id: 42, created: 1 }, { id: "ses_new1", created: 2 }],
      ),
    ).toBe("ses_new1");
    expect(diffOpencodeSession([], [{ created: 2 }])).toBeUndefined();
  });
});

describe("opencode resume capture", () => {
  // sessionsDir() derives from RUN_AGENT_DIR, so the temp dir must cover
  // runOpen (which computes sessionFile) as well as onClose (which writes).
  async function withTempRunAgentDir(body: () => Promise<void>): Promise<void> {
    const previous = process.env.RUN_AGENT_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-run-agent-"));
    process.env.RUN_AGENT_DIR = dir;
    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // probe-session-id-2026-09-07: snapshot before spawn, diff after close,
  // exactly one new session or no hint.
  it("leaves the captured id where the farewell reads it", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce(JSON.stringify([{ id: "ses_old1", created: 1 }]))
      .mockReturnValueOnce(
        JSON.stringify([
          { id: "ses_old1", created: 1 },
          { id: "ses_f87425ee9ffejNZXkRaHKoEc3G", created: 2 },
        ]),
      );

    await withTempRunAgentDir(async () => {
      await runOpen(["reviewer", "--no-theme"]);

      const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
      opts.onClose();
      const sessionFile = vi.mocked(runtime.finishOpenSession).mock.calls[0][1] as string;
      expect(fs.readFileSync(sessionFile, "utf8")).toBe("ses_f87425ee9ffejNZXkRaHKoEc3G");
    });
  });

  it("opens normally when the snapshot itself fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no opencode here");
    });

    await withTempRunAgentDir(async () => {
      await runOpen(["reviewer", "--no-theme"]);

      const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
      opts.onClose();
      expect(runtime.spawnHarness).toHaveBeenCalledTimes(1);
      const sessionFile = vi.mocked(runtime.finishOpenSession).mock.calls[0][1] as string;
      expect(fs.existsSync(sessionFile)).toBe(false);
    });
  });

  it("leaves no id behind when the diff is ambiguous", async () => {
    const same = JSON.stringify([{ id: "ses_old1", created: 1 }]);
    vi.mocked(execFileSync).mockReturnValueOnce(same).mockReturnValueOnce(same);

    await withTempRunAgentDir(async () => {
      await runOpen(["reviewer", "--no-theme"]);

      const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
      opts.onClose();
      const sessionFile = vi.mocked(runtime.finishOpenSession).mock.calls[0][1] as string;
      expect(fs.existsSync(sessionFile)).toBe(false);
    });
  });
});

describe("opencode session name", () => {
  // probe-name-2026-09-07 came back negative: no launch-time name channel
  // on the TUI, so the open sends nothing and the banner stays the surface.
  it("sends no name and keeps the banner as the guaranteed surface", async () => {
    await runOpen(["reviewer", "--no-theme"]);

    const [, args, opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(args).not.toContain("--title");
    expect(Object.keys(opts.envExtra as Record<string, string>).join(" ")).not.toMatch(
      /title/i,
    );
    expect(vi.mocked(runtime.renderBanner)).toHaveBeenCalledWith(
      "reviewer",
      "prov/m",
      "default",
    );
  });
});

describe("claude dispatch", () => {
  it("omits --remote-control when config disables it", async () => {
    const configDir = process.env.RUN_AGENT_CONFIG_DIR;
    if (!configDir) throw new Error("test config directory is missing");
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ remoteControl: false }));
    vi.spyOn(claudeLauncher, "preflightModel").mockResolvedValue(undefined);
    vi.spyOn(claudeLauncher, "resolveBinary").mockResolvedValue("/bin/claude");
    vi.spyOn(claudeLauncher, "assertSupport").mockResolvedValue(undefined);

    await runOpen(["general", "--no-theme"]);

    const [, args] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(args).not.toContain("--remote-control");
  });

  it("passes the resolved orchestrator mode through to Claude", async () => {
    writeConfig({
      orchestrator: {
        investigate: "read",
        selfWork: "trivial",
        tools: "edit",
        parallelism: 2,
      },
    });
    vi.spyOn(claudeLauncher, "preflightModel").mockResolvedValue(undefined);
    vi.spyOn(claudeLauncher, "resolveBinary").mockResolvedValue("/bin/claude");
    vi.spyOn(claudeLauncher, "assertSupport").mockResolvedValue(undefined);

    await runOpen(["orchestrator", "--no-theme"]);

    const [, args] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual([
      "--agent",
      "codedeck:orchestrator-edit",
    ]);
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain(
      "Run at most 2 workers concurrently.",
    );
  });

  it("passes the resolved orchestrator mode through to OpenCode", async () => {
    writeConfig({
      orchestrator: {
        investigate: "read",
        selfWork: "trivial",
        tools: "read",
      },
      agents: { orchestrator: { harness: "opencode", model: "prov/m" } },
    });

    await runOpen(["orchestrator", "--no-theme"]);

    const [, , opts] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    const agent = JSON.parse((opts.envExtra as Record<string, string>).OPENCODE_CONFIG_CONTENT)
      .agent["codedeck-orchestrator"];
    expect(agent.permission).toEqual({
      read: "allow",
      edit: "deny",
      write: "deny",
      task: "deny",
      bash: "allow",
    });
    expect(agent.prompt).toContain("Investigation allowance: read.");
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
