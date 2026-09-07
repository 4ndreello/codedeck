import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessModels } from "../src/core/models.js";
import { LOGO } from "../src/cli/ui.js";
import {
  ROLES,
  bootFrame,
  buildOpenArgs,
  renderExit,
  effectiveModel,
  entitlementError,
  exitCodeFor,
  finishOpenSession,
  harnessMismatch,
  installSigintGuard,
  isNonInteractiveLaunch,
  judgeModel,
  parseRole,
  registerOpenCommand,
  renderBanner,
  resumeHint,
  resolveRole,
  resolvePluginDir,
  sanitizeEnv,
  scanOptions,
  spinnerTips,
  ensureCodedeckShim,
  launchClaude,
  withCodedeckOnPath,
  writeStdoutSync,
  SPINNER_VERB_WIDTH,
} from "../src/cli/commands/open.js";

/** The launcher passes settings inline, so every assertion reads them back. */
const settingsOf = (args: string[]) =>
  JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as Record<string, any>;

afterEach(() => {
  delete process.env.CODEDECK_CLI_NAME;
});

describe("open command argument builder", () => {
  it("uses the CodeDeck defaults and plugin contract", () => {
    const args = buildOpenArgs("orchestrator", {}, "/opt/codedeck/plugin", []);
    const settingsIndex = args.indexOf("--settings");

    expect(args.filter((_, i) => i !== settingsIndex + 1)).toEqual([
      "--model",
      "claude-opus-4-8",
      "--effort",
      "xhigh",
      "--remote-control",
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "/opt/codedeck/plugin",
      "--append-system-prompt-file",
      "/opt/codedeck/plugin/ultra.md",
      "--settings",
      "--agent",
      "codedeck:orchestrator",
      "-n",
      "CodeDeck · orchestrator",
    ]);
  });

  // The session name is what Claude shows in the window title, so it carries
  // the project folder along with the role. Without a cwd it stays exactly as
  // it always was.
  it("names the session with the project so windows stay distinguishable", () => {
    const args = buildOpenArgs("orchestrator", {}, "/opt/codedeck/plugin", [], "/home/u/dev/codedeck");

    expect(args.slice(args.indexOf("-n"))).toEqual(["-n", "CodeDeck · codedeck · orchestrator"]);
    expect(buildOpenArgs("orchestrator", {}, "/opt/codedeck/plugin", []).slice(-1)).toEqual([
      "CodeDeck · orchestrator",
    ]);
  });

  // `--agent` layers on Claude's own system prompt instead of replacing it, and
  // an agent file with no `tools:` key keeps the whole toolset, so general has
  // no reason to be the one role launched without its contract.
  it("hands general the same --agent as every other role", () => {
    const args = buildOpenArgs("general", {}, "/opt/codedeck/plugin", []);

    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual([
      "--agent",
      "codedeck:general",
    ]);
  });

  it("overrides launcher settings and appends Claude arguments verbatim", () => {
    const args = buildOpenArgs(
      "reviewer",
      {
        model: "claude-sonnet",
        effort: "high",
        resume: "session-42",
        worktree: true,
        bypass: false,
      },
      "/opt/codedeck/plugin",
      ["--model", "claude-opus-4-8", "--add-dir", "other tree"],
    );
    const settingsIndex = args.indexOf("--settings");

    expect(args.filter((_, i) => i !== settingsIndex + 1)).toEqual([
      "--model",
      "claude-sonnet",
      "--effort",
      "high",
      "--remote-control",
      "--plugin-dir",
      "/opt/codedeck/plugin",
      "--append-system-prompt-file",
      "/opt/codedeck/plugin/ultra.md",
      "--settings",
      "--agent",
      "codedeck:reviewer",
      "-n",
      "CodeDeck · reviewer",
      "--resume",
      "session-42",
      "-w",
      "--model",
      "claude-opus-4-8",
      "--add-dir",
      "other tree",
    ]);
  });

  it("enables Remote Control by default and respects the config toggle", () => {
    expect(buildOpenArgs("general", {}, "/opt/codedeck/plugin", [])).toContain("--remote-control");
    expect(buildOpenArgs("general", { remoteControl: true }, "/opt/codedeck/plugin", [])).toContain("--remote-control");
    expect(buildOpenArgs("general", { remoteControl: false }, "/opt/codedeck/plugin", [])).not.toContain("--remote-control");
  });

  // ${CLAUDE_PLUGIN_ROOT} is expanded only for hooks declared in a plugin's
  // hooks/hooks.json. In statusLine.command it throws inside the runner, which
  // swallows it: no status line, no error, not even under --debug. The command
  // has to name a path that needs no expansion.
  it("resolves the statusline path instead of leaving a plugin-root placeholder", () => {
    const settings = settingsOf(buildOpenArgs("general", {}, "/opt/codedeck/plugin", []));

    expect(settings.statusLine).toEqual({
      type: "command",
      command: "bash '/opt/codedeck/plugin/statusline.sh'",
      refreshInterval: 2,
    });
    expect(settings.statusLine.refreshInterval).toBe(2);
    expect(JSON.stringify(settings)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("declares the whole CodeDeck look", () => {
    const settings = settingsOf(buildOpenArgs("reviewer", {}, "/opt/codedeck/plugin", []));

    expect(settings.theme).toBe("custom:codedeck:codedeck-ultra");
    expect(settings.tui).toBe("fullscreen");
    expect(settings.spinnerVerbs.mode).toBe("replace");
    expect(settings.spinnerVerbs.verbs).toHaveLength(64);
    expect(settings.spinnerTipsOverride).toMatchObject({ excludeDefault: true, label: "ULTRA" });
    expect(settings.spinnerTipsOverride.tips.length).toBeGreaterThan(0);
  });

  // "replace" drops Claude Code's own verbs, so an empty or one-entry list
  // would leave the spinner saying the same word for a whole session.
  it("carries enough spinner verbs to replace the built-in ones", () => {
    const { spinnerVerbs } = settingsOf(buildOpenArgs("general", {}, "/opt/codedeck/plugin", []));

    expect(new Set(spinnerVerbs.verbs).size).toBe(spinnerVerbs.verbs.length);
    for (const verb of spinnerVerbs.verbs) expect(verb.trim()).toBe(verb);
  });

  // The spinner glyph is a module constant chosen by TERM alone, so the verb is
  // the only part of that line CodeDeck can paint. Halfwidth katakana and
  // digits only: fullwidth kana is two columns wide, and a verb that measures
  // wider than it counts pushes the elapsed time and token count out of line.
  it("keeps every spinner verb at the fixed width", () => {
    const { spinnerVerbs } = settingsOf(buildOpenArgs("general", {}, "/opt/codedeck/plugin", []));

    for (const verb of spinnerVerbs.verbs) {
      expect(verb, verb).toMatch(/^[ｦ-ﾝ0-9]+$/);
      expect([...verb].length, verb).toBe(SPINNER_VERB_WIDTH);
    }
  });

  // Every tip is read as a command someone will type, so a tip naming a command
  // this CLI does not ship is worse than no tip.
  it("only advertises commands the CLI actually ships", () => {
    const commands = new Set([
      "run", "ps", "logs", "wait", "diff", "stop", "send", "show", "open", "setup",
      "models", "doctor",
    ]);
    const { spinnerTipsOverride } = settingsOf(
      buildOpenArgs("general", {}, "/opt/codedeck/plugin", []),
    );

    for (const tip of spinnerTipsOverride.tips as string[]) {
      const named = tip.match(/codedeck ([a-z-]+)/)?.[1];
      expect(named, tip).toBeDefined();
      expect(commands, tip).toContain(named);
    }
  });

  // companyAnnouncements was tried and taken back out. It renders our string,
  // but Claude Code puts its own "Message from <organization>:" above it
  // whenever the account has an org, which no setting suppresses, so on such an
  // account the line reads as coming from the employer. Nothing was lost:
  // Claude Code's own opening header already names the model, the effort and
  // the agent, and the footer already says whether permissions are bypassed.
  it("puts no text on the opening screen", () => {
    const settings = settingsOf(buildOpenArgs("auditor", {}, "/opt/codedeck/plugin", []));

    expect(settings.companyAnnouncements).toBeUndefined();
  });

  it("keeps only the status line when the theme is off", () => {
    const args = buildOpenArgs("general", { theme: false }, "/opt/codedeck/plugin", []);

    expect(settingsOf(args)).toEqual({
      statusLine: {
        type: "command",
        command: "bash '/opt/codedeck/plugin/statusline.sh'",
        refreshInterval: 2,
      },
    });
  });

  // statusLine.command is handed to a shell, so the install directory is not
  // just a string here. Double quotes survive only the first of these; the rest
  // execute or break the command.
  it.each([
    ["a space", "/opt/Code Deck/plugin", "bash '/opt/Code Deck/plugin/statusline.sh'"],
    ["a substitution", "/opt/a$(id)b/plugin", "bash '/opt/a$(id)b/plugin/statusline.sh'"],
    ["a backtick", "/opt/a`id`b/plugin", "bash '/opt/a`id`b/plugin/statusline.sh'"],
    ["a quote", "/opt/it's/plugin", "bash '/opt/it'\\''s/plugin/statusline.sh'"],
  ])("keeps the status line runnable when the path holds %s", (_label, pluginDir, expected) => {
    // Both branches build the same command, so the quoting is checked on the
    // one that used to hand Claude a path it never resolved.
    expect(settingsOf(buildOpenArgs("general", { theme: false }, pluginDir, [])).statusLine.command)
      .toBe(expected);
    expect(settingsOf(buildOpenArgs("general", {}, pluginDir, [])).statusLine.command)
      .toBe(expected);
  });
});

describe("open command pure helpers", () => {
  it("defaults a non-interactive open to the orchestrator role", async () => {
    await expect(resolveRole(undefined, false)).resolves.toBe("orchestrator");
  });

  it("parses the supported roles and rejects unknown roles", () => {
    expect(ROLES).toEqual(["general", "orchestrator", "reviewer", "auditor"]);
    expect(parseRole(undefined)).toBeUndefined();
    expect(parseRole("orchestrator")).toBe("orchestrator");
    expect(parseRole(" REVIEWER ")).toBe("reviewer");
    expect(parseRole("implementer")).toBeUndefined();
  });

  it("removes only the nested Claude session marker", () => {
    const env = { PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1" };
    const sanitized = sanitizeEnv(env);

    expect(sanitized).toEqual({ PATH: "/bin", MISE_QUIET: "1" });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe("1");
    // The caller's own object is never touched, whether a key is dropped or
    // added: it is process.env, and this runs before the launch.
    expect(env).not.toHaveProperty("MISE_QUIET");
  });

  it("puts the CodeDeck bin directory first without mutating the environment", () => {
    const env = { PATH: `/usr/bin${path.delimiter}/bin`, HOME: "/tmp/home" };
    const binDir = "/tmp/codedeck/bin";

    expect(withCodedeckOnPath(env, binDir)).toEqual({
      PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: "/tmp/home",
    });
    expect(env).toEqual({ PATH: `/usr/bin${path.delimiter}/bin`, HOME: "/tmp/home" });
  });

  it("uses only the CodeDeck bin directory when PATH is absent or empty", () => {
    const binDir = "/tmp/codedeck/bin";

    expect(withCodedeckOnPath({}, binDir)).toEqual({ PATH: binDir });
    expect(withCodedeckOnPath({ PATH: "" }, binDir)).toEqual({ PATH: binDir });
  });

  it("does not duplicate a CodeDeck bin directory already at the front", () => {
    const binDir = "/tmp/codedeck/bin";
    const once = withCodedeckOnPath({ PATH: `/usr/bin${path.delimiter}/bin` }, binDir);

    expect(withCodedeckOnPath(once, binDir)).toEqual(once);
  });

  it("writes an executable Claude-facing codedeck shim", () => {
    const previousRunAgentDir = process.env.RUN_AGENT_DIR;
    const runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-open-shim-"));
    process.env.RUN_AGENT_DIR = runAgentDir;

    try {
      const binDir = ensureCodedeckShim();

      expect(binDir).toBe(path.join(runAgentDir, "bin"));
      if (binDir === undefined) return;

      const shim = path.join(binDir, "codedeck");
      const stats = fs.statSync(shim);
      const body = fs.readFileSync(shim, "utf8");

      expect(stats.mode & 0o111).not.toBe(0);
      // The shim is for this user's sessions, so group and other users get no access.
      expect(stats.mode & 0o777).toBe(0o700);
      expect(body.split("\n", 1)[0]).toBe("#!/usr/bin/env sh");
      expect(body).toContain(process.execPath);
    } finally {
      if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previousRunAgentDir;
      fs.rmSync(runAgentDir, { recursive: true, force: true });
    }
  });

  it("renders one banner string carrying the whole launch context", () => {
    const banner = renderBanner("reviewer", "claude-opus-5", "xhigh");

    expect(typeof banner).toBe("string");
    expect(banner).toContain("reviewer · claude-opus-5 · xhigh");
    expect(banner).toContain("╔═╗");
  });

  // The id cannot be printed any earlier: it does not exist when the boot
  // screen prints, and the launcher cannot read it off the session because
  // stdout is inherited so the TUI can paint straight to the terminal.
  it("offers the resume line the session ends with", () => {
    expect(resumeHint("reviewer", "92d88cce-bdbc-46db-8573-916afd32f6f7")).toContain(
      "codedeck open reviewer --resume 92d88cce-bdbc-46db-8573-916afd32f6f7",
    );
  });

  it("names the renamed CLI in the resume line, tips and mismatch hint", () => {
    process.env.CODEDECK_CLI_NAME = "codedeck-dev";

    expect(resumeHint("reviewer", "92d88cce-bdbc-46db-8573-916afd32f6f7")).toContain(
      "codedeck-dev open reviewer --resume 92d88cce-bdbc-46db-8573-916afd32f6f7",
    );
    expect(spinnerTips()).toHaveLength(12);
    expect(spinnerTips()[0]).toMatch(/^codedeck-dev run/);
    expect(spinnerTips().every((tip) => !tip.startsWith("codedeck "))).toBe(true);
    expect(
      harnessMismatch("reviewer", { harness: "codex", model: "gpt-5.6-luna" }),
    ).toContain("codedeck-dev run --role reviewer");
  });

  it("refuses to write an alias shim for hostile CLI names", () => {
    const previousRunAgentDir = process.env.RUN_AGENT_DIR;
    try {
      for (const hostile of ["../evil", "/tmp/codedeck-evil-probe", "a b", "a;b"]) {
        const runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-open-hostile-"));
        process.env.RUN_AGENT_DIR = runAgentDir;
        process.env.CODEDECK_CLI_NAME = hostile;

        const binDir = ensureCodedeckShim();
        expect(binDir).toBe(path.join(runAgentDir, "bin"));
        if (binDir === undefined) continue;
        expect(fs.readdirSync(binDir)).toEqual(["codedeck"]);

        fs.rmSync(runAgentDir, { recursive: true, force: true });
      }
      expect(fs.existsSync("/tmp/codedeck-evil-probe")).toBe(false);
    } finally {
      if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previousRunAgentDir;
    }
  });

  it("writes a renamed alias shim pointing at the real CLI entry", () => {
    const previousRunAgentDir = process.env.RUN_AGENT_DIR;
    const runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-open-alias-"));
    process.env.RUN_AGENT_DIR = runAgentDir;
    process.env.CODEDECK_CLI_NAME = "codedeck-dev";

    try {
      const binDir = ensureCodedeckShim();

      expect(binDir).toBe(path.join(runAgentDir, "bin"));
      if (binDir === undefined) return;

      for (const name of ["codedeck", "codedeck-dev"]) {
        const body = fs.readFileSync(path.join(binDir, name), "utf8");
        expect(body.split("\n", 1)[0]).toBe("#!/usr/bin/env sh");
        expect(body).toContain("cli/index.js");
      }
      expect(fs.readFileSync(path.join(binDir, "codedeck"), "utf8")).not.toContain(
        "CODEDECK_CLI_NAME",
      );
      expect(fs.readFileSync(path.join(binDir, "codedeck-dev"), "utf8")).toContain(
        "CODEDECK_CLI_NAME",
      );
      expect(fs.statSync(path.join(binDir, "codedeck-dev")).mode & 0o777).toBe(0o700);
    } finally {
      if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previousRunAgentDir;
      fs.rmSync(runAgentDir, { recursive: true, force: true });
    }
  });

  // The sign-off is the point of the exit, not the id, so a session that ended
  // without one still gets it.
  it("signs off with or without an id to offer", () => {
    expect(renderExit("general", "92d88cce-bdbc-46db-8573-916afd32f6f7")).toContain("╔╗ ╦ ╦╔═╗");
    expect(renderExit("general", undefined)).toContain("╔╗ ╦ ╦╔═╗");
    expect(renderExit("general", undefined)).not.toContain("--resume");
  });

  // A real tty signal test would need to own the foreground process group. The
  // teardown writer runs synchronously here, so invoking the installed handler
  // from it checks the same ordering without sending a process-wide signal.
  it("keeps the resume line while SIGINT arrives during teardown", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-open-test-"));
    const sessionFile = path.join(tempDir, "session");
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    fs.writeFileSync(sessionFile, sessionId);

    let onSigint: (() => void) | undefined;
    const removed: Array<() => void> = [];
    const signalHost = {
      on: (_event: "SIGINT", listener: () => void) => {
        onSigint = listener;
      },
      removeListener: (_event: "SIGINT", listener: () => void) => {
        removed.push(listener);
      },
    };
    const child = { kill: vi.fn(() => true) };
    const guard = installSigintGuard(() => child, signalHost);
    let output = "";

    try {
      finishOpenSession("reviewer", sessionFile, (text) => {
        onSigint?.();
        output += text;
      });

      expect(output).toContain(`codedeck open reviewer --resume ${sessionId}`);
      expect(removed).toEqual([]);
    } finally {
      guard.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    expect(removed).toHaveLength(1);
  });

  // A real process-group flood would kill the test runner. Driving the installed
  // listener keeps this test on the parent side while exercising every transition.
  it("survives a SIGINT flood and escalates after the grace window", () => {
    vi.useFakeTimers();
    let onSigint: (() => void) | undefined;
    const signalHost = {
      on: (_event: "SIGINT", listener: () => void) => {
        onSigint = listener;
      },
      removeListener: vi.fn(),
    };
    const child = { kill: vi.fn(() => true) };
    const guard = installSigintGuard(() => child, signalHost);

    try {
      for (let i = 0; i < 5; i++) onSigint?.();

      expect(signalHost.removeListener).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(999);
      expect(child.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.kill).toHaveBeenCalledTimes(2);
    } finally {
      guard.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels the SIGKILL timer when the child closes during grace", () => {
    vi.useFakeTimers();
    let onSigint: (() => void) | undefined;
    const signalHost = {
      on: (_event: "SIGINT", listener: () => void) => {
        onSigint = listener;
      },
      removeListener: vi.fn(),
    };
    const child = { kill: vi.fn(() => true) };
    const guard = installSigintGuard(() => child, signalHost);

    try {
      onSigint?.();
      onSigint?.();
      onSigint?.();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      guard.childClosed();
      vi.advanceTimersByTime(1000);

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      guard.dispose();
      vi.useRealTimers();
    }
  });

  it("reassembles partial synchronous stdout writes", () => {
    const text = "farewell resume line";
    const chunks: Buffer[] = [];
    const writeSync = vi.spyOn(fs, "writeSync").mockImplementation(
      ((_fd, buffer, offset = 0, length = buffer.byteLength - offset) => {
        const written = Math.min(2, length);
        chunks.push(Buffer.from(buffer as Uint8Array).subarray(offset, offset + written));
        return written;
      }) as typeof fs.writeSync,
    );

    try {
      writeStdoutSync(text);

      expect(Buffer.concat(chunks).toString()).toBe(text);
      expect(writeSync).toHaveBeenCalledTimes(Math.ceil(text.length / 2));
    } finally {
      writeSync.mockRestore();
    }
  });

  it("swallows EPIPE from a closed terminal", () => {
    const writeSync = vi.spyOn(fs, "writeSync").mockImplementation(
      (() => {
        const error = new Error("terminal closed") as NodeJS.ErrnoException;
        error.code = "EPIPE";
        throw error;
      }) as typeof fs.writeSync,
    );

    try {
      expect(() => writeStdoutSync("farewell")).not.toThrow();
    } finally {
      writeSync.mockRestore();
    }
  });

  it("writes the farewell when a force-killed child closes", async () => {
    vi.useFakeTimers();
    const previousRunAgentDir = process.env.RUN_AGENT_DIR;
    const previousExitCode = process.exitCode;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-open-force-test-"));
    const sessionFile = path.join(tempDir, "session");
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    fs.writeFileSync(sessionFile, sessionId);
    process.env.RUN_AGENT_DIR = tempDir;

    const close = vi.fn();
    const child = {
      stderr: null,
      kill: vi.fn(() => true),
      once: vi.fn((_event: string, listener: (...args: unknown[]) => void) => {
        if (_event === "close") close.mockImplementation(listener);
      }),
    };
    const spawnChild = vi.fn(() => child) as unknown as typeof spawn;
    let onSigint: (() => void) | undefined;
    const signalHost = {
      on: (_event: "SIGINT", listener: () => void) => {
        onSigint = listener;
      },
      removeListener: vi.fn(),
    };
    let output = "";

    try {
      const launched = launchClaude(
        "claude",
        "claude-opus-4-8",
        [],
        tempDir,
        sessionFile,
        () => finishOpenSession("reviewer", sessionFile, (text) => {
          output += text;
        }),
        spawnChild,
        signalHost,
      );

      onSigint?.();
      onSigint?.();
      onSigint?.();
      vi.advanceTimersByTime(1000);

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

      close(null, "SIGKILL");
      await launched;

      expect(output).toContain(`codedeck open reviewer --resume ${sessionId}`);
      expect(process.exitCode).toBe(137);
      expect(signalHost.removeListener).toHaveBeenCalledTimes(1);
    } finally {
      process.exitCode = previousExitCode;
      if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previousRunAgentDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  // Blanks stay blank so the mark keeps its silhouette while it resolves. Noise
  // in the gaps would read as a rectangle of static rather than as letters
  // arriving, and the last frame has to be the logo exactly.
  it("resolves the logo out of noise from left to right", () => {
    const noise = () => "ﾊ";

    expect(bootFrame(0, noise)[0]).toBe("ﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊ");
    expect(bootFrame(1, noise)).toEqual(LOGO);
    expect(bootFrame(0.5, noise)[0]).toBe("╔═╗╔═╗╔╦╗╔═╗ﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊﾊ");
    // Row two of the logo carries the only blanks, and they survive every frame.
    expect(bootFrame(0, noise)[1]).toBe("ﾊ  ﾊ ﾊﾊﾊﾊﾊﾊ ﾊﾊﾊﾊﾊ ﾊ  ﾊﾊﾊ");
  });

  // Every frame is one row per logo line, so the cursor walk that redraws them
  // stays in step with what was written.
  it("keeps every frame the shape of the logo", () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = bootFrame(progress, () => "ｦ");
      expect(frame).toHaveLength(LOGO.length);
      frame.forEach((line, i) => expect([...line]).toHaveLength([...LOGO[i]].length));
    }
  });

  // A hook that never ran leaves nothing, and a session that otherwise worked
  // should not end on a diagnostic about it.
  it.each([undefined, "", "  ", "not a session id"])(
    "says nothing when the hook left %o",
    (left) => {
      expect(resumeHint("general", left)).toBeUndefined();
    },
  );

  // The mise shim prints the tool it resolved on every run, straight over the
  // boot screen. Silencing it for this child is fair; silencing it for the
  // user's whole environment is not, so an explicit value wins.
  it("quiets the mise shim without overriding a setting of the user's own", () => {
    expect(sanitizeEnv({}).MISE_QUIET).toBe("1");
    expect(sanitizeEnv({ MISE_QUIET: "0" }).MISE_QUIET).toBe("0");
  });

  it("resolves a module-relative plugin directory", () => {
    const pluginDir = resolvePluginDir();

    expect(path.isAbsolute(pluginDir)).toBe(true);
    expect(path.basename(pluginDir)).toBe("plugin");
  });
});

// Under a pty (CI, `script`, most runners) stdout is a TTY, so a terminal check
// alone lets the role picker and the model wizard block a `-p` launch forever.
// This is the flag that says the launch answers once and exits.
// `open` launches claude and opencode sessions. Opening it for an agent bound
// elsewhere would run a session under a name whose configuration it ignores.
describe("an agent bound to another harness", () => {
  it("refuses, naming the harness and the way out", () => {
    const message = harnessMismatch("reviewer", { harness: "codex", model: "gpt-5.6-luna" });

    expect(message).toContain("codex");
    expect(message).toContain("codedeck run --role reviewer");
  });

  it("allows an agent bound to claude or opencode, and one nobody bound at all", () => {
    expect(harnessMismatch("general", { harness: "claude", model: "claude-opus-5" })).toBeUndefined();
    expect(harnessMismatch("general", { harness: "opencode", model: "prov/m" })).toBeUndefined();
    expect(harnessMismatch("general", undefined)).toBeUndefined();
  });

  // An explicit --model changes which binary runs, never whether it is the
  // right harness, so it is no escape from the refusal.
  it("refuses every harness without a launcher", () => {
    for (const harness of ["codex", "omp"] as const) {
      expect(harnessMismatch("auditor", { harness, model: "whatever" })).toContain(harness);
    }
  });
});

describe("non-interactive launch detection", () => {
  it("recognises both spellings of the print flag anywhere in the passthrough", () => {
    expect(isNonInteractiveLaunch(["--print"])).toBe(true);
    expect(isNonInteractiveLaunch(["-p"])).toBe(true);
    expect(isNonInteractiveLaunch(["--max-turns", "1", "-p", "hello"])).toBe(true);
  });

  it("leaves an interactive launch alone", () => {
    expect(isNonInteractiveLaunch([])).toBe(false);
    expect(isNonInteractiveLaunch(["--add-dir", "/tmp"])).toBe(false);
  });

  it("does not mistake a prompt that merely mentions the flag for the flag", () => {
    expect(isNonInteractiveLaunch(["explain --print to me"])).toBe(false);
    expect(isNonInteractiveLaunch(["--printer"])).toBe(false);
  });
});

describe("effective model", () => {
  it("takes the last --model, which is the one claude honours", () => {
    expect(effectiveModel(["--model", "first", "--model", "override"])).toBe("override");
  });

  it("reads the joined spelling too, which claude also accepts", () => {
    expect(effectiveModel(["--model=override"])).toBe("override");
    expect(effectiveModel(["--model", "first", "--model=override"])).toBe("override");
    expect(effectiveModel(["--model=first", "--model", "override"])).toBe("override");
  });

  it("reports nothing when the passthrough carries no model", () => {
    expect(effectiveModel([])).toBeUndefined();
    expect(effectiveModel(["--print", "hi"])).toBeUndefined();
    expect(effectiveModel(["--model"])).toBeUndefined();
  });

  // Scanning the built vector cannot answer "did the passthrough override
  // anything", because that vector always opens with a --model pair. Worse,
  // `open --resume --model` leaves a bare "--model" bound to resume, and the
  // token after it then reads as the model.
  it("does not read the launcher's own arguments", () => {
    const flags = { model: "resolved", resume: "--model", worktree: true };
    const args = buildOpenArgs("general", flags, "/p", []);

    expect(args.slice(args.indexOf("--resume"))).toEqual(["--resume", "--model", "-w"]);
    expect(effectiveModel([])).toBeUndefined();
  });
});

// Collapsing a signalled death to 1 tells the caller the session failed when it
// was actually killed. Shells report 128 plus the signal number.
describe("exit code", () => {
  it("passes a real exit code through, zero included", () => {
    expect(exitCodeFor(0, null)).toBe(0);
    expect(exitCodeFor(2, null)).toBe(2);
  });

  it("maps a signal to the conventional 128 plus its number", () => {
    expect(exitCodeFor(null, "SIGINT")).toBe(130);
    expect(exitCodeFor(null, "SIGKILL")).toBe(137);
    expect(exitCodeFor(null, "SIGTERM")).toBe(143);
  });

  it("falls back to 1 when there is neither", () => {
    expect(exitCodeFor(null, null)).toBe(1);
  });
});

// Unknown options must reach claude through the passthrough, but accepting them
// before the separator makes a typo in a safety flag silent: `--no-bypas` looked
// like it disabled the permission bypass and launched with it still on.
describe("unknown options before the separator", () => {
  const run = (argv: string[]) => {
    const program = new Command();
    program.name("codedeck").exitOverride();
    registerOpenCommand(program);
    return program.parseAsync(["node", "codedeck", ...argv]);
  };

  it("rejects a misspelled option instead of ignoring it", async () => {
    await expect(run(["open", "--no-bypas", "--", "--print"])).rejects.toThrow(/--no-bypas/);
    await expect(run(["open", "--modl", "x", "--", "--print"])).rejects.toThrow(/--modl/);
  });

  it("rejects it even without a separator", async () => {
    await expect(run(["open", "--no-bypas"])).rejects.toThrow(/--no-bypas/);
  });

});

// Driven through scanOptions rather than a parse, because the accepted cases
// would otherwise run the whole action and launch a session.
describe("option scanning", () => {
  const openCommand = (): Command => {
    const program = new Command();
    program.name("codedeck").exitOverride();
    registerOpenCommand(program);
    const open = program.commands.find((command) => command.name() === "open");
    if (!open) throw new Error("open command was not registered");
    return open;
  };

  const scan = (tokens: string[]) => scanOptions(tokens, openCommand());

  // Commander honours "=" only on options declared with a value and drops the
  // token otherwise, so this spelling looked accepted and did nothing:
  // `--no-bypass=false` launched with the permission bypass still on.
  it("rejects a value glued to an option that takes none", () => {
    expect(() => scan(["--no-bypass=false"])).toThrow(/takes no value/);
    expect(() => scan(["--worktree=true"])).toThrow(/takes no value/);
  });

  it("accepts a value glued to an option that wants one", () => {
    expect(scan(["--model=sonnet"])).toEqual([]);
  });

  // Commander binds the token after a value-taking option as its value, however
  // much it looks like a flag, so the guard must not read it as one.
  it("does not mistake an option's value for an option", () => {
    expect(scan(["--model", "-weird"])).toEqual([]);
    expect(scan(["--resume", "-abc"])).toEqual([]);
  });

  it("still rejects an unknown option among valid ones", () => {
    expect(() => scan(["--model", "sonnet", "--no-bypas"])).toThrow(/--no-bypas/);
  });

  it("names the renamed CLI in scan errors and spinner tips", () => {
    process.env.CODEDECK_CLI_NAME = "codedeck-dev";

    expect(() => scan(["--model", "sonnet", "--no-bypas"])).toThrow("codedeck-dev open");
    expect(() => scan(["--no-bypass=false"])).toThrow("codedeck-dev open");

    const { spinnerTipsOverride } = settingsOf(
      buildOpenArgs("general", {}, "/opt/codedeck/plugin", []),
    );
    expect(spinnerTipsOverride.tips[0]).toMatch(/^codedeck-dev run/);
  });

  // The operands are what tells a role from a value that happens to spell one.
  it("reports only the tokens commander did not swallow", () => {
    expect(scan(["reviewer"])).toEqual(["reviewer"]);
    expect(scan(["--resume", "reviewer"])).toEqual([]);
    expect(scan(["--model", "sonnet", "orchestrator"])).toEqual(["orchestrator"]);
  });
});

// The catalog answers "does this model exist", never "may this account use it".
// Those are different failures with different fixes, so they get different
// messages: one names a typo, the other names the plan.
describe("model preflight", () => {
  const catalog = (models: { id: string; aliases?: string[] }[]): HarnessModels[] => [
    {
      agent: "claude",
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: models.map((m) => ({ ...m, name: m.id, provider: "anthropic" })),
        },
      ],
    },
  ];

  it("accepts a model listed under its id or an alias", () => {
    const models = catalog([{ id: "claude-opus-4-8", aliases: ["opus"] }]);

    expect(judgeModel("claude-opus-4-8", models, false)).toEqual({ kind: "ok" });
    expect(judgeModel("opus", models, false)).toEqual({ kind: "ok" });
  });

  it("rejects an unlisted model and points at the closest one", () => {
    const verdict = judgeModel("claude-opus-4-9", catalog([{ id: "claude-opus-4-8" }]), false);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("claude-opus-4-8");
  });

  it("rejects without a suggestion when nothing is close", () => {
    const verdict = judgeModel("zzzzzzzzzz", catalog([{ id: "claude-opus-4-8" }]), false);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("No close model was found");
  });

  // An unreachable catalog is not evidence against the model. Failing here
  // would ground the user over a stale cache or an offline harness.
  it.each([
    ["no claude entry", []],
    ["harness not installed", [{ agent: "claude", available: false, providers: [] }]],
    ["discovery errored", [{ agent: "claude", available: true, error: "timed out", providers: [] }]],
    ["empty catalog", catalog([])],
    ["nothing at all", undefined],
  ] as [string, HarnessModels[] | undefined][])(
    "warns and continues when the catalog is unusable: %s",
    (_label, models) => {
      const verdict = judgeModel("claude-opus-4-8", models, false);

      expect(verdict.kind).toBe("unknown-catalog");
      if (verdict.kind !== "unknown-catalog") return;
      expect(verdict.warning).toContain("claude-opus-4-8");
    },
  );

  it("translates the entitlement tag and stays quiet otherwise", () => {
    expect(entitlementError("claude-opus-4-8", "boom [claude-code:unrecognized_model] boom"))
      .toContain("not entitled");
    expect(entitlementError("claude-opus-4-8", "some unrelated failure")).toBeUndefined();
  });

  // Passthrough can carry its own --model, which wins over the resolved one, so
  // naming the model CodeDeck chose would point the user at the wrong string.
  it("names the model claude actually rejected, not the one CodeDeck resolved", () => {
    const line = '[claude-code:unrecognized_model] {"model":"made-up-xyz","query_source":"sdk"}';

    expect(entitlementError("claude-opus-4-8", line)).toContain('"made-up-xyz"');
    expect(entitlementError("claude-opus-4-8", line)).not.toContain("claude-opus-4-8");
  });

  it("falls back to the resolved model when the tag carries no usable payload", () => {
    expect(entitlementError("claude-opus-4-8", "[claude-code:unrecognized_model] {oops"))
      .toContain('"claude-opus-4-8"');
    expect(entitlementError("claude-opus-4-8", "[claude-code:unrecognized_model] {}"))
      .toContain('"claude-opus-4-8"');
  });
});

describe("a saved model that left the catalog", () => {
  const catalogs = [
    {
      agent: "claude" as const,
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: [{ id: "claude-opus-5", name: "o", provider: "anthropic" }],
        },
      ],
    },
  ];

  it("tells the user to run setup when the model came from config", () => {
    const verdict = judgeModel("claude-opus-4", catalogs, true);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("codedeck setup");
  });

  // A wrong --model is a typo made just now, not a stale config.
  it("does not mention setup when the model came from a flag", () => {
    const verdict = judgeModel("claude-opus-4", catalogs, false);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).not.toContain("codedeck setup");
  });
});
