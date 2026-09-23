import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureDaemonStarted = vi.fn(async () => {});
const request = vi.fn();

vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = ensureDaemonStarted;
    request = request;
  },
}));

const { registerUsageCommand } = await import("../src/cli/commands/usage.js");

const runSummary = {
  runId: "run-1",
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 5,
  totalTokens: 125,
  costUsd: 0.25,
  sessionCount: 1,
  activeSessionCount: 0,
  costComplete: true,
  sessionsWithoutCost: 0,
  orchestrator: {
    costUsd: 0,
    costComplete: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    sources: [],
  },
  total: { costUsd: 0.25 },
};

const usageResult = {
  range: { period: "all", since: "2026-09-01T00:00:00.000Z", until: "2026-09-30T23:59:59.999Z" },
  totals: {
    sessionCount: 1,
    activeSessionCount: 0,
    completedSessionCount: 1,
    failedSessionCount: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 5,
    totalTokens: 125,
    costUsd: 0.25,
    costComplete: true,
    sessionsWithoutCost: 0,
  },
  byDay: [],
  byRepository: [],
  byModel: [],
  byAgent: [],
  byRun: [],
  byOrigin: [{ key: "orchestrator", sessionCount: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0.25, costComplete: true }],
};

let logs: string[];
let errors: string[];
const originalExitCode = process.exitCode;

function runProgram(argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerUsageCommand(program);
  return program.parseAsync(["node", "codedeck", "usage", ...argv], { from: "node" });
}

beforeEach(() => {
  process.exitCode = undefined;
  logs = [];
  errors = [];
  ensureDaemonStarted.mockClear();
  request.mockReset();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.join(" ")));
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("usage CLI", () => {
  it("sends a valid native id and finite non-negative cost as an observation", async () => {
    request.mockResolvedValue(runSummary);

    await runProgram(["run-1", "--observe", "92d88cce-bdbc-46db-8573-916afd32f6f7=0.125", "--json"]);

    expect(request).toHaveBeenCalledWith("usage.get", {
      runId: "run-1",
      observe: { nativeId: "92d88cce-bdbc-46db-8573-916afd32f6f7", costUsd: 0.125 },
    });
    expect(JSON.parse(logs[0]!)).toEqual(runSummary);
  });

  it.each([
    ["malformed", "not-a-session-id=0.5"],
    ["negative", "92d88cce-bdbc-46db-8573-916afd32f6f7=-0.01"],
    ["non-finite", "92d88cce-bdbc-46db-8573-916afd32f6f7=Infinity"],
    ["empty cost", "92d88cce-bdbc-46db-8573-916afd32f6f7="],
  ])("ignores a %s observation and still prints the run aggregate", async (_label, value) => {
    request.mockResolvedValue(runSummary);

    await runProgram(["run-1", "--observe", value]);

    expect(request).toHaveBeenCalledWith("usage.get", { runId: "run-1" });
    expect(logs).toEqual([
      "Run run-1: 1 sessions, 100 input / 20 output / 5 cached tokens, cost $0.25",
    ]);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the byOrigin buckets in the JSON response", async () => {
    request.mockResolvedValue(usageResult);

    await runProgram(["--all", "--by", "origin", "--json"]);

    expect(JSON.parse(logs[0]!).byOrigin).toEqual(usageResult.byOrigin);
  });

  it("renders the byOrigin buckets when --by origin is used", async () => {
    request.mockResolvedValue(usageResult);

    await runProgram(["--all", "--by", "origin", "--plain"]);

    expect(logs[0]).toContain("Usage by origin");
    expect(logs[0]).toContain("orchestrator: 1 sessions");
    expect(logs[0]).toContain("cost $0.25");
  });
});
