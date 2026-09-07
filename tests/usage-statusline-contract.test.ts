import { describe, expect, it } from "vitest";
import { formatUsageSummary } from "../src/cli/commands/usage.js";
import type { RunUsageSummary } from "../src/core/run-usage.js";

describe("usage statusline contract", () => {
  it("ensures RunUsageSummary preserves the 9 contract keys required by statusline.sh", () => {
    const summary: RunUsageSummary = {
      runId: "run-test-123",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      costUsd: 0.15,
      sessionCount: 1,
      activeSessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
    };

    const keys = Object.keys(summary).sort();
    const expectedKeys = [
      "activeSessionCount",
      "cachedTokens",
      "costComplete",
      "costUsd",
      "inputTokens",
      "outputTokens",
      "runId",
      "sessionCount",
      "sessionsWithoutCost",
    ].sort();

    expect(keys).toEqual(expectedKeys);
  });

  it("formats legacy summary string with cost and tokens", () => {
    const summary: RunUsageSummary = {
      runId: "run-xyz",
      inputTokens: 1200,
      outputTokens: 800,
      cachedTokens: 300,
      costUsd: 0.42,
      sessionCount: 2,
      activeSessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
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
      costUsd: 0.42,
      sessionCount: 2,
      activeSessionCount: 0,
      costComplete: false,
      sessionsWithoutCost: 1,
    };

    const text = formatUsageSummary(summary);
    expect(text).toBe("Run run-xyz: 2 sessions, 1200 input / 800 output / 300 cached tokens, cost $0.42?");
  });
});
