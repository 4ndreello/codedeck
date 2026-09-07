import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../src/store/database.js";
import { SessionStore, PS_RECENT_WINDOW_MS } from "../src/store/sessions.js";
import type { Session } from "../src/core/session.js";
import { EventStore } from "../src/store/events.js";
import type { AgentEvent } from "../src/core/events.js";

// Covers the fields recovery relies on after the daemon process is gone.
describe("SessionStore restart metadata", () => {
  it("round-trips pid identity, log offsets, and failure classification", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-"));
    const db = new Database(path.join(dir, "test.db"));
    const store = new SessionStore(db.getHandle());
    const createdAt = new Date("2026-08-27T00:00:00.000Z");
    const session: Session = {
      id: "persist-test",
      runId: "run-a",
      agent: "omp",
      status: "working",
      cwd: dir,
      pid: 12345,
      pidStartTime: "987654",
      logOffset: 456,
      stderrOffset: 78,
      failure: {
        code: "HARNESS_CRASH",
        blame: "harness",
        retryable: true,
        reason: "EPIPE",
      },
      createdAt,
      updatedAt: createdAt,
    };

    store.create(session);
    const loaded = store.get(session.id);
    expect(loaded).toMatchObject({
      runId: "run-a",
      pid: 12345,
      pidStartTime: "987654",
      logOffset: 456,
      stderrOffset: 78,
      failure: session.failure,
    });
    const events = new EventStore(db.getHandle());
    const event: AgentEvent = {
      type: "message",
      sessionId: session.id,
      timestamp: createdAt.toISOString(),
      role: "assistant",
      content: "once",
      sourceKey: "log:42:0",
    };
    expect(events.append(session.id, event)).toBe(1);
    // A reattached runtime may replay the same raw line; it must be ignored.
    expect(events.append(session.id, event)).toBe(0);
    expect(events.count(session.id)).toBe(1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns only the sessions stored for the requested run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-run-"));
    const db = new Database(path.join(dir, "test.db"));
    const store = new SessionStore(db.getHandle());
    const createdAt = new Date("2026-08-27T00:00:00.000Z");
    const makeSession = (id: string, runId: string): Session => ({
      id,
      runId,
      agent: "omp",
      status: "working",
      cwd: dir,
      createdAt,
      updatedAt: createdAt,
    });

    try {
      store.create(makeSession("run-a-1", "run-a"));
      store.create(makeSession("run-a-2", "run-a"));
      store.create(makeSession("run-b-1", "run-b"));

      expect(store.get("run-a-1")?.runId).toBe("run-a");
      expect(store.getByRunId("run-a").map((session) => session.id).sort()).toEqual([
        "run-a-1",
        "run-a-2",
      ]);
      expect(store.listByRunId("run-b").map((session) => session.id)).toEqual(["run-b-1"]);
      expect(store.getByRunId("missing")).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a legacy sessions table with a run index without losing rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-migration-"));
    const file = path.join(dir, "legacy.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        agent TEXT NOT NULL,
        native_session_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        repository TEXT,
        cwd TEXT NOT NULL,
        worktree TEXT,
        branch TEXT,
        base_commit TEXT,
        pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        usage_input_tokens INTEGER,
        usage_output_tokens INTEGER,
        usage_cached_tokens INTEGER,
        usage_cost REAL,
        last_event TEXT
      );
    `);
    legacy.prepare(
      `INSERT INTO sessions (id, agent, status, cwd, created_at, updated_at)
       VALUES ('legacy-1', 'claude', 'completed', '/work', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    legacy.close();

    const db = new Database(file);
    try {
      const columns = (db.getHandle().prepare("PRAGMA table_info(sessions)").all() as any[])
        .map((column) => column.name);
      const indexes = (db.getHandle().prepare("PRAGMA index_list(sessions)").all() as any[])
        .map((index) => index.name);

      expect(columns).toContain("run_id");
      expect(indexes).toContain("idx_sessions_run_id");
      expect(new SessionStore(db.getHandle()).get("legacy-1")).toMatchObject({
        id: "legacy-1",
        agent: "claude",
      });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Default `ps` view: actives of any age plus sessions touched in the last 24h.
describe("SessionStore ps 24h window", () => {
  function makeSession(id: string, status: Session["status"], updatedAt: Date): Session {
    return {
      id,
      agent: "omp",
      status,
      cwd: "/tmp",
      createdAt: new Date(updatedAt.getTime() - 60_000),
      updatedAt,
    };
  }

  function withStore(fn: (store: SessionStore) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-ps-window-"));
    const db = new Database(path.join(dir, "test.db"));
    try {
      fn(new SessionStore(db.getHandle()));
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("keeps an old active session in the default view", () => {
    withStore((store) => {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      store.create(makeSession("old-active", "working", ancient));
      const ids = store.list(50, false).map((s) => s.id);
      expect(ids).toContain("old-active");
    });
  });

  it("hides an old terminated session by default but shows it with includeAll", () => {
    withStore((store) => {
      const old = new Date(Date.now() - PS_RECENT_WINDOW_MS - 60_000);
      store.create(makeSession("old-done", "completed", old));
      expect(store.list(50, false).map((s) => s.id)).not.toContain("old-done");
      expect(store.list(50, true).map((s) => s.id)).toContain("old-done");
    });
  });

  it("keeps a recently terminated session in the default view", () => {
    withStore((store) => {
      const recent = new Date(Date.now() - 60 * 60 * 1000);
      store.create(makeSession("recent-done", "failed", recent));
      expect(store.list(50, false).map((s) => s.id)).toContain("recent-done");
    });
  });

  it("orders by updatedAt DESC in both modes", () => {
    withStore((store) => {
      const now = Date.now();
      store.create(makeSession("s-old", "completed", new Date(now - 3 * 60 * 60 * 1000)));
      store.create(makeSession("s-new", "completed", new Date(now - 60 * 60 * 1000)));
      store.create(makeSession("s-mid", "completed", new Date(now - 2 * 60 * 60 * 1000)));
      expect(store.list(50, false).map((s) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
      expect(store.list(50, true).map((s) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
    });
  });

  it("countHiddenByWindow counts only rows excluded by the window", () => {
    withStore((store) => {
      const old = new Date(Date.now() - PS_RECENT_WINDOW_MS - 60_000);
      store.create(makeSession("count-old", "completed", old));
      store.create(makeSession("count-new", "working", new Date()));
      store.create(makeSession("count-recent", "failed", new Date()));
      expect(store.countHiddenByWindow()).toBe(1);
    });
  });

  it("countHiddenByWindow ignores LIMIT truncation", () => {
    withStore((store) => {
      const old = new Date(Date.now() - PS_RECENT_WINDOW_MS - 60_000);
      store.create(makeSession("trunc-old", "completed", old));
      store.create(makeSession("trunc-a", "completed", new Date()));
      store.create(makeSession("trunc-b", "completed", new Date()));
      // Only 2 of 3 visible rows fit, but hidden counts just the window-excluded one.
      expect(store.list(2, false)).toHaveLength(2);
      expect(store.countHiddenByWindow()).toBe(1);
    });
  });
});
