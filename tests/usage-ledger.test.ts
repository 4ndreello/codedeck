import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { UsageLedger } from "../src/store/usage-ledger.js";
import { SessionStore } from "../src/store/sessions.js";
import type { Session } from "../src/core/session.js";

interface UsageRow {
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cached_tokens: number | null;
  usage_cost: number | null;
}

interface SourceRow {
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
}

interface CostInvariantRow {
  source_key: string;
  cost: number | null;
  attributed_cost: number | null;
}

function withLedger(fn: (db: Database, ledger: UsageLedger, sessions: SessionStore) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-ledger-"));
  const db = new Database(path.join(dir, "test.db"));
  const handle = db.getHandle();
  const ledger = new UsageLedger(handle);
  const sessions = new SessionStore(handle);
  try {
    fn(db, ledger, sessions);
    expectCostInvariants(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function expectCostInvariants(db: Database): void {
  const rows = db.getHandle().prepare(`
    SELECT sources.source_key, sources.cost, SUM(attributions.cost) AS attributed_cost
    FROM usage_sources AS sources
    LEFT JOIN usage_attributions AS attributions ON attributions.source_key = sources.source_key
    GROUP BY sources.source_key, sources.cost
    ORDER BY sources.source_key
  `).all() as unknown as CostInvariantRow[];
  for (const row of rows) {
    expect(row.attributed_cost, `cost attribution for ${row.source_key}`).toBe(row.cost);
  }
}

function makeSession(id: string, cwd: string, usage?: Session["usage"]): Session {
  const now = new Date("2026-09-22T12:00:00.000Z");
  return {
    id,
    agent: "claude",
    status: "working",
    cwd,
    usage,
    createdAt: now,
    updatedAt: now,
  };
}

function usageFor(db: Database, sessionId: string): UsageRow {
  return db.getHandle().prepare(`
    SELECT usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_cost
    FROM sessions WHERE id = ?
  `).get(sessionId) as UsageRow;
}

function sourceFor(db: Database, sourceKey: string): SourceRow {
  return db.getHandle().prepare(`
    SELECT cost, input_tokens, output_tokens, cached_tokens
    FROM usage_sources WHERE source_key = ?
  `).get(sourceKey) as SourceRow;
}

describe("UsageLedger", () => {
  it("replays the six high-water steps and keeps the source total across rows", () => {
    withLedger((db, ledger, sessions) => {
      sessions.create(makeSession("A", "/tmp"));
      sessions.create(makeSession("B", "/tmp"));

      expect(ledger.observe("A", "X", {
        cost: 4,
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 5,
      })).toBe(true);
      expect(sourceFor(db, "X")).toEqual({
        cost: 4,
        input_tokens: 100,
        output_tokens: 10,
        cached_tokens: 5,
      });
      expect(ledger.attributionsFor(["A", "B"])).toEqual([{
        sessionId: "A",
        sourceKey: "X",
        cost: 4,
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 5,
      }]);
      expect(usageFor(db, "A")).toEqual({
        usage_input_tokens: 100,
        usage_output_tokens: 10,
        usage_cached_tokens: 5,
        usage_cost: 4,
      });

      const beforeLower = {
        source: sourceFor(db, "X"),
        attributions: ledger.attributionsFor(["A", "B"]),
        usageA: usageFor(db, "A"),
        usageB: usageFor(db, "B"),
      };
      expect(ledger.observe("A", "X", {
        cost: 3.5,
        inputTokens: 99,
        outputTokens: 9,
        cachedTokens: 4,
      })).toBe(false);
      expect({
        source: sourceFor(db, "X"),
        attributions: ledger.attributionsFor(["A", "B"]),
        usageA: usageFor(db, "A"),
        usageB: usageFor(db, "B"),
      }).toEqual(beforeLower);

      expect(ledger.observe("A", "X", {
        cost: 10,
        inputTokens: 500,
        outputTokens: 50,
        cachedTokens: 25,
      })).toBe(true);
      expect(ledger.attributionsFor(["A"])).toEqual([{
        sessionId: "A",
        sourceKey: "X",
        cost: 10,
        inputTokens: 500,
        outputTokens: 50,
        cachedTokens: 25,
      }]);
      expect(usageFor(db, "A")).toEqual({
        usage_input_tokens: 500,
        usage_output_tokens: 50,
        usage_cached_tokens: 25,
        usage_cost: 10,
      });

      expect(ledger.observe("B", "X", {
        cost: 10,
        inputTokens: 500,
        outputTokens: 50,
        cachedTokens: 25,
      })).toBe(false);
      expect(ledger.attributionsFor(["B"])).toEqual([]);
      expect(usageFor(db, "B")).toEqual({
        usage_input_tokens: null,
        usage_output_tokens: null,
        usage_cached_tokens: null,
        usage_cost: null,
      });

      expect(ledger.observe("B", "X", {
        cost: 12,
        inputTokens: 600,
        outputTokens: 60,
        cachedTokens: 30,
      })).toBe(true);
      expect(ledger.attributionsFor(["A", "B"])).toEqual([
        {
          sessionId: "A",
          sourceKey: "X",
          cost: 10,
          inputTokens: 500,
          outputTokens: 50,
          cachedTokens: 25,
        },
        {
          sessionId: "B",
          sourceKey: "X",
          cost: 2,
          inputTokens: 100,
          outputTokens: 10,
          cachedTokens: 5,
        },
      ]);
      expect(usageFor(db, "B")).toEqual({
        usage_input_tokens: 100,
        usage_output_tokens: 10,
        usage_cached_tokens: 5,
        usage_cost: 2,
      });

      expect(ledger.observe("B", "X", {
        cost: 15,
        inputTokens: 750,
        outputTokens: 75,
        cachedTokens: 35,
      })).toBe(true);
      expect(sourceFor(db, "X")).toEqual({
        cost: 15,
        input_tokens: 750,
        output_tokens: 75,
        cached_tokens: 35,
      });
      expect(ledger.attributionsFor(["A", "B"])).toEqual([
        {
          sessionId: "A",
          sourceKey: "X",
          cost: 10,
          inputTokens: 500,
          outputTokens: 50,
          cachedTokens: 25,
        },
        {
          sessionId: "B",
          sourceKey: "X",
          cost: 5,
          inputTokens: 250,
          outputTokens: 25,
          cachedTokens: 10,
        },
      ]);
      expect(usageFor(db, "A")).toEqual({
        usage_input_tokens: 500,
        usage_output_tokens: 50,
        usage_cached_tokens: 25,
        usage_cost: 10,
      });
      expect(usageFor(db, "B")).toEqual({
        usage_input_tokens: 250,
        usage_output_tokens: 25,
        usage_cached_tokens: 10,
        usage_cost: 5,
      });

      const total = ledger.attributionsFor(["A", "B"])
        .reduce((sum, attribution) => sum + (attribution.cost ?? 0), 0);
      expect(total).toBe(sourceFor(db, "X").cost);
      expect(ledger.hasSource("X")).toBe(true);
      expect(ledger.hasSource("unknown")).toBe(false);
    });
  });

  it("moves present fields independently and leaves absent fields alone", () => {
    withLedger((db, ledger, sessions) => {
      sessions.create(makeSession("partial", "/tmp"));

      expect(ledger.observe("partial", "partial-source", { inputTokens: 5 })).toBe(true);
      expect(sourceFor(db, "partial-source")).toEqual({
        cost: null,
        input_tokens: 5,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(ledger.attributionsFor(["partial"])).toEqual([{
        sessionId: "partial",
        sourceKey: "partial-source",
        cost: null,
        inputTokens: 5,
        outputTokens: 0,
        cachedTokens: 0,
      }]);
      expect(usageFor(db, "partial")).toEqual({
        usage_input_tokens: 5,
        usage_output_tokens: 0,
        usage_cached_tokens: 0,
        usage_cost: null,
      });

      expect(ledger.observe("partial", "partial-source", { cost: 2 })).toBe(true);
      expect(sourceFor(db, "partial-source")).toEqual({
        cost: 2,
        input_tokens: 5,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(ledger.attributionsFor(["partial"])).toEqual([{
        sessionId: "partial",
        sourceKey: "partial-source",
        cost: 2,
        inputTokens: 5,
        outputTokens: 0,
        cachedTokens: 0,
      }]);
      expect(usageFor(db, "partial")).toEqual({
        usage_input_tokens: 5,
        usage_output_tokens: 0,
        usage_cached_tokens: 0,
        usage_cost: 2,
      });
    });
  });

  it("records a first zero-valued observation as known usage", () => {
    withLedger((db, ledger, sessions) => {
      sessions.create(makeSession("zero-cost", "/tmp"));

      expect(ledger.observe("zero-cost", "free-source", { cost: 0 })).toBe(true);
      expect(sourceFor(db, "free-source")).toEqual({
        cost: 0,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(ledger.attributionsFor(["zero-cost"])).toEqual([{
        sessionId: "zero-cost",
        sourceKey: "free-source",
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      }]);
      expect(usageFor(db, "zero-cost")).toEqual({
        usage_input_tokens: 0,
        usage_output_tokens: 0,
        usage_cached_tokens: 0,
        usage_cost: 0,
      });

      expect(ledger.observe("zero-cost", "free-source", { cost: 0 })).toBe(false);
      expect(ledger.attributionsFor(["zero-cost"])[0].cost).toBe(0);
    });
  });

  it("seeds existing usage onto an incoming source with no mark", () => {
    withLedger((db, ledger, sessions) => {
      sessions.create(makeSession("seeded", "/tmp", {
        inputTokens: 12,
        outputTokens: 3,
        cachedTokens: 1,
        cost: 0.75,
      }));

      expect(ledger.observe("seeded", "next-process", {
        inputTokens: 2,
        outputTokens: 4,
        model: "claude-opus-4-1",
      })).toBe(true);
      expect(sourceFor(db, "next-process")).toEqual({
        cost: 0.75,
        input_tokens: 12,
        output_tokens: 4,
        cached_tokens: 1,
      });
      expect(ledger.attributionsFor(["seeded"])).toEqual([
        {
          sessionId: "seeded",
          sourceKey: "next-process",
          cost: 0.75,
          inputTokens: 12,
          outputTokens: 4,
          cachedTokens: 1,
        },
      ]);
      expect(usageFor(db, "seeded")).toEqual({
        usage_input_tokens: 12,
        usage_output_tokens: 4,
        usage_cached_tokens: 1,
        usage_cost: 0.75,
      });
      expect(sessions.get("seeded")?.model).toBe("claude-opus-4-1");
    });
  });

  it("seeds the incoming source mark before applying higher or lower cost", () => {
    withLedger((db, ledger, sessions) => {
      sessions.create(makeSession("upgrade-higher", "/tmp", { cost: 0.4 }));

      expect(ledger.observe("upgrade-higher", "claude:process-1", { cost: 0.5 })).toBe(true);
      expect(sourceFor(db, "claude:process-1")).toEqual({
        cost: 0.5,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(ledger.attributionsFor(["upgrade-higher"])).toEqual([{
        sessionId: "upgrade-higher",
        sourceKey: "claude:process-1",
        cost: 0.5,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      }]);
      expect(usageFor(db, "upgrade-higher")).toEqual({
        usage_input_tokens: 0,
        usage_output_tokens: 0,
        usage_cached_tokens: 0,
        usage_cost: 0.5,
      });

      sessions.create(makeSession("upgrade-lower", "/tmp", { cost: 0.4 }));
      expect(ledger.observe("upgrade-lower", "claude:process-2", { cost: 0.3 })).toBe(false);
      expect(sourceFor(db, "claude:process-2")).toEqual({
        cost: 0.4,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(ledger.attributionsFor(["upgrade-lower"])).toEqual([{
        sessionId: "upgrade-lower",
        sourceKey: "claude:process-2",
        cost: 0.4,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      }]);
      expect(usageFor(db, "upgrade-lower")).toEqual({
        usage_input_tokens: null,
        usage_output_tokens: null,
        usage_cached_tokens: null,
        usage_cost: 0.4,
      });
    });
  });

  it("keeps the seed source when the incoming source is already marked elsewhere", () => {
    withLedger((db, ledger, sessions) => {
      sessions.create(makeSession("existing-owner", "/tmp"));
      sessions.create(makeSession("upgrade-seeded", "/tmp", { cost: 0.25 }));

      expect(ledger.observe("existing-owner", "shared-process", { cost: 0.5 })).toBe(true);
      expect(ledger.observe("upgrade-seeded", "shared-process", { cost: 0.75 })).toBe(true);

      expect(sourceFor(db, "shared-process")).toEqual({
        cost: 0.75,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(sourceFor(db, "seed:upgrade-seeded")).toEqual({
        cost: 0.25,
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
      });
      expect(ledger.attributionsFor(["existing-owner", "upgrade-seeded"])).toEqual([
        {
          sessionId: "existing-owner",
          sourceKey: "shared-process",
          cost: 0.5,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        },
        {
          sessionId: "upgrade-seeded",
          sourceKey: "seed:upgrade-seeded",
          cost: 0.25,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        },
        {
          sessionId: "upgrade-seeded",
          sourceKey: "shared-process",
          cost: 0.25,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        },
      ]);
      expect(usageFor(db, "upgrade-seeded")).toEqual({
        usage_input_tokens: 0,
        usage_output_tokens: 0,
        usage_cached_tokens: 0,
        usage_cost: 0.5,
      });
    });
  });
});
