import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUsageQueryParams } from "../src/core/usage-query.js";
import { normalizeUsageInterval } from "../src/web/usage-page.js";
import type { UsageCommandDependencies } from "../src/cli/commands/usage.js";

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

function runProgramWithDependencies(argv: string[], dependencies: UsageCommandDependencies): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerUsageCommand(program, dependencies);
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

  it("forwards a transcript path containing equals alongside a valid cost observation", async () => {
    request.mockResolvedValue(runSummary);

    await runProgram([
      "run-1",
      "--observe",
      "92d88cce-bdbc-46db-8573-916afd32f6f7=0.125",
      "--transcript",
      "92d88cce-bdbc-46db-8573-916afd32f6f7=/tmp/project=archive/session.jsonl",
      "--json",
    ]);

    expect(request).toHaveBeenCalledWith("usage.get", {
      runId: "run-1",
      observe: { nativeId: "92d88cce-bdbc-46db-8573-916afd32f6f7", costUsd: 0.125 },
      transcript: {
        nativeId: "92d88cce-bdbc-46db-8573-916afd32f6f7",
        path: "/tmp/project=archive/session.jsonl",
      },
    });
    expect(JSON.parse(logs[0]!)).toEqual(runSummary);
  });

  it("forwards a transcript without a cost observation", async () => {
    request.mockResolvedValue(runSummary);

    await runProgram([
      "run-1",
      "--transcript",
      "92d88cce-bdbc-46db-8573-916afd32f6f7=/tmp/session.jsonl",
    ]);

    expect(request).toHaveBeenCalledWith("usage.get", {
      runId: "run-1",
      transcript: {
        nativeId: "92d88cce-bdbc-46db-8573-916afd32f6f7",
        path: "/tmp/session.jsonl",
      },
    });
    expect(logs).toEqual([
      "Run run-1: 1 sessions, 100 input / 20 output / 5 cached tokens, cost $0.25",
    ]);
  });

  it.each([
    ["invalid native id", "not-a-session-id=/tmp/session.jsonl"],
    ["missing equals", "92d88cce-bdbc-46db-8573-916afd32f6f7"],
    ["empty native id", "=/tmp/session.jsonl"],
    ["empty path", "92d88cce-bdbc-46db-8573-916afd32f6f7="],
  ])("ignores a transcript with %s while preserving a valid cost observation and summary", async (_label, transcript) => {
    request.mockResolvedValue(runSummary);

    await runProgram([
      "run-1",
      "--observe",
      "92d88cce-bdbc-46db-8573-916afd32f6f7=0.125",
      "--transcript",
      transcript,
      "--json",
    ]);

    expect(request).toHaveBeenCalledWith("usage.get", {
      runId: "run-1",
      observe: { nativeId: "92d88cce-bdbc-46db-8573-916afd32f6f7", costUsd: 0.125 },
    });
    expect(JSON.parse(logs[0]!)).toEqual(runSummary);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
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

describe("usage web options", () => {
  it("runs backfill before web startup", async () => {
    const backfill = vi.fn(async () => ({ imported: 2, skipped: 1 }));
    const launch = vi.fn(async () => 0);

    await runProgramWithDependencies(["--backfill", "--web"], {
      backfillUsage: backfill,
      launch,
    });

    expect(backfill).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(logs).toEqual(["Usage backfill: imported 2, skipped 1"]);
  });

  it("opens the usage page with the resolved filters, breakdown and interval and no empty keys", async () => {
    const launch = vi.fn(async () => 0);

    await runProgramWithDependencies(["--web", "--today", "--repo", "x", "--by", "model", "--interval", "5"], { launch });

    expect(launch).toHaveBeenCalledWith({
      path: "/usage",
      query: { period: "today", repo: "x", by: "model", interval: "5" },
      title: "CodeDeck usage",
      port: undefined,
      open: true,
    });
  });

  it("forwards a raw polling interval for the page to normalize", async () => {
    const launch = vi.fn(async () => 0);

    await runProgramWithDependencies(["--web", "--interval", "0", "--port", "4200", "--no-open"], { launch });

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ interval: "0" }),
      port: 4200,
      open: false,
    }));
    expect(normalizeUsageInterval("0")).toBe(2);
    expect(normalizeUsageInterval("not-a-number")).toBe(2);
    expect(normalizeUsageInterval("-0.5")).toBe(1);
    expect(normalizeUsageInterval("0.5")).toBe(1);
    expect(normalizeUsageInterval("3")).toBe(3);
  });
});
