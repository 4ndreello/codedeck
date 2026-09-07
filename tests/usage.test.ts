import { describe, expect, it } from "vitest";
import type { Session } from "../src/core/session.js";
import { aggregateRunUsage } from "../src/core/run-usage.js";

const timestamp = new Date("2026-09-06T00:00:00.000Z");

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    runId: "run-example",
    agent: "codex",
    status: "completed",
    cwd: "/tmp",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("aggregateRunUsage", () => {
  it("sums persisted tokens across sessions", () => {
    expect(aggregateRunUsage("run-example", [
      makeSession("s1", {
        usage: { inputTokens: 1_200, outputTokens: 800, cachedTokens: 300, cost: 0.42 },
      }),
      makeSession("s2", {
        usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 20, cost: 0.08 },
      }),
    ])).toEqual({
      runId: "run-example",
      inputTokens: 1_300,
      outputTokens: 850,
      cachedTokens: 320,
      costUsd: 0.5,
      sessionCount: 2,
      costComplete: true,
      sessionsWithoutCost: 0,
    });
  });

  it("sums known costs and counts sessions without a known cost", () => {
    expect(
      aggregateRunUsage("run-example", [
        makeSession("reported", {
          model: "model-not-in-static-table",
          usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 10, cost: 0.42 },
        }),
        makeSession("unknown", {
          model: "model-not-in-static-table",
          usage: { inputTokens: 200, outputTokens: 100, cachedTokens: 20 },
        }),
      ]),
    ).toEqual({
      runId: "run-example",
      inputTokens: 300,
      outputTokens: 150,
      cachedTokens: 30,
      costUsd: 0.42,
      sessionCount: 2,
      costComplete: false,
      sessionsWithoutCost: 1,
    });
  });

  it("marks every known cost complete, including a reported zero", () => {
    expect(
      aggregateRunUsage("run-example", [
        makeSession("zero", {
          model: "model-not-in-static-table",
          usage: { cost: 0 },
        }),
        makeSession("calculated", {
          model: "gpt-5.6-luna",
          usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
        }),
      ]),
    ).toMatchObject({
      costUsd: 3.5,
      sessionCount: 2,
      costComplete: true,
      sessionsWithoutCost: 0,
    });
  });

  it("counts each session id once and keeps the latest value", () => {
    expect(
      aggregateRunUsage("run-example", [
        makeSession("same", { usage: { inputTokens: 10, cost: 0.01 } }),
        makeSession("same", { usage: { inputTokens: 20, cost: 0.02 } }),
      ]),
    ).toMatchObject({
      inputTokens: 20,
      costUsd: 0.02,
      sessionCount: 1,
    });
  });

  it("returns zero totals and a complete cost for an empty run", () => {
    expect(aggregateRunUsage("empty-run", [])).toEqual({
      runId: "empty-run",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      sessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
    });
  });
});
