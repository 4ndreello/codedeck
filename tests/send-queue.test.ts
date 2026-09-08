import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
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

async function send(daemon: Daemon, id: string, message: unknown): Promise<any> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.send", params: { id, message } }, socket);
  return JSON.parse(writes[0]);
}

async function stop(daemon: Daemon, id: string): Promise<any> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.stop", params: { id } }, socket);
  return JSON.parse(writes[0]);
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
