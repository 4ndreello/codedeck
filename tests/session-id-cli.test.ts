import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();

vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = vi.fn(async () => {});
    request = request;
    subscribe = vi.fn(() => () => {});
  },
}));

import { formatPsJson, registerPsCommand, renderPsTable } from "../src/cli/commands/ps.js";
import { registerRunCommand } from "../src/cli/commands/run.js";
import { formatShowJson, registerShowCommand } from "../src/cli/commands/show.js";
import { formatWaitResult, registerWaitCommand } from "../src/cli/commands/wait.js";
import type { Session } from "../src/core/session.js";

const SESSION_ID = "abcd1234567890ef";
const originalConfigDir = process.env.CODEDECK_CONFIG_DIR;
const originalExitCode = process.exitCode;
let configDir: string;
let logs: string[];
let errors: string[];

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function session(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: SESSION_ID,
    agent: "opencode",
    status: "completed",
    cwd: "/tmp",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runCommand(register: (program: Command) => void, name: string, args: string[]) {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program.parseAsync(["node", "codedeck", name, ...args], { from: "node" });
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-cli-config-"));
  fs.writeFileSync(path.join(configDir, "config.json"), "{}", "utf-8");
  process.env.CODEDECK_CONFIG_DIR = configDir;
  process.exitCode = undefined;
  request.mockReset().mockResolvedValue({ session: session(), events: [], eventCount: 0 });
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new CliExit(code ?? 0);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  if (originalConfigDir === undefined) delete process.env.CODEDECK_CONFIG_DIR;
  else process.env.CODEDECK_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("session ID CLI output", () => {
  it("shortens ps, run, show, and wait text while preserving full JSON IDs", async () => {
    const row = session();
    expect(renderPsTable([row])).toContain("abcd1234");
    expect(renderPsTable([row])).not.toContain(SESSION_ID);
    expect(JSON.parse(formatPsJson([row]))[0].id).toBe(SESSION_ID);
    expect(formatWaitResult(row)).toBe("✓ Session abcd1234 completed");
    expect(JSON.parse(formatShowJson({ session: row })).session.id).toBe(SESSION_ID);

    request.mockResolvedValue({ session: row, events: [], eventCount: 0 });
    await runCommand(registerShowCommand, "show", [SESSION_ID]);
    expect(logs[0]).toBe("Session       abcd1234");

    logs = [];
    await runCommand(registerWaitCommand, "wait", [SESSION_ID]);
    expect(logs).toEqual(["✓ Session abcd1234 completed"]);

    logs = [];
    await expect(runCommand(registerRunCommand, "run", ["task", "--agent", "opencode", "--bg"]))
      .rejects.toMatchObject({ code: 0 });
    expect(logs.join("\n")).toContain("Session abcd1234 created");
    expect(logs.join("\n")).toMatch(/Use: .* logs abcd1234 --follow/);
    expect(logs.join("\n")).not.toContain(SESSION_ID);

    logs = [];
    await expect(runCommand(registerRunCommand, "run", ["task", "--agent", "opencode", "--bg", "--json"]))
      .rejects.toMatchObject({ code: 0 });
    expect(JSON.parse(logs[0]!).id).toBe(SESSION_ID);
  });

  it("uses the eight-character ID in run detach instructions", async () => {
    vi.useFakeTimers();
    const processOn = vi.spyOn(process, "on");
    let sigintListener: (() => void) | undefined;
    request.mockResolvedValue({ session: session(), events: [], eventCount: 0 });

    try {
      await runCommand(registerRunCommand, "run", ["task", "--agent", "opencode", "--no-worktree"]);
      sigintListener = processOn.mock.calls.find(([event]) => event === "SIGINT")?.[1] as (() => void) | undefined;

      expect(sigintListener).toBeDefined();
      expect(() => sigintListener?.()).toThrow("exit 0");
      expect(logs.join("\n")).toMatch(/Run: .* logs abcd1234 --follow  to reattach/);
      expect(logs.join("\n")).toMatch(/stop abcd1234\s+to stop/);
    } finally {
      if (sigintListener) process.removeListener("SIGINT", sigintListener);
      processOn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("prints SESSION_AMBIGUOUS and exits like SESSION_NOT_FOUND", async () => {
    const message = 'Ambiguous session ID "dead". Matches: dead000000000001, dead000000000002';
    for (const code of ["SESSION_NOT_FOUND", "SESSION_AMBIGUOUS"]) {
      request.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
      await expect(runCommand(registerShowCommand, "show", ["dead"])).rejects.toMatchObject({ code: 1 });
      expect(errors.at(-1)).toBe(message);
    }

    for (const code of ["SESSION_NOT_FOUND", "SESSION_AMBIGUOUS"]) {
      request.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
      await runCommand(registerWaitCommand, "wait", ["dead"]);
      expect(errors.at(-1)).toBe(message);
      expect(process.exitCode).toBe(3);
      process.exitCode = undefined;
    }
  });
});
