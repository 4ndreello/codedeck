import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { classifyFailure } from "../src/core/errors.js";
import type { AgentEvent } from "../src/core/events.js";
import { makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

// A persistence error is the daemon's problem, not the session's: while the
// harness runs, a busy SQLite must never end the event loop or mark the
// session failed (the "database is locked" df94 incident).

let dir: string;
let daemon: Daemon | undefined;

beforeEach(() => {
  dir = makeTempDir("store-busy-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  try { if (daemon) seam(daemon).db.close(); } catch {}
  daemon = undefined;
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});

function turn(sessionId: string): AgentEvent[] {
  const ts = () => new Date().toISOString();
  return [
    { type: "message", sessionId, timestamp: ts(), content: "working on it", sourceKey: "log:10:0" },
    { type: "usage.updated", sessionId, timestamp: ts(), usage: { inputTokens: 1200, outputTokens: 80 }, sourceKey: "log:20:0" },
    { type: "session.completed", sessionId, timestamp: ts(), reason: "completed", sourceKey: "log:30:0" },
  ] as AgentEvent[];
}

function driverFor(events: AgentEvent[]) {
  return {
    async *events() {
      for (const ev of events) yield ev;
    },
  };
}

function busyError(errcode: number): Error {
  return Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });
}

async function run(sessionId: string, events: AgentEvent[]): Promise<void> {
  await (daemon as any).attachDriverEvents(sessionId, driverFor(events), { id: sessionId });
}

describe("event loop under a busy store", () => {
  it("survives another process committing mid-transaction (SQLITE_BUSY_SNAPSHOT)", async () => {
    daemon = new Daemon();
    seed(daemon, "s-snap");
    const store = seam(daemon).events;
    const handle = seam(daemon).db.getHandle();
    // A second writer on the same file: what a stray daemon was.
    const other = new DatabaseSync(path.join(dir, "run-agent.db"));
    other.exec("PRAGMA busy_timeout = 0; CREATE TABLE other_writer (n INTEGER);");
    const original = store.append.bind(store);
    let interleaved = false;
    store.append = (sessionId, event, raw) => {
      if (!interleaved && event.type === "message") {
        interleaved = true;
        // Open this transaction's read snapshot, then let the other writer
        // commit before our INSERT, exactly the production interleaving.
        handle.prepare("SELECT COUNT(*) FROM events").get();
        try {
          other.exec("INSERT INTO other_writer VALUES (1)");
        } catch (error) {
          // An IMMEDIATE transaction already holds the write lock, so the
          // other writer is the one refused. That is the fixed behaviour.
          if (!/database is locked/.test((error as Error).message)) throw error;
        }
      }
      return original(sessionId, event, raw);
    };

    try {
      await run("s-snap", turn("s-snap"));
    } finally {
      other.close();
    }

    const types = store.list("s-snap").map((e) => e.type);
    expect(types).toEqual(["message", "usage.updated", "session.completed"]);
    expect(seam(daemon).sessions.get("s-snap")?.status).toBe("completed");
  });

  it("retries a busy append instead of failing the session", async () => {
    daemon = new Daemon();
    seed(daemon, "s-busy");
    const store = seam(daemon).events;
    const original = store.append.bind(store);
    let failures = 0;
    store.append = (sessionId, event, raw) => {
      // Busy for longer than busy_timeout covers: plain SQLITE_BUSY, then
      // BUSY_SNAPSHOT, then the store frees up.
      if (event.type === "usage.updated" && failures < 2) {
        failures += 1;
        throw busyError(failures === 1 ? 5 : 517);
      }
      return original(sessionId, event, raw);
    };

    await run("s-busy", turn("s-busy"));

    expect(failures).toBe(2);
    const events = store.list("s-busy");
    expect(events.map((e) => e.type)).toEqual(["message", "usage.updated", "session.completed"]);
    expect(events.some((e) => e.type === "session.failed")).toBe(false);
    expect(seam(daemon).sessions.get("s-busy")?.status).toBe("completed");
  });

  it("still fails the session on a non-busy persistence error", async () => {
    daemon = new Daemon();
    seed(daemon, "s-bad");
    const store = seam(daemon).events;
    const original = store.append.bind(store);
    store.append = (sessionId, event, raw) => {
      if (event.type === "usage.updated") throw new Error("disk I/O error");
      return original(sessionId, event, raw);
    };

    await run("s-bad", turn("s-bad"));

    expect(seam(daemon).sessions.get("s-bad")?.status).toBe("failed");
  });
});

describe("classifyFailure for store errors", () => {
  it("blames infra, not the harness, for a locked database", () => {
    expect(classifyFailure("database is locked")).toMatchObject({ code: "STORE_BUSY", blame: "infra", retryable: true });
    expect(classifyFailure("SQLITE_BUSY: database is busy")).toMatchObject({ code: "STORE_BUSY", blame: "infra" });
  });
});
