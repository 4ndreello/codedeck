import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import type { AgentDriver, DriverSession } from "../src/core/driver.js";
import type { AgentEvent } from "../src/core/events.js";
import { processStartTime } from "../src/utils/process.js";
import { makeTempDir, removeTempDir, seam, seed, fakeSocket } from "./helpers/daemon-seam.js";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("send-queue-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});

interface IpcOutcome {
  result?: { ok?: boolean; queued?: boolean };
  error?: { code?: string; message?: string };
}

async function send(daemon: Daemon, id: string, message: unknown): Promise<IpcOutcome> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.send", params: { id, message } }, socket);
  return JSON.parse(writes[0]) as IpcOutcome;
}

async function stop(daemon: Daemon, id: string): Promise<IpcOutcome> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.stop", params: { id } }, socket);
  return JSON.parse(writes[0]) as IpcOutcome;
}

describe("send queue", () => {
  it("queues while starting without changing status", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-busy", "starting", { origin: "run" });
    const body = await send(daemon, "s-busy", "second thought");
    expect(body.result).toEqual({ ok: true, queued: true });
    const stored = seam(daemon).sessions.get("s-busy")!;
    expect(stored.status).toBe("starting");
    expect(stored.pendingMessage).toBe("second thought");
    expect(stored.pendingAt).toBeTruthy();
    const types = seam(daemon).events.list("s-busy", 10).map((e) => e.type);
    expect(types).toContain("message.queued");
    expect(stored.lastEvent).toMatch(/^queued: /);
  });

  it("last send wins the single slot", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-busy", "starting", { origin: "run" });
    await send(daemon, "s-busy", "first");
    await send(daemon, "s-busy", "second");
    expect(seam(daemon).sessions.get("s-busy")?.pendingMessage).toBe("second");
  });

  it("rejects empty and oversize messages before admission", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-busy", "starting", { origin: "run" });
    expect((await send(daemon, "s-busy", "   ")).error?.code).toBe("INVALID");
    expect((await send(daemon, "s-busy", "x".repeat(65 * 1024 + 1))).error?.code).toBe("INVALID");
    expect(seam(daemon).sessions.get("s-busy")?.pendingMessage).toBeUndefined();
  });

  it("never queues interactive sessions", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-open", "starting", { origin: "open" });
    const body = await send(daemon, "s-open", "hello?");
    expect(body.error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(seam(daemon).sessions.get("s-open")?.pendingMessage).toBeUndefined();
  });

  it("keeps stop-first for interrupted sessions with a live process", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-int", "interrupted", {
      origin: "run",
      nativeSessionId: "n-live",
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
    });
    const body = await send(daemon, "s-int", "hello?");
    expect(body.error?.code).toBe("SESSION_BUSY");
    expect(seam(daemon).sessions.get("s-int")?.pendingMessage).toBeUndefined();
  });

  it("stop cancels pending even when there is nothing to stop", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-done", "completed", {
      origin: "run",
      pendingMessage: "stale",
      pendingAt: new Date().toISOString(),
    });
    const body = await stop(daemon, "s-done");
    expect(body.error?.code).toBe("SESSION_NOT_RUNNING");
    const stored = seam(daemon).sessions.get("s-done")!;
    expect(stored.pendingMessage).toBeUndefined();
    expect(stored.pendingAt).toBeUndefined();
  });

  it("exposes pending through session.get", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-busy", "starting", { origin: "run" });
    await send(daemon, "s-busy", "queued hello");
    const { writes, socket } = fakeSocket();
    await seam(daemon).handleRequest({ id: "r2", method: "session.get", params: { id: "s-busy" } }, socket);
    const body = JSON.parse(writes[0]) as { result?: { session?: { pendingMessage?: string } } };
    expect(body.result?.session?.pendingMessage).toBe("queued hello");
  });
});

interface TailTestSeam {
  attachDriverEvents(sessionId: string, driver: AgentDriver, drvSession: DriverSession): Promise<void>;
}

function tailSeam(daemon: Daemon): TailTestSeam {
  // Tests drive private lifecycle methods directly (same seam pattern).
  return seam(daemon) as unknown as TailTestSeam;
}

describe("tail dispatch", () => {
  // The tail fires tryDispatch fire-and-forget; the whole chain is
  // microtasks plus synchronous sqlite, so drain the queue instead of
  // sleeping on the wall clock.
  async function flushWhile(more: () => boolean, budget = 500): Promise<void> {
    for (let i = 0; i < budget && more(); i++) await Promise.resolve();
  }

  function completedEvent(sessionId: string): AgentEvent {
    return { type: "session.completed", sessionId, timestamp: new Date().toISOString(), reason: "done" };
  }

  function installQueueDriver(daemon: Daemon, sent: { message: string }[], failSend = false): AgentDriver {
    const driver = {
      id: "claude",
      capabilities: () => ({ streaming: true, resume: true }),
      send: async (_session: unknown, message: string) => {
        if (failSend) throw new Error("resume gone");
        sent.push({ message });
      },
      getHandle: () => undefined,
      events: async function* () {
        yield completedEvent("x");
      },
    };
    seam(daemon).registry.register(driver);
    // Structurally the daemon only touches the fields above in this flow.
    return driver as unknown as AgentDriver;
  }

  function drvSession(id: string, nativeSessionId?: string): DriverSession {
    return { id, nativeSessionId, cwd: "/tmp" };
  }

  it("starts the queued message as exactly one turn when the stream ends", async () => {
    const daemon = new Daemon();
    const sent: { message: string }[] = [];
    const driver = installQueueDriver(daemon, sent);
    seed(daemon, "s-tail", "working", {
      origin: "run",
      nativeSessionId: "n-1",
      pendingMessage: "queued hello",
      pendingAt: new Date().toISOString(),
    });
    await tailSeam(daemon).attachDriverEvents("s-tail", driver, drvSession("s-tail", "n-1"));
    await flushWhile(() => sent.length === 0);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe("queued hello");
    await flushWhile(() => seam(daemon).sessions.get("s-tail")?.pendingMessage != null);
    const all = seam(daemon).events.list("s-tail", 20);
    const starts = all.filter((e) => e.type === "turn.started");
    expect(starts).toHaveLength(1);
    expect(starts[0].type === "turn.started" ? starts[0].prompt : undefined).toBe("queued hello");
  });

  it("leaves the slot quietly when no native id can be resolved", async () => {
    const daemon = new Daemon();
    const sent: { message: string }[] = [];
    const driver = installQueueDriver(daemon, sent);
    seed(daemon, "s-nonative", "working", {
      origin: "run",
      pendingMessage: "waits for manual send",
      pendingAt: new Date().toISOString(),
    });
    await tailSeam(daemon).attachDriverEvents("s-nonative", driver, drvSession("s-nonative"));
    // The no-native gate returns before any await, but drain a few ticks so
    // the assertion covers the settled chain rather than a pending one.
    await flushWhile(() => sent.length !== 0, 10);
    expect(sent).toHaveLength(0);
    expect(seam(daemon).sessions.get("s-nonative")?.pendingMessage).toBe("waits for manual send");
    const types = seam(daemon).events.list("s-nonative", 20).map((e) => e.type);
    expect(types).not.toContain("turn.started");
  });

  it("restores the slot with an honest event when dispatch fails", async () => {
    const daemon = new Daemon();
    const sent: { message: string }[] = [];
    const driver = installQueueDriver(daemon, sent, true);
    seed(daemon, "s-fail", "working", {
      origin: "run",
      nativeSessionId: "n-9",
      pendingMessage: "doomed",
      pendingAt: new Date().toISOString(),
    });
    await tailSeam(daemon).attachDriverEvents("s-fail", driver, drvSession("s-fail", "n-9"));
    await flushWhile(
      () => !seam(daemon).events.list("s-fail", 20).some((e) => e.type === "session.failed" && e.error === "resume gone"),
    );
    expect(sent).toHaveLength(0);
    expect(seam(daemon).sessions.get("s-fail")?.pendingMessage).toBe("doomed");
  });
});
