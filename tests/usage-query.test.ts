import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import type { Session } from "../src/core/session.js";

let tmpDir: string;
let dbPath: string;
let db: Database;
let store: SessionStore;

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  const ts = overrides.createdAt ?? new Date("2026-09-07T12:00:00.000Z");
  return {
    id,
    runId: "run-1",
    agent: "codex",
    status: "completed",
    cwd: "/home/user/project-a",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-query-"));
  dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  store = new SessionStore(db.getHandle());
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionStore.queryUsage", () => {
  it("returns zeroed metrics for an empty database", () => {
    const result = store.queryUsage({ period: "all" });
    expect(result.totals.sessionCount).toBe(0);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.totals.costUsd).toBe(0);
    expect(result.totals.costComplete).toBe(true);
    expect(result.byDay).toEqual([]);
    expect(result.byRepository).toEqual([]);
  });

  it("aggregates tokens, calculated costs, and reported costs accurately", () => {
    // Session with static pricing model (gpt-5.6-luna: input 1, output 5)
    store.create(
      makeSession("s1", {
        agent: "codex",
        model: "gpt-5.6-luna",
        repository: "/dev/codedeck",
        usage: { inputTokens: 1_000_000, outputTokens: 200_000, cachedTokens: 0 },
      }),
    );

    // Session with reported cost (Claude)
    store.create(
      makeSession("s2", {
        agent: "claude",
        model: "claude-sonnet-4-6",
        repository: "/dev/codedeck",
        usage: { inputTokens: 50_000, outputTokens: 10_000, cachedTokens: 0, cost: 0.45 },
      }),
    );

    const result = store.queryUsage({ period: "all" });
    expect(result.totals.sessionCount).toBe(2);
    expect(result.totals.inputTokens).toBe(1_050_000);
    expect(result.totals.outputTokens).toBe(210_000);
    // Cost: (1M * 1 + 200k * 5)/1M = $2.00 + $0.45 = $2.45
    expect(result.totals.costUsd).toBeCloseTo(2.45, 2);
    expect(result.totals.costComplete).toBe(true);

    // Breakdown by Agent
    expect(result.byAgent.length).toBe(2);
    const codex = result.byAgent.find((a) => a.key === "codex");
    const claude = result.byAgent.find((a) => a.key === "claude");
    expect(codex?.costUsd).toBeCloseTo(2.0, 2);
    expect(claude?.costUsd).toBeCloseTo(0.45, 2);

    // Breakdown by Repo
    expect(result.byRepository.length).toBe(1);
    expect(result.byRepository[0].key).toBe("codedeck");
    expect(result.byRepository[0].sessionCount).toBe(2);
  });

  it("marks costComplete as false when encountering unpriced models without reported cost", () => {
    store.create(
      makeSession("s-unknown", {
        model: "unknown-experimental-model",
        usage: { inputTokens: 100_000, outputTokens: 50_000 },
      }),
    );

    const result = store.queryUsage({ period: "all" });
    expect(result.totals.costComplete).toBe(false);
    expect(result.totals.sessionsWithoutCost).toBe(1);
  });

  it("filters correctly by repository substring", () => {
    store.create(makeSession("s1", { repository: "/dev/frontend" }));
    store.create(makeSession("s2", { repository: "/dev/backend" }));

    const result = store.queryUsage({ period: "all", repository: "frontend" });
    expect(result.totals.sessionCount).toBe(1);
    expect(result.byRepository[0].key).toBe("frontend");
  });

  it("supports readOnly database instantiation without running migrations", () => {
    db.close();
    const readOnlyDb = new Database(dbPath, { readOnly: true });
    const roStore = new SessionStore(readOnlyDb.getHandle());
    const result = roStore.queryUsage({ period: "all" });
    expect(result.totals.sessionCount).toBe(0);
    readOnlyDb.close();
  });
});
