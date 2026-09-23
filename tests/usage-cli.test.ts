import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUsageQueryParams } from "../src/core/usage-query.js";

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
  vi.useRealTimers();
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("buildUsageQueryParams", () => {
  const now = new Date(2026, 8, 22, 12, 0, 0, 0);

  it("applies all, today, then days precedence", () => {
    expect(buildUsageQueryParams({ all: true, today: true, days: "7" }, "/repo", now).period).toBe("all");
    expect(buildUsageQueryParams({ today: true, days: "7" }, "/repo", now).period).toBe("today");
    expect(buildUsageQueryParams({ days: "7" }, "/repo", now).period).toBe("7d");
  });

  it.each([
    ["3", "3d"],
    ["7", "7d"],
    ["30", "30d"],
  ])("maps %s days to the %s period", (days, period) => {
    expect(buildUsageQueryParams({ days }, "/repo", now).period).toBe(period);
  });

  it("maps other positive day counts to a local-midnight since value", () => {
    const expectedSince = new Date(2026, 8, 18, 0, 0, 0, 0).toISOString();

    expect(buildUsageQueryParams({ days: "5" }, "/repo", now)).toEqual({
      period: undefined,
      since: expectedSince,
      until: undefined,
      repository: undefined,
      model: undefined,
      agent: undefined,
    });
  });

  it("defaults to today when since is absent", () => {
    expect(buildUsageQueryParams({}, "/repo", now).period).toBe("today");
  });

  it("passes through explicit filters and lets current override repo", () => {
    expect(buildUsageQueryParams({
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-20T23:59:59.999Z",
      repo: "/selected/repo",
      current: true,
      model: "gpt-5.6-luna",
      agent: "codex",
    }, "/current/repo", now)).toEqual({
      period: undefined,
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-20T23:59:59.999Z",
      repository: "/current/repo",
      model: "gpt-5.6-luna",
      agent: "codex",
    });
  });
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

  it("sends aggregate filters built with the CLI cwd and current date", async () => {
    request.mockResolvedValue(usageResult);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0, 0));
    vi.spyOn(process, "cwd").mockReturnValue("/current/repo");

    await runProgram([
      "--days", "5",
      "--since", "2026-09-01T00:00:00.000Z",
      "--until", "2026-09-20T23:59:59.999Z",
      "--repo", "/selected/repo",
      "--current",
      "--model", "gpt-5.6-luna",
      "--agent", "codex",
    ]);

    expect(request).toHaveBeenCalledWith("usage.query", {
      period: undefined,
      since: new Date(2026, 8, 18, 0, 0, 0, 0).toISOString(),
      until: "2026-09-20T23:59:59.999Z",
      repository: "/current/repo",
      model: "gpt-5.6-luna",
      agent: "codex",
    });
  });
});
