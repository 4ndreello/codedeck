import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
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
  createInputGate,
  hasBinaryOnPath,
  ptyShimPath,
  ptyUnavailableReason,
  startPtySession,
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
const inputGates: Array<{ dispose: () => void }> = [];
function tempSessionFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-pty-test-"));
  tempDirs.push(dir);
  return path.join(dir, "session");
}

afterEach(() => {
  for (const gate of inputGates.splice(0)) gate.dispose();
  vi.useRealTimers();
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
    expect(Object.keys(HARNESS_INJECTION).sort()).toEqual(["antigravity", "claude", "codex", "omp", "opencode"]);
  });

  // A guess typed into someone's session would land as a prompt, so a harness
  // whose command nobody probed declares nothing and gets no pty.
  it("claims injection support only where a command is known", () => {
    expect(supportsInjection("claude")).toBe(true);
    expect(supportsInjection("opencode")).toBe(false);
    expect(supportsInjection("codex")).toBe(false);
    expect(supportsInjection("omp")).toBe(false);
    expect(supportsInjection("antigravity")).toBe(false);
  });

  // probe-rename-2026-09-07 came back negative for opencode 1.18.21, so the
  // entry stays declared-but-empty until a transcript pins its command.
  it("keeps the opencode entry empty while its command is unprobed", () => {
    expect(HARNESS_INJECTION.opencode).toEqual({});
    expect(harnessInjection("opencode").rename).toBeUndefined();
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

  // The session file is named after a pid and the kernel reuses pids, so a
  // sidecar left behind by a dead session would otherwise have this one rename
  // itself after someone else's prompt.
  it("removes a sidecar left behind by a dead session instead of typing it", () => {
    const sessionFile = tempSessionFile();
    const stale = sidecar(sessionFile);
    fs.writeFileSync(stale, "prompt-de-outra-sessao\n", "utf8");
    const seen: string[] = [];

    const stop = watchNameSidecar(sessionFile, (name) => seen.push(name));
    stop();

    expect(seen).toEqual([]);
    expect(fs.existsSync(stale)).toBe(false);
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

  // The prune covers what is already there; this covers a symlink appearing
  // while the session runs, which is the only window left.
  it("refuses a symlink planted under a sidecar's name", async () => {
    const sessionFile = tempSessionFile();
    const secret = path.join(path.dirname(sessionFile), "secret");
    fs.writeFileSync(secret, "conteudo-que-nao-deve-ser-digitado", "utf8");
    const seen: string[] = [];
    const stop = watchNameSidecar(sessionFile, (name) => seen.push(name));

    fs.symlinkSync(secret, sidecar(sessionFile));
    fs.writeFileSync(sidecar(sessionFile, "33333333-4444-5555-6666-777777777777"), "nome-de-verdade", "utf8");
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();

    expect(seen).toEqual(["nome-de-verdade"]);
  });

  it("costs the rename, never the session, when the directory cannot be watched", () => {
    vi.spyOn(fs, "watch").mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    expect(() => watchNameSidecar(tempSessionFile(), () => {})()).not.toThrow();
  });
});

describe("pty input gate", () => {
  const quietMs = 300;
  const setup = () => {
    vi.useFakeTimers();
    const inject = vi.fn();
    const gate = createInputGate({ inject });
    inputGates.push(gate);
    return { gate, inject };
  };
  const expectHeldAfterQuiet = (inject: ReturnType<typeof vi.fn>) => {
    vi.advanceTimersByTime(quietMs);
    expect(inject).not.toHaveBeenCalled();
  };
  const expectInjectedAfterQuiet = (inject: ReturnType<typeof vi.fn>) => {
    vi.advanceTimersByTime(quietMs);
    expect(inject).toHaveBeenCalledOnce();
  };

  it("types a name after a clean input has been quiet for 300 ms", () => {
    const { gate, inject } = setup();
    gate.offer("/rename nome\r");
    expect(inject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(quietMs - 1);
    expect(inject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith("/rename nome\r");
  });

  it("holds the name while a typed line is dirty", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("Bora tamb"));
    gate.offer("/rename nome\r");
    expectHeldAfterQuiet(inject);
  });

  it("types a held name after Enter for a non-mention token", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("oi"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\r"));
    vi.advanceTimersByTime(quietMs - 1);
    expect(inject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(inject).toHaveBeenCalledOnce();
  });

  it("keeps a held name when the user types again before quiet expires", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("oi"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\r"));
    vi.advanceTimersByTime(quietMs - 1);
    gate.observe(Buffer.from("!"));
    vi.advanceTimersByTime(quietMs);
    expect(inject).not.toHaveBeenCalled();
    gate.observe(Buffer.from("\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each([
    {
      name: "pasted Enter and line continuation",
      input: "oi",
      chunks: ["\u001b[200~texto", "\r", "\u001b[201~", "\\", "\r"],
      submitAfter: true,
    },
    {
      name: "Alt+Enter",
      input: "Bora tamb",
      chunks: ["\u001b\r"],
      submitAfter: true,
    },
  ])("does not treat $name as submit", ({ input, chunks, submitAfter }) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from(input));
    gate.offer("/rename nome\r");
    for (const chunk of chunks) {
      gate.observe(Buffer.from(chunk));
      if (chunk.includes("\r")) expectHeldAfterQuiet(inject);
    }
    if (submitAfter) {
      gate.observe(Buffer.from("\r"));
      expectInjectedAfterQuiet(inject);
    }
  });

  it("submits after a normal bracketed paste", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("see "));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\u001b[200~hello world\u001b[201~"));
    gate.observe(Buffer.from("\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("recognizes bracketed paste after a pending escape", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("\u001b"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\u001b[200~line1\r"));
    vi.advanceTimersByTime(quietMs);
    expect(inject).not.toHaveBeenCalled();
  });

  it("keeps a held name after Enter accepts an @ mention", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("explain @src/file.ts"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\r"));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("explain this\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each([
    { name: "DEL", byte: 0x7f },
    { name: "BS", byte: 0x08 },
  ])("lets Enter submit after two $name backspaces", ({ byte }) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("@x"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from([byte, byte]));
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each(["e\u0301", "👨‍👩‍👧‍👦"])("removes one Unicode grapheme per backspace: %s", (grapheme) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from(`@${grapheme}`));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from([0x7f, 0x7f]));
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each([
    { name: "space", separator: " " },
    { name: "tab", separator: "\t" },
  ])("starts a new token after a $name", ({ separator }) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from(`a${separator}b`));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("keeps the mention guard after Tab may accept a completion", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("@src"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\t\r"));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("keeps the mention guard after backspace removes its separator", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("@src "));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\x7f\r"));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each([
    { name: "Enter", edit: "" },
    { name: "backspace", edit: "\x7f" },
    { name: "space", edit: " " },
  ])("keeps the guard after a cursor-moving escape and $name", ({ edit }) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("@src/fo hi"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from(`\u001b[D\u001b[D\u001b[D${edit}\r`));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each([
    { name: "line continuation", separator: "\\\r" },
    { name: "Alt+Enter", separator: "\u001b\r" },
  ])("tracks an @ token after $name", ({ separator }) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("foo"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from(`${separator}@src\r`));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("keeps the mention guard when an escape sequence flushes Enter", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("@src"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\u001b[\r"));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("starts a new token after Ctrl+J", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("first\nsecond"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("recognizes a mention after Ctrl+J", () => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("first\n@src"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from("\r"));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it.each([
    { name: "Ctrl+U", byte: 0x15 },
    { name: "Ctrl+W", byte: 0x17 },
  ])("keeps Enter conservative after $name", ({ byte }) => {
    const { gate, inject } = setup();
    gate.observe(Buffer.from("abc"));
    gate.offer("/rename nome\r");
    gate.observe(Buffer.from([byte]));
    gate.observe(Buffer.from(" \r"));
    expectHeldAfterQuiet(inject);
    gate.observe(Buffer.from("ok\r"));
    expectInjectedAfterQuiet(inject);
  });

  it("ignores whole-chunk terminal focus reports", () => {
    const { gate, inject } = setup();
    gate.offer("/rename nome\r");
    vi.advanceTimersByTime(quietMs - 1);
    gate.observe(Buffer.from("\u001b[I"));
    gate.observe(Buffer.from("\u001b[O"));
    vi.advanceTimersByTime(1);
    expect(inject).toHaveBeenCalledOnce();
  });

  it("types at most once and drops a held name on dispose", () => {
    const first = setup();
    first.gate.offer("/rename first\r");
    vi.advanceTimersByTime(quietMs);
    first.gate.offer("/rename second\r");
    vi.advanceTimersByTime(quietMs);
    expect(first.inject).toHaveBeenCalledOnce();
    first.gate.dispose();

    const second = setup();
    second.gate.offer("/rename held\r");
    expect(vi.getTimerCount()).toBe(1);
    second.gate.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(quietMs * 2);
    expect(second.inject).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("startPtySession", () => {
  // Enough of a child to exercise the wire: what the parent typed lands in
  // `written`, and `writable` is the flag the EPIPE guard reads.
  function fakeChild() {
    const written: string[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (chunk: Buffer | string) => {
        written.push(chunk.toString());
        return true;
      },
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: Object.assign(new EventEmitter(), { pipe: () => {} }),
      stderr: null,
    });
    return { child, stdin, written };
  }

  function fakeTerminal() {
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: false,
      resume: () => {},
      pause: () => {},
      setRawMode: () => {},
    });
    const stdout = Object.assign(new EventEmitter(), { rows: 41, columns: 137 });
    return { stdin, stdout };
  }

  function start(overrides: Record<string, unknown> = {}) {
    const { child, stdin: childStdin, written } = fakeChild();
    const terminal = fakeTerminal();
    const spawnChild = vi.fn(() => child);
    const session = startPtySession({
      target: { bin: "claude", args: [] },
      launch: { shim: SHIM, sessionFile: tempSessionFile() },
      cwd: "/repo",
      env: {},
      spawnChild: spawnChild as never,
      stdin: terminal.stdin as never,
      stdout: terminal.stdout as never,
      ...overrides,
    });
    return { session, child, childStdin, written, terminal, spawnChild };
  }

  it("hands the harness the terminal's size, not the zero script leaves behind", () => {
    const { spawnChild, session } = start();
    session.dispose();

    const env = (spawnChild.mock.calls[0] as unknown[])[2] as { env: Record<string, string> };
    expect(env.env.CODEDECK_PTY_ROWS).toBe("41");
    expect(env.env.CODEDECK_PTY_COLS).toBe("137");
  });

  it("waits for the user's submitted line before typing a sidecar name", async () => {
    const sessionFile = tempSessionFile();
    const { session, terminal, written } = start({
      launch: {
        shim: SHIM,
        sessionFile,
        keystrokesForName: (name: string) => `/rename ${name}\r`,
      },
    });
    terminal.stdin.emit("data", Buffer.from("oi"));
    fs.writeFileSync(`${sessionFile}.11111111-2222-3333-4444-555555555555.name`, "nome", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(written.join("")).toBe("oi");

    terminal.stdin.emit("data", Buffer.from("\r"));
    await new Promise((resolve) => setTimeout(resolve, 350));
    session.dispose();

    expect(written.join("")).toBe("oi\r/rename nome\r");
  });

  it("falls back to a usable size when the terminal reports none", () => {
    const terminal = fakeTerminal();
    Object.assign(terminal.stdout, { rows: 0, columns: 0 });
    const { spawnChild, session } = start({ stdout: terminal.stdout as never });
    session.dispose();

    const env = (spawnChild.mock.calls[0] as unknown[])[2] as { env: Record<string, string> };
    expect(env.env.CODEDECK_PTY_ROWS).toBe("24");
    expect(env.env.CODEDECK_PTY_COLS).toBe("80");
  });

  // Raw mode means Ctrl+C is a byte rather than a signal, so the escalation
  // that kills a wedged session has to be fed from the keystroke.
  it("reports the Ctrl+C key so the escape hatch still has something to count", () => {
    const interrupts: number[] = [];
    const { session, terminal, written } = start({ onInterrupt: () => interrupts.push(1) });

    terminal.stdin.emit("data", Buffer.from("oi"));
    expect(interrupts).toHaveLength(0);

    terminal.stdin.emit("data", Buffer.from([0x03]));
    session.dispose();

    expect(interrupts).toHaveLength(1);
    expect(written.join("")).toBe("oi\u0003");
  });

  it("drops keystrokes instead of crashing once the pipe is gone", () => {
    const { session, childStdin, terminal, written } = start();
    childStdin.writable = false;

    expect(() => terminal.stdin.emit("data", Buffer.from("oi"))).not.toThrow();
    expect(() => session.inject("/rename x\r")).not.toThrow();
    session.dispose();

    expect(written).toEqual([]);
  });

  // The shim binds the socket a moment after the pty exists. A resize landing
  // in that window used to be dropped, and nothing sent the size again.
  it("sends the size as soon as there is a wire, not only on resize", async () => {
    const { spawnChild, session, terminal } = start();
    const spawnOptions = (spawnChild.mock.calls[0] as unknown[])[2] as { env: Record<string, string> };
    const control = spawnOptions.env.CODEDECK_PTY_CONTROL;

    // The resize happens before anything is listening, exactly as it would
    // while the shim is still starting.
    Object.assign(terminal.stdout, { rows: 30, columns: 100 });
    terminal.stdout.emit("resize");

    const received: string[] = [];
    const server = net.createServer((conn) => {
      conn.on("data", (chunk: Buffer) => received.push(chunk.toString()));
    });
    await new Promise<void>((resolve) => server.listen(control, resolve));

    try {
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 5000 });
    } finally {
      session.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(JSON.parse(received.join(""))).toEqual({ type: "resize", rows: 30, cols: 100 });
  });

  it("survives the EPIPE a dying session raises on the pipe itself", () => {
    const { session, childStdin } = start();

    expect(() => childStdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    session.dispose();
  });
});

// The workflow runs these as `./scripts/<name>.sh`, so a mode that lost its
// executable bit is a red job and nothing else. It has happened once.
describe("gate scripts", () => {
  it.each(["pty-gate.sh", "rename-gate.sh"])("ships %s executable", (name) => {
    const file = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
  });
});
