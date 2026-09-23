import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import { NativeLinkStore } from "../src/store/native-links.js";
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
    expect(result.byOrigin).toEqual([]);
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

  it("includes orchestrator costs and groups open, NULL, and other origins", () => {
    store.create(
      makeSession("open", {
        origin: "open",
        agent: "claude",
        usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 10, cost: 0.7 },
      }),
    );
    store.create(
      makeSession("codex", {
        origin: null,
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 900_000 },
      }),
    );
    store.create(
      makeSession("other-worker", {
        origin: "run",
        agent: "omp",
        usage: { cost: 0.25 },
      }),
    );

    const result = store.queryUsage({ period: "all" });
    const orchestrator = result.byOrigin.find((bucket) => bucket.key === "orchestrator");
    const worker = result.byOrigin.find((bucket) => bucket.key === "worker");

    expect(result.totals.costUsd).toBeCloseTo(1.95, 5);
    expect(result.totals.sessionCount).toBe(3);
    expect(orchestrator).toMatchObject({ sessionCount: 1, costUsd: 0.7 });
    expect(worker).toMatchObject({ sessionCount: 2, costUsd: 1.25 });
  });

  it("merges in-range legacy usage into analytics without listing it as a session", () => {
    const endedAt = new Date(2026, 8, 7, 12).toISOString();
    const outsideRange = new Date(2026, 7, 31, 12).toISOString();
    const insertLegacy = db.getHandle().prepare(`
      INSERT INTO usage_legacy (
        native_id, ended_at, cwd, repository, model, cost,
        input_tokens, output_tokens, cached_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLegacy.run(
      "native-in-range",
      endedAt,
      "/srv/legacy-repo/project",
      "/srv/legacy-repo",
      "claude-sonnet-4-6",
      1.25,
      120,
      30,
      15,
    );
    insertLegacy.run(
      "native-out-of-range",
      outsideRange,
      "/srv/old-repo/project",
      "/srv/old-repo",
      "claude-sonnet-4-6",
      99,
      900,
      90,
      9,
    );

    const result = store.queryUsage({
      since: new Date(2026, 8, 1).toISOString(),
      until: new Date(2026, 8, 30, 23, 59, 59, 999).toISOString(),
    });
    const localDay = `${new Date(endedAt).getFullYear()}-${String(new Date(endedAt).getMonth() + 1).padStart(2, "0")}-${String(new Date(endedAt).getDate()).padStart(2, "0")}`;

    expect(result.totals).toMatchObject({
      sessionCount: 1,
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 15,
      totalTokens: 165,
      costUsd: 1.25,
      costComplete: true,
      sessionsWithoutCost: 0,
    });
    expect(result.byDay[0]).toMatchObject({ key: localDay, sessionCount: 1, costUsd: 1.25 });
    expect(result.byRepository[0]).toMatchObject({ key: "legacy-repo", costUsd: 1.25 });
    expect(result.byModel[0]).toMatchObject({ key: "claude-sonnet-4-6", costUsd: 1.25 });
    expect(result.byAgent[0]).toMatchObject({ key: "claude", costUsd: 1.25 });
    expect(result.byOrigin).toMatchObject([
      { key: "orchestrator", sessionCount: 1, costUsd: 1.25 },
    ]);
    expect(result.byRun).toEqual([]);
    expect(store.list(50, true)).toEqual([]);
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

  it.each(["missing", "no-price"] as const)(
    "marks an open row with a %s native link as missing cost",
    (state) => {
      const sessionId = `open-${state}`;
      store.create(
        makeSession(sessionId, {
          origin: "open",
          agent: "claude",
          model: "claude-sonnet-4-6",
        }),
      );
      const nativeLinks = new NativeLinkStore(db.getHandle());
      nativeLinks.link(sessionId, `native-${state}`);
      nativeLinks.markReconciled(sessionId, `native-${state}`, state);

      const result = store.queryUsage({ period: "all" });

      expect(result.totals).toMatchObject({ costComplete: false, sessionsWithoutCost: 1 });
      expect(result.byOrigin).toMatchObject([
        { key: "orchestrator", costComplete: false },
      ]);
    },
  );

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
