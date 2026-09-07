import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HARNESS_INJECTION,
  harnessInjection,
  sanitizeInjectedArgument,
  slashCommandKeystrokes,
  supportsInjection,
} from "../src/open/injection.js";
import {
  buildInnerCommand,
  buildScriptInvocation,
  hasBinaryOnPath,
  ptyShimPath,
  ptyUnavailableReason,
  watchNameSidecar,
} from "../src/open/pty.js";
import { ptyLaunchForHarness } from "../src/cli/commands/open.js";
import { ptyLaunchFor } from "../src/open/runtime.js";

const SHIM = "/plugin/pty-shim.mjs";
const preconditions = (overrides: Record<string, unknown> = {}) => ({
  shim: SHIM,
  platform: "linux" as NodeJS.Platform,
  stdinIsTty: true,
  stdoutIsTty: true,
  env: { PATH: "/usr/bin" },
  fileExists: () => true,
  hasScript: () => true,
  ...overrides,
});

const tempDirs: string[] = [];
function tempSessionFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-pty-test-"));
  tempDirs.push(dir);
  return path.join(dir, "session");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("harness injection contract", () => {
  it("types the rename Claude Code only exposes in its TUI", () => {
    expect(harnessInjection("claude").rename?.("corrigir auth")).toBe("/rename corrigir auth\r");
  });

  it("lists every harness so none is silently forgotten", () => {
    expect(Object.keys(HARNESS_INJECTION).sort()).toEqual(["claude", "codex", "omp", "opencode"]);
  });

  // A guess typed into someone's session would land as a prompt, so a harness
  // whose command nobody probed declares nothing and gets no pty.
  it("claims injection support only where a command is known", () => {
    expect(supportsInjection("claude")).toBe(true);
    expect(supportsInjection("opencode")).toBe(false);
    expect(supportsInjection("codex")).toBe(false);
    expect(supportsInjection("omp")).toBe(false);
  });

  it("flattens what a terminal would read as an instruction", () => {
    expect(sanitizeInjectedArgument("primeira\rlinha\nsegunda")).toBe("primeira linha segunda");
    expect(sanitizeInjectedArgument("nome\u001b[31m")).toBe("nome [31m");
    expect(sanitizeInjectedArgument("   ")).toBeUndefined();
    expect(sanitizeInjectedArgument("")).toBeUndefined();
  });

  it("caps the typed name instead of pasting a paragraph", () => {
    const typed = slashCommandKeystrokes("rename", "x".repeat(120));
    expect(typed).toBe(`/rename ${"x".repeat(40)}\r`);
  });

  it("types nothing when the name survives sanitising as empty", () => {
    expect(slashCommandKeystrokes("rename", "\r\n")).toBeUndefined();
  });
});

describe("pty invocation", () => {
  it("quotes every argument so a prompt cannot break out of the shell string", () => {
    const inner = buildInnerCommand(SHIM, { bin: "claude", args: ["-n", "it's; rm -rf /"] }, "/usr/bin/node");
    expect(inner).toBe(`exec '/usr/bin/node' '${SHIM}' 'claude' '-n' 'it'\\''s; rm -rf /'`);
  });

  it("spells script the way each platform does", () => {
    expect(buildScriptInvocation("exec claude", "linux")).toEqual({
      bin: "script",
      args: ["-qefc", "exec claude", "/dev/null"],
    });
    expect(buildScriptInvocation("exec claude", "darwin")).toEqual({
      bin: "script",
      args: ["-q", "/dev/null", "/bin/sh", "-c", "exec claude"],
    });
  });

  it("finds the shim inside the plugin directory", () => {
    expect(ptyShimPath("/opt/codedeck/plugin")).toBe("/opt/codedeck/plugin/pty-shim.mjs");
  });

  it("reads PATH entries rather than shelling out to look for a binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-pty-path-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "script");
    fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });

    expect(hasBinaryOnPath("script", { PATH: dir })).toBe(true);
    expect(hasBinaryOnPath("script", { PATH: "/nonexistent" })).toBe(false);
    expect(hasBinaryOnPath("script", {})).toBe(false);
  });
});

describe("pty preconditions", () => {
  it("runs under a pty when the terminal, the platform and the plugin allow it", () => {
    expect(ptyUnavailableReason(preconditions())).toBeUndefined();
  });

  it.each([
    ["disabled by configuration", { enabled: false }],
    ["no script(1) on Windows", { platform: "win32" as NodeJS.Platform }],
    ["not attached to a terminal", { stdinIsTty: false }],
    ["not attached to a terminal", { stdoutIsTty: false }],
    ["script(1) not found on PATH", { hasScript: () => false }],
    [`pty shim missing at ${SHIM}`, { fileExists: () => false }],
  ])("falls back with %s", (reason, overrides) => {
    expect(ptyUnavailableReason(preconditions(overrides))).toBe(reason);
  });

  // The fallback is the whole safety story: whatever is missing, `open` still
  // opens, only without the automatic rename.
  it("drops the pty from spawn options when the process has no terminal", () => {
    const launch = { shim: SHIM, sessionFile: "/tmp/session" };
    const opts = {
      cwd: "/repo",
      sessionFile: "/tmp/session",
      notFoundMessage: "missing",
      onClose: () => {},
      pty: launch,
    };

    expect(ptyLaunchFor(opts)).toBeUndefined();
    expect(ptyLaunchFor({ ...opts, pty: undefined })).toBeUndefined();
  });
});

describe("ptyLaunchForHarness", () => {
  const config = { defaultAgent: "claude" as const };

  it("asks for a pty when the harness has something to type", () => {
    const launch = ptyLaunchForHarness("claude", "/plugin", "/tmp/session", {}, config, true);

    expect(launch?.shim).toBe(ptyShimPath("/plugin"));
    expect(launch?.sessionFile).toBe("/tmp/session");
    expect(launch?.keystrokesForName?.("nome")).toBe("/rename nome\r");
  });

  it("skips harnesses with no verified command", () => {
    expect(ptyLaunchForHarness("opencode", "/plugin", "/tmp/session", {}, config, true)).toBeUndefined();
  });

  it("skips a non-interactive launch, which has no TUI to type into", () => {
    expect(ptyLaunchForHarness("claude", "/plugin", "/tmp/session", {}, config, false)).toBeUndefined();
  });

  it.each([
    ["--no-pty", { pty: false }, config],
    ["config", {}, { ...config, pty: false }],
  ])("honours %s", (_label, flags, configured) => {
    expect(ptyLaunchForHarness("claude", "/plugin", "/tmp/session", flags, configured, true)).toBeUndefined();
  });
});

describe("watchNameSidecar", () => {
  const sidecar = (sessionFile: string, id = "11111111-2222-3333-4444-555555555555") =>
    `${sessionFile}.${id}.name`;

  it("delivers a name the hook wrote before the watcher started", () => {
    const sessionFile = tempSessionFile();
    fs.writeFileSync(sidecar(sessionFile), "corrigir-auth\n", "utf8");
    const seen: string[] = [];

    const stop = watchNameSidecar(sessionFile, (name) => seen.push(name));
    stop();

    expect(seen).toEqual(["corrigir-auth\n"]);
  });

  it("delivers a name the hook writes while the session runs, once", async () => {
    const sessionFile = tempSessionFile();
    const seen: string[] = [];
    const stop = watchNameSidecar(sessionFile, (name) => seen.push(name));

    fs.writeFileSync(sidecar(sessionFile), "primeiro", "utf8");
    fs.writeFileSync(sidecar(sessionFile, "22222222-3333-4444-5555-666666666666"), "segundo", "utf8");
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();

    expect(seen).toEqual(["primeiro"]);
  });

  it("ignores files that are not a session name sidecar", async () => {
    const sessionFile = tempSessionFile();
    const seen: string[] = [];
    const stop = watchNameSidecar(sessionFile, (name) => seen.push(name));

    fs.writeFileSync(`${sessionFile}.log`, "nao", "utf8");
    fs.writeFileSync(path.join(path.dirname(sessionFile), "outra-sessao.abc.name"), "nao", "utf8");
    fs.writeFileSync(sidecar(sessionFile), "sim", "utf8");
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();

    expect(seen).toEqual(["sim"]);
  });

  it("ignores an empty sidecar rather than typing a bare command", () => {
    const sessionFile = tempSessionFile();
    fs.writeFileSync(sidecar(sessionFile), "   \n", "utf8");
    const seen: string[] = [];

    watchNameSidecar(sessionFile, (name) => seen.push(name))();

    expect(seen).toEqual([]);
  });

  it("costs the rename, never the session, when the directory cannot be watched", () => {
    vi.spyOn(fs, "watch").mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    expect(() => watchNameSidecar(tempSessionFile(), () => {})()).not.toThrow();
  });
});
