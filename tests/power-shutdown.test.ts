import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../src/utils/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/process.js")>();
  return { ...actual, killTree: vi.fn(async () => {}) };
});

import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import { EventStore } from "../src/store/events.js";
import { killTree } from "../src/utils/process.js";
import { Daemon } from "../src/daemon/daemon.js";
import { fakeSocket, makeTempDir, removeTempDir, seed } from "./helpers/daemon-seam.js";

// Shutdown closes the DB by design; post-shutdown assertions reopen it like
// a fresh process after reboot (spec independent test).
function reopenStores(): { sessions: SessionStore; events: EventStore } {
  const handle = new Database(path.join(dir, "run-agent.db")).getHandle();
  return { sessions: new SessionStore(handle), events: new EventStore(handle) };
}

const mockedKillTree = vi.mocked(killTree);
let dir: string;

beforeEach(() => {
  dir = makeTempDir("power-shutdown-");
  process.env.RUN_AGENT_DIR = dir;
  mockedKillTree.mockClear();
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});


describe("power graceful shutdown", () => {
  it("marks each active session interrupted with one SHUTDOWN failed event", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-one", "working", { pid: 999999, pidStartTime: "12345" });
    seed(daemon, "s-two", "idle");

    await daemon.handleShutdown("SIGTERM");

    const { sessions, events } = reopenStores();
    for (const id of ["s-one", "s-two"]) {
      const s = sessions.get(id);
      expect(s?.status).toBe("interrupted");
      expect(s?.failure).toMatchObject({ code: "SHUTDOWN", blame: "infra", retryable: true });
      const listed = events.list(id, 100);
      expect(listed).toHaveLength(1);
      expect(listed[0].type).toBe("session.failed");
      expect(listed[0].failure).toMatchObject({ code: "SHUTDOWN", blame: "infra", retryable: true });
    }
  });

  it("kills each PID session with grace 1500 and identity, skipping pid-less rows", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-pid", "working", { pid: 424242, pidStartTime: "tick-9" });
    seed(daemon, "s-nopid", "working");

    await daemon.handleShutdown("SIGTERM");

    expect(mockedKillTree).toHaveBeenCalledTimes(1);
    expect(mockedKillTree).toHaveBeenCalledWith(424242, 1500, "tick-9");
  });

  it("runs the drain exactly once under concurrent shutdown calls", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-race");

    await Promise.all([
      daemon.handleShutdown("SIGTERM"),
      daemon.handleShutdown("SIGTERM"),
      daemon.handleShutdown("SIGINT"),
    ]);

    const { sessions, events } = reopenStores();
    expect(events.list("s-race", 100)).toHaveLength(1);
    expect(sessions.get("s-race")?.status).toBe("interrupted");
  });

  it("rejects new requests with SERVICE_UNAVAILABLE while shutting down", async () => {
    const daemon = new Daemon();
    await daemon.handleShutdown("SIGTERM");

    const { writes, socket } = fakeSocket();
    await (daemon as any).handleRequest({ id: "r1", method: "session.list", params: {} }, socket);

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("routes daemon.stop IPC to the same drain", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const daemon = new Daemon();
      seed(daemon, "s-stop");

      const { writes, socket } = fakeSocket();
      await (daemon as any).handleRequest({ id: "r1", method: "daemon.stop", params: {} }, socket);
      await daemon.handleShutdown("daemon.stop");

      expect(reopenStores().sessions.get("s-stop")?.status).toBe("interrupted");
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("checkpoints PASSIVE before the kill and TRUNCATE after", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-ckpt", "working", { pid: 777, pidStartTime: "t" });
    const execCalls: string[] = [];
    const handle = (daemon as any).db.getHandle();
    const execSpy = vi.spyOn(handle, "exec").mockImplementation(((sql: string) => {
      execCalls.push(sql);
      return undefined;
    }) as any);
    try {
      await daemon.handleShutdown("SIGTERM");
    } finally {
      execSpy.mockRestore();
    }

    const passive = execCalls.findIndex((s) => s.includes("wal_checkpoint(PASSIVE)"));
    const truncate = execCalls.findIndex((s) => s.includes("wal_checkpoint(TRUNCATE)"));
    expect(passive).toBeGreaterThanOrEqual(0);
    expect(truncate).toBeGreaterThan(passive);
  });

  it("rolls back a stale open transaction before persisting interrupted", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-tx");
    // Simulate a BEGIN left open by an in-flight writer.
    (daemon as any).db.getHandle().exec("BEGIN");

    await daemon.handleShutdown("SIGTERM");

    expect(reopenStores().sessions.get("s-tx")?.status).toBe("interrupted");
  });

  it("keeps an interrupted row on stream end instead of synthesizing failed", async () => {
    const daemon = new Daemon();
    const failure = { code: "SHUTDOWN", blame: "infra", retryable: true };
    seed(daemon, "s-term", "interrupted", { failure } as any);
    const fakeDriver = {
      async *events() {
        yield { type: "message", sessionId: "s-term", timestamp: new Date().toISOString(), content: "hi" };
      },
    };

    await (daemon as any).attachDriverEvents("s-term", fakeDriver, { id: "s-term" });

    expect((daemon as any).sessions.get("s-term").status).toBe("interrupted");
    const last = (daemon as any).events.last("s-term");
    expect(last.type).toBe("message");
  });

  it("reports power readiness on the doctor result", async () => {
    const daemon = new Daemon();
    const { writes, socket } = fakeSocket();
    await (daemon as any).handleRequest({ id: "r1", method: "doctor", params: {} }, socket);

    const power = JSON.parse(writes[0]).result.power;
    expect(typeof power.serviceInstalled).toBe("boolean");
    expect(typeof power.inhibitAvailable).toBe("boolean");
  });
});
