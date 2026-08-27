import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import { parseEffort } from "../src/core/driver.js";

const tmpDb = (name: string) => path.join(mkdtempSync(path.join(tmpdir(), "codedeck-test-")), name);

const newSession = (over: Record<string, unknown> = {}) => ({
  id: "a83f",
  agent: "codex",
  status: "starting",
  cwd: "/work",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
}) as any;

describe("run settings persistence", () => {
  it("round-trips effort and fast through the store", () => {
    // send() starts a NEW process for the next turn and rebuilds args from the
    // stored session. If these are not persisted, turn 2 silently drops back to
    // default effort while ps still shows the session the user configured.
    const db = new Database(tmpDb("a.db"));
    const store = new SessionStore(db.getHandle());

    store.create(newSession({ effort: "max", fast: true }));

    const loaded = store.get("a83f");
    expect(loaded?.effort).toBe("max");
    expect(loaded?.fast).toBe(true);
  });

  it("defaults fast to false rather than undefined when unset", () => {
    const db = new Database(tmpDb("b.db"));
    const store = new SessionStore(db.getHandle());

    store.create(newSession());

    expect(store.get("a83f")?.fast).toBe(false);
  });

  it("adds the new columns to a database created before they existed", () => {
    // CREATE TABLE IF NOT EXISTS is a no-op on existing installs, so without an
    // explicit ALTER every current user's ~/.run-agent/run-agent.db would throw
    // "no such column" on the first run after upgrading.
    const file = tmpDb("legacy.db");
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
       VALUES ('old1', 'claude', 'completed', '/work', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    legacy.close();

    const db = new Database(file);
    const columns = (db.getHandle().prepare("PRAGMA table_info(sessions)").all() as any[])
      .map((c) => c.name);
    expect(columns).toContain("effort");
    expect(columns).toContain("fast");

    // The pre-existing row must survive the migration untouched.
    const store = new SessionStore(db.getHandle());
    const old = store.get("old1");
    expect(old?.agent).toBe("claude");
    expect(old?.effort).toBeUndefined();
  });
});

describe("parseEffort", () => {
  it("accepts the levels every harness shares", () => {
    expect(parseEffort("max")).toBe("max");
    expect(parseEffort("xhigh")).toBe("xhigh");
  });

  it("rejects a typo instead of forwarding it to the harness", () => {
    // Forwarding an invalid level makes codex fail at spawn time with an opaque
    // TOML error, long after the session row was already created. The message
    // must name the bad value and list the valid ones -- asserting on a loose
    // /effort/i here would also match "parseEffort is not a function".
    expect(() => parseEffort("maximum")).toThrow(/invalid effort "maximum"/i);
    expect(() => parseEffort("maximum")).toThrow(/low, medium, high, xhigh, max/);
  });
});
