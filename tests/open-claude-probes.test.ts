import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/drivers/helpers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/drivers/helpers.js")>();
  return { ...mod, detectBinary: vi.fn() };
});

import { detectBinary } from "../src/drivers/helpers.js";
import { CLAUDE_NOT_FOUND, assertSupport, resolveBinary } from "../src/open/launchers/claude.js";

const mockedDetect = vi.mocked(detectBinary);
const originalEnv = {
  PATH: process.env.PATH,
  RUN_AGENT_DIR: process.env.RUN_AGENT_DIR,
  RUN_AGENT_CONFIG_DIR: process.env.RUN_AGENT_CONFIG_DIR,
};
let root: string;
let binDir: string;
let counterFile: string;
let claudeFile: string;

function writeClaude(kind: "supported" | "unknown" | "unrelated" = "supported"): void {
  const message = kind === "supported"
    ? "error: option --append-system-prompt-file <file> argument missing"
    : kind === "unknown"
      ? "error: unknown option --append-system-prompt-file"
      : "fatal: boom";
  fs.writeFileSync(
    claudeFile,
    `#!/bin/sh\nprintf '%s\\n' run >> '${counterFile}'\nprintf '%s\\n' '${message}' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(claudeFile, 0o755);
}

function runCount(): number {
  if (!fs.existsSync(counterFile)) return 0;
  return fs.readFileSync(counterFile, "utf8").trim().split("\n").length;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-claude-probes-"));
  binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  counterFile = path.join(root, "counter.txt");
  claudeFile = path.join(binDir, "claude");
  process.env.PATH = binDir;
  process.env.RUN_AGENT_DIR = path.join(root, "run-agent");
  process.env.RUN_AGENT_CONFIG_DIR = path.join(root, "config");
  mockedDetect.mockReset();
});

afterEach(() => {
  if (originalEnv.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = originalEnv.PATH;
  if (originalEnv.RUN_AGENT_DIR === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalEnv.RUN_AGENT_DIR;
  if (originalEnv.RUN_AGENT_CONFIG_DIR === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalEnv.RUN_AGENT_CONFIG_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Claude launcher probes", () => {
  it("resolves an executable from PATH without running it and keeps detectBinary as fallback", async () => {
    writeClaude();

    await expect(resolveBinary()).resolves.toBe(claudeFile);
    expect(runCount()).toBe(0);
    expect(mockedDetect).not.toHaveBeenCalled();

    process.env.PATH = path.join(root, "empty-path");
    mockedDetect.mockResolvedValueOnce({ installed: true, path: "/fallback/claude" });
    await expect(resolveBinary()).resolves.toBe("/fallback/claude");
    expect(mockedDetect).toHaveBeenCalledWith("claude");

    mockedDetect.mockResolvedValueOnce({ installed: false });
    await expect(resolveBinary()).rejects.toThrow(CLAUDE_NOT_FOUND);
  });

  it("reuses support for the same realpath, size and mtime", async () => {
    writeClaude();

    await assertSupport(claudeFile, root);
    await assertSupport(claudeFile, root);

    expect(runCount()).toBe(1);
  });

  it("probes again when the binary size changes but its mtime does not", async () => {
    writeClaude();
    await assertSupport(claudeFile, root);
    expect(runCount()).toBe(1);

    const original = fs.readFileSync(claudeFile, "utf8");
    const stat = fs.statSync(claudeFile);
    fs.writeFileSync(claudeFile, `${original}# changed size\n`, { mode: 0o755 });
    fs.chmodSync(claudeFile, 0o755);
    fs.utimesSync(claudeFile, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    expect(fs.statSync(claudeFile).mtimeMs).toBe(stat.mtimeMs);

    await assertSupport(claudeFile, root);
    expect(runCount()).toBe(2);
  });

  it("probes again when the binary mtime changes", async () => {
    writeClaude();
    await assertSupport(claudeFile, root);

    const changedTime = new Date(Date.now() + 5000);
    fs.utimesSync(claudeFile, changedTime, changedTime);
    await assertSupport(claudeFile, root);

    expect(runCount()).toBe(2);
  });

  it("does not record support for unrelated probe failures", async () => {
    writeClaude("unrelated");

    await expect(assertSupport(claudeFile, root)).resolves.toBeUndefined();
    await expect(assertSupport(claudeFile, root)).resolves.toBeUndefined();

    expect(runCount()).toBe(2);
    expect(fs.existsSync(path.join(process.env.RUN_AGENT_DIR!, "claude-support.json"))).toBe(false);
  });

  it("does not cache unknown-option results or ENOENT failures", async () => {
    writeClaude("unknown");

    await expect(assertSupport(claudeFile, root)).rejects.toThrow(/does not support/);
    await expect(assertSupport(claudeFile, root)).rejects.toThrow(/does not support/);
    expect(runCount()).toBe(2);
    expect(fs.existsSync(path.join(process.env.RUN_AGENT_DIR!, "claude-support.json"))).toBe(false);

    fs.writeFileSync(claudeFile, "#!/no/such/codedeck-interpreter\n", { mode: 0o755 });
    fs.chmodSync(claudeFile, 0o755);
    await expect(assertSupport(claudeFile, root)).rejects.toThrow(CLAUDE_NOT_FOUND);
    expect(runCount()).toBe(2);
    await expect(assertSupport(claudeFile, root)).rejects.toThrow(CLAUDE_NOT_FOUND);
    expect(fs.existsSync(path.join(process.env.RUN_AGENT_DIR!, "claude-support.json"))).toBe(false);

    writeClaude("supported");
    await assertSupport(claudeFile, root);
    expect(runCount()).toBe(3);
  });
});
