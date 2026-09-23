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
      total: { costUsd: 0.5 },
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
      activeSessionCount: 0,
      costComplete: false,
      sessionsWithoutCost: 1,
      orchestrator: {
        costUsd: 0,
        costComplete: true,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        sources: [],
      },
      total: { costUsd: 0.42 },
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
      activeSessionCount: 0,
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
      activeSessionCount: 0,
    });
  });

  it("counts only non-terminal sessions as active", () => {
    expect(
      aggregateRunUsage("run-example", [
        makeSession("starting", { status: "starting" }),
        makeSession("working", { status: "working" }),
        makeSession("needs-input", { status: "needs_input" }),
        makeSession("idle", { status: "idle" }),
        makeSession("completed", { status: "completed" }),
        makeSession("failed", { status: "failed" }),
        makeSession("stopped", { status: "stopped" }),
        makeSession("orphaned", { status: "orphaned" }),
        makeSession("interrupted", { status: "interrupted" }),
      ]),
    ).toMatchObject({
      sessionCount: 9,
      activeSessionCount: 4,
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
      total: { costUsd: 0 },
    });
  });

  it("splits worker and orchestrator usage and groups source costs", () => {
    expect(
      aggregateRunUsage(
        "r1",
        [
          makeSession("open", {
            origin: "open",
            agent: "claude",
            usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 3, cost: 3.8 },
          }),
          makeSession("worker-1", { origin: null, usage: { cost: 0.3 } }),
          makeSession("worker-2", { usage: { cost: 0.2 } }),
        ],
        [
          { sessionId: "open", sourceKey: "claude-open:X", cost: 3 },
          { sessionId: "open", sourceKey: "claude-open:Y", cost: 0.5 },
          { sessionId: "open", sourceKey: "claude-open:Y", cost: 0.3 },
          { sessionId: "worker-1", sourceKey: "codex:worker", cost: 10 },
        ],
      ),
    ).toEqual({
      runId: "r1",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0.5,
      sessionCount: 2,
      activeSessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
      orchestrator: {
        costUsd: 3.8,
        costComplete: true,
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 3,
        sources: [
          { nativeId: "X", costUsd: 3 },
          { nativeId: "Y", costUsd: 0.8 },
        ],
      },
      total: { costUsd: 4.3 },
    });
  });

  it("keeps an open-only run complete for workers when orchestrator links are incomplete", () => {
    for (const state of ["missing", "no-price"]) {
      const summary = aggregateRunUsage(
        "open-only",
        [makeSession("open", { origin: "open", usage: { cost: 0.25 } })],
        [],
        [{ sessionId: "open", state }],
      );

      expect(summary).toMatchObject({
        costUsd: 0,
        sessionCount: 0,
        costComplete: true,
        sessionsWithoutCost: 0,
        orchestrator: { costUsd: 0.25, costComplete: false },
        total: { costUsd: 0.25 },
      });
    }
  });

  it("marks an open row without a calculable cost incomplete", () => {
    const summary = aggregateRunUsage("open-only", [
      makeSession("open", { origin: "open", model: "unknown-model" }),
    ]);

    expect(summary).toMatchObject({
      costUsd: 0,
      sessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
      orchestrator: { costComplete: false },
    });
  });

  it("prices Codex cached tokens once", () => {
    const summary = aggregateRunUsage("codex-run", [
      makeSession("codex", {
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 900_000 },
      }),
    ]);

    expect(summary.costUsd).toBe(1);
    expect(summary.total.costUsd).toBe(1);
    expect(summary.costComplete).toBe(true);
  });
});
