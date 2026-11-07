import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonSocketPath } from "../src/config/paths.js";
import {
  findLocalBinary,
  resolveCommand,
  spawnTarget,
  unwrapCmdShim,
  type CommandFs,
} from "../src/utils/command.js";

// In-memory Windows filesystem: paths compare case-insensitively, as on NTFS.
function winFs(files: Record<string, string>): CommandFs {
  const table = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return {
    statSync: ((p: string) => {
      if (!table.has(String(p).toLowerCase())) throw missing(String(p));
      return { isFile: () => true };
    }) as unknown as CommandFs["statSync"],
    accessSync: (() => {}) as CommandFs["accessSync"],
    existsSync: ((p: string) => table.has(String(p).toLowerCase())) as CommandFs["existsSync"],
    readFileSync: ((p: string) => {
      const v = table.get(String(p).toLowerCase());
      if (v === undefined) throw missing(String(p));
      return v;
    }) as unknown as CommandFs["readFileSync"],
  };
}

const NPM = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const CLAUDE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;
const CLI_JS = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

function windows(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  return {
    platform: "win32" as const,
    cwd: "C:\\work\\repo",
    env: { Path: `C:\\Windows\\System32;${NPM};C:\\Users\\dev\\.local\\bin`, PATHEXT: ".COM;.EXE;.BAT;.CMD", ...env },
    fs: winFs(files),
  };
}

describe("resolveCommand on Windows", () => {
  it("finds an npm .cmd shim through PATHEXT and skips the extensionless POSIX shim", () => {
    const opts = windows({ [`${NPM}\\claude`]: "#!/bin/sh", [`${NPM}\\claude.cmd`]: CLAUDE_SHIM });
    expect(resolveCommand("claude", opts)).toBe(`${NPM}\\claude.cmd`);
  });

  it("prefers .exe over .cmd in the same directory, in PATHEXT order", () => {
    const opts = windows({ [`${NPM}\\grok.cmd`]: "", [`${NPM}\\grok.exe`]: "" });
    expect(resolveCommand("grok", opts)).toBe(`${NPM}\\grok.exe`);
  });

  it("reads Path case-insensitively and falls back to the default PATHEXT", () => {
    const opts = windows({ "C:\\Users\\dev\\.local\\bin\\agy.exe": "" }, { PATHEXT: undefined });
    expect(resolveCommand("agy", opts)).toBe("C:\\Users\\dev\\.local\\bin\\agy.exe");
  });

  it("does not search the current directory", () => {
    const opts = windows({ "C:\\work\\repo\\claude.cmd": "" });
    expect(resolveCommand("claude", opts)).toBeUndefined();
  });

  it("returns undefined when nothing on PATH matches", () => {
    expect(resolveCommand("codex", windows({}))).toBeUndefined();
  });

  it("resolves an installer location with its .exe spelling", () => {
    const opts = windows({ "C:\\Users\\dev\\.local\\bin\\agy.exe": "" });
    expect(findLocalBinary("C:\\Users\\dev\\.local\\bin\\agy", opts)).toBe("C:\\Users\\dev\\.local\\bin\\agy.exe");
  });
});

describe("spawnTarget on Windows", () => {
  it("runs an npm shim's JS entry with node instead of going through cmd.exe", () => {
    const opts = windows({ [`${NPM}\\claude.cmd`]: CLAUDE_SHIM, [CLI_JS]: "" });
    expect(spawnTarget("claude", ["-p", "line one\nline two"], opts)).toEqual({
      cmd: process.execPath,
      args: [CLI_JS, "-p", "line one\nline two"],
    });
  });

  it("uses the node.exe that sits next to the shim when there is one", () => {
    const opts = windows({ [`${NPM}\\claude.cmd`]: CLAUDE_SHIM, [CLI_JS]: "", [`${NPM}\\node.exe`]: "" });
    expect(spawnTarget("claude", [], opts).cmd).toBe(`${NPM}\\node.exe`);
  });

  it("runs a shim that points at a native binary directly", () => {
    const exe = `${NPM}\\node_modules\\@vibe-kit\\grok-cli\\bin\\grok.exe`;
    const shim = `"%dp0%\\node_modules\\@vibe-kit\\grok-cli\\bin\\grok.exe"   %*\r\n`;
    const opts = windows({ [`${NPM}\\grok.cmd`]: shim, [exe]: "" });
    expect(spawnTarget("grok", ["--version"], opts)).toEqual({ cmd: exe, args: ["--version"] });
  });

  it("falls back to cmd.exe with escaped arguments for a batch file it cannot unwrap", () => {
    const opts = windows({ "C:\\tools\\agy.bat": "@echo off\r\nmise x -- agy %*" }, {
      Path: "C:\\tools",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    });
    const target = spawnTarget("agy", ["a b", 'say "hi" & exit'], opts);
    expect(target.cmd).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(target.args[3]).toBe('"C:\\tools\\agy.bat ^"a^ b^" ^"say^ \\^"hi\\^"^ ^&^ exit^""');
  });

  it("passes a resolved .exe straight through", () => {
    const opts = windows({ "C:\\Users\\dev\\.local\\bin\\claude.exe": "" });
    expect(spawnTarget("claude", ["-p"], opts)).toEqual({
      cmd: "C:\\Users\\dev\\.local\\bin\\claude.exe",
      args: ["-p"],
    });
  });

  it("leaves an unparseable shim to cmd.exe", () => {
    expect(unwrapCmdShim(`${NPM}\\x.cmd`, windows({ [`${NPM}\\x.cmd`]: "@echo off" }))).toBeUndefined();
  });
});

describe("resolveCommand on POSIX", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds an executable on PATH and ignores a non-executable file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-which-"));
    const bin = path.join(dir, "bin");
    const other = path.join(dir, "other");
    fs.mkdirSync(bin);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "claude"), "", { mode: 0o644 });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const env = { PATH: `${other}${path.delimiter}${bin}` };
    expect(resolveCommand("claude", { platform: "linux", env })).toBe(path.join(bin, "claude"));
    expect(resolveCommand("missing", { platform: "linux", env })).toBeUndefined();
  });

  it("passes the command through unchanged", () => {
    expect(spawnTarget("claude", ["-p"], { platform: "linux" })).toEqual({ cmd: "claude", args: ["-p"] });
  });
});

describe("daemonSocketPath", () => {
  it("keeps the socket file on POSIX", () => {
    expect(daemonSocketPath("/home/dev/.codedeck", "linux")).toBe(path.join("/home/dev/.codedeck", "daemon.sock"));
  });

  it("uses a named pipe derived from the data dir on Windows", () => {
    const a = daemonSocketPath("C:\\Users\\dev\\.codedeck", "win32");
    expect(a).toMatch(/^\\\\\.\\pipe\\codedeck-[0-9a-f]{16}$/);
    expect(daemonSocketPath("c:\\users\\dev\\.codedeck", "win32")).toBe(a);
    expect(daemonSocketPath("D:\\other", "win32")).not.toBe(a);
  });
});
