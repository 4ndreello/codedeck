import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
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
