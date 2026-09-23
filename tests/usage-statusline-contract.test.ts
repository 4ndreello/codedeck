import { describe, expect, it } from "vitest";
import { formatUsageSummary } from "../src/cli/commands/usage.js";
import type { RunUsageSummary } from "../src/core/run-usage.js";

describe("usage statusline contract", () => {
  it("keeps worker and orchestrator totalTokens in the statusline summary contract", () => {
    const summary: RunUsageSummary = {
      runId: "run-test-123",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      totalTokens: 1500,
      costUsd: 0.15,
      sessionCount: 1,
      activeSessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
      orchestrator: {
        costUsd: 0.05,
        costComplete: true,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 25,
        totalTokens: 175,
        sources: [],
      },
      total: { costUsd: 0.2 },
    };

    const keys = Object.keys(summary).sort();
    const expectedKeys = [
      "activeSessionCount",
      "cachedTokens",
      "costComplete",
      "costUsd",
      "inputTokens",
      "outputTokens",
      "orchestrator",
      "runId",
      "sessionCount",
      "sessionsWithoutCost",
      "total",
      "totalTokens",
    ].sort();

    expect(keys).toEqual(expectedKeys);
    expect(summary.totalTokens).toBe(1500);
    expect(summary.orchestrator.totalTokens).toBe(175);
  });

  it("formats legacy summary string with cost and tokens", () => {
    const summary: RunUsageSummary = {
      runId: "run-xyz",
      inputTokens: 1200,
      outputTokens: 800,
      cachedTokens: 300,
      totalTokens: 2000,
      costUsd: 0.42,
      sessionCount: 2,
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
      total: { costUsd: 0.42 },
    };

    const text = formatUsageSummary(summary);
    expect(text).toBe("Run run-xyz: 2 sessions, 1200 input / 800 output / 300 cached tokens, cost $0.42");
  });

  it("adds question mark suffix to cost when cost is incomplete", () => {
    const summary: RunUsageSummary = {
      runId: "run-xyz",
      inputTokens: 1200,
      outputTokens: 800,
      cachedTokens: 300,
      totalTokens: 2000,
      costUsd: 0.42,
      sessionCount: 2,
      activeSessionCount: 0,
      costComplete: false,
      sessionsWithoutCost: 1,
      orchestrator: {
        costUsd: 0,
        costComplete: true,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        sources: [],
      },
      total: { costUsd: 0.42 },
    };

    const text = formatUsageSummary(summary);
    expect(text).toBe("Run run-xyz: 2 sessions, 1200 input / 800 output / 300 cached tokens, cost $0.42?");
  });
});
