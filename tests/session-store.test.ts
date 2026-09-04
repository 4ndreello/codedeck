import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-ps-window-"));
    const db = new Database(path.join(dir, "test.db"));
    const store = new SessionStore(db.getHandle());
    return { dir, db, store };
  }

  it("keeps an old active session in the default view", () => {
    const { dir, db, store } = setup();
    try {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      store.create(makeSession("old-active", "working", ancient));
      const ids = store.list(50, false).map((s) => s.id);
      expect(ids).toContain("old-active");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hides an old terminated session by default but shows it with includeAll", () => {
    const { dir, db, store } = setup();
    try {
      const old = new Date(Date.now() - PS_RECENT_WINDOW_MS - 60_000);
      store.create(makeSession("old-done", "completed", old));
      expect(store.list(50, false).map((s) => s.id)).not.toContain("old-done");
      expect(store.list(50, true).map((s) => s.id)).toContain("old-done");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a recently terminated session in the default view", () => {
    const { dir, db, store } = setup();
    try {
      const recent = new Date(Date.now() - 60 * 60 * 1000);
      store.create(makeSession("recent-done", "failed", recent));
      expect(store.list(50, false).map((s) => s.id)).toContain("recent-done");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders by updatedAt DESC in both modes", () => {
    const { dir, db, store } = setup();
    try {
      const now = Date.now();
      store.create(makeSession("s-old", "completed", new Date(now - 3 * 60 * 60 * 1000)));
      store.create(makeSession("s-new", "completed", new Date(now - 60 * 60 * 1000)));
      store.create(makeSession("s-mid", "completed", new Date(now - 2 * 60 * 60 * 1000)));
      expect(store.list(50, false).map((s) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
      expect(store.list(50, true).map((s) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("countHiddenByWindow counts only rows excluded by the window", () => {
    const { dir, db, store } = setup();
    try {
      const old = new Date(Date.now() - PS_RECENT_WINDOW_MS - 60_000);
      store.create(makeSession("count-old", "completed", old));
      store.create(makeSession("count-new", "working", new Date()));
      store.create(makeSession("count-recent", "failed", new Date()));
      expect(store.countHiddenByWindow()).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("countHiddenByWindow ignores LIMIT truncation", () => {
    const { dir, db, store } = setup();
    try {
      const old = new Date(Date.now() - PS_RECENT_WINDOW_MS - 60_000);
      store.create(makeSession("trunc-old", "completed", old));
      store.create(makeSession("trunc-a", "completed", new Date()));
      store.create(makeSession("trunc-b", "completed", new Date()));
      // Only 2 of 3 visible rows fit, but hidden counts just the window-excluded one.
      expect(store.list(2, false)).toHaveLength(2);
      expect(store.countHiddenByWindow()).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
