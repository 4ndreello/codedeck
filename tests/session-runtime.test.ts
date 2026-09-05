import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionRuntime, readSessionProcessMetadata, type RuntimeHooks } from "../src/drivers/session-runtime.js";
import { processAlive, processStartTime, sleep } from "../src/utils/process.js";
import type { AgentEvent } from "../src/core/events.js";

// Isolate the GLOBAL log dir: tests share session ids, and session log paths
// are derived from RUN_AGENT_DIR (honored by config/paths.ts) — without this,
// runs contaminate each other's <id>.ndjson and duplicate events.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-logs-"));
process.env.RUN_AGENT_DIR = logDir;
afterAll(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});
// its file writes. All waits are CONDITION waits (poll until the awaited
// state exists), never fixed durations.

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await sleep(25);
  }
}

interface Harness {
  runtime: SessionRuntime;
  events: AgentEvent[];
  dir: string;
}

function makeHooks(events: AgentEvent[]): RuntimeHooks {
  return {
    onLine: (line, { push, setNativeId, isStderr }) => {
      if (isStderr) return; // stderr is kept by the runtime, not parsed here
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.id === "string") setNativeId(obj.id);
      events.push({
        type: obj.type === "text" ? "text.delta" : obj.type === "session" ? "session.started" : (obj.type as AgentEvent["type"]),
        sessionId: "s",
        timestamp: new Date().toISOString(),
        delta: typeof obj.text === "string" ? obj.text : undefined,
        nativeSessionId: typeof obj.id === "string" ? obj.id : undefined,
        raw: obj,
      } as AgentEvent);
      push(events[events.length - 1]!);
    },
    synthesizeTerminal: (ctx) => {
      const ev = {
        type: "session.failed",
        sessionId: ctx.sessionId,
        timestamp: new Date().toISOString(),
        error: ctx.stderr.trim() || "died without terminal",
        raw: { exitCode: ctx.exitCode, signal: ctx.signal },
      } as AgentEvent;
      return [ev];
    },
  };
}

function spawnFake(script: string): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
  const events: AgentEvent[] = [];
  const runtime = SessionRuntime.spawn({
    sessionId: "s",
    cmd: process.execPath,
    args: ["-e", script],
    cwd: dir,
    hooks: makeHooks(events),
  });
  return { runtime, events, dir };
}

// Fake harness: session frame, two text deltas, then exits — WITHOUT a
// terminal frame. The runtime must synthesize one.
const SCRIPT_COMPLETE_SILENT = `
const h = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
h({ type: "session", id: "native-1" });
h({ type: "text", text: "hello" });
h({ type: "text", text: "world" });
process.stderr.write("warning noise\\n");
`;

describe("SessionRuntime.spawn — file transport", () => {
  it("tails NDJSON from the log file, extracts the native id, and ends after exit", async () => {
    const { runtime, dir } = spawnFake(SCRIPT_COMPLETE_SILENT);
    const collected: AgentEvent[] = [];
    for await (const ev of runtime.events()) collected.push(ev);
    const types = collected.map((e) => e.type);
    expect(types).toContain("session.started");
    expect(types.filter((t) => t === "text.delta")).toHaveLength(2);
    // Terminal synthesis: no terminal frame was written, exit code 0, stderr
    // non-empty but output exists → completed is forbidden, failed it is.
    const last = collected[collected.length - 1]!;
    expect(last.type).toBe("session.failed");
    // Native id recovered from the session frame line.
    // Offsets advanced — the log and atomic process sidecar are on disk for
    // a future daemon reattach.
    expect(runtime.offsets.log).toBeGreaterThan(0);
    expect(readSessionProcessMetadata("s")?.pid).toBe(runtime.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("exit 0 with stderr but NO output synthesizes a harness-style failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const hooks: RuntimeHooks = {
      onLine: () => {},
      synthesizeTerminal: (ctx) => [
        { type: "session.failed", sessionId: ctx.sessionId, timestamp: new Date().toISOString(), error: ctx.stderr } as AgentEvent,
      ],
    };
    const runtime = SessionRuntime.spawn({
      sessionId: "s",
      cmd: process.execPath,
      args: ["-e", 'process.stderr.write("Unhandled rejection: EPIPE: broken pipe\\n");'],
      cwd: dir,
      hooks,
    });
    const collected: AgentEvent[] = [];
    for await (const ev of runtime.events()) collected.push(ev);
    expect(collected).toHaveLength(1);
    expect(collected[0]!.type).toBe("session.failed");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("kill -9 mid-run synthesizes a failed terminal with the signal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const runtime = SessionRuntime.spawn({
      sessionId: "s",
      cmd: process.execPath,
      args: [
        "-e",
        `
const h = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
h({ type: "session", id: "native-k" });
setInterval(() => h({ type: "text", text: "tick" }), 100);
`,
      ],
      cwd: dir,
      hooks: makeHooks([]),
    });
    const collected: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of runtime.events()) collected.push(ev);
    })();
    // Wait for proof the stream is live before killing.
    await waitFor(() => collected.filter((e) => e.type === "text.delta").length >= 2, "streaming ticks");
    process.kill(-runtime.pid, "SIGKILL");
    await consume;
    const last = collected[collected.length - 1]!;
    expect(last.type).toBe("session.failed");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
  it("keeps the persisted offset behind a multi-event line until all events yield", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const runtime = SessionRuntime.spawn({
      sessionId: "multi-offset",
      cmd: process.execPath,
      args: ["-e", 'process.stdout.write(JSON.stringify({ type: "multi" }) + "\\n");'],
      cwd: dir,
      hooks: {
        onLine: (_line, { sessionId, push }) => {
          const timestamp = new Date().toISOString();
          push({ type: "message", sessionId, timestamp, role: "assistant", content: "one" });
          push({ type: "text.delta", sessionId, timestamp, delta: "two" });
        },
        synthesizeTerminal: () => [],
      },
    });
    const collected: AgentEvent[] = [];
    for await (const ev of runtime.events()) {
      collected.push(ev);
      if (collected.length === 1) expect(runtime.offsets.log).toBe(0);
      if (collected.length === 2) expect(runtime.offsets.log).toBeGreaterThan(0);
    }
    expect(collected).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("shutdown drain drops partial output and waits for the consumer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const runtime = SessionRuntime.spawn({
      sessionId: "shutdown-drain",
      cmd: process.execPath,
      args: [
        "-e",
        `
process.stdout.write(JSON.stringify({ type: "message" }) + "\\npartial");
setInterval(() => {}, 1000);
`,
      ],
      cwd: dir,
      hooks: {
        onLine: (_line, { sessionId, push }) => {
          push({
            type: "message",
            sessionId,
            timestamp: new Date().toISOString(),
            role: "assistant",
            content: "complete",
          });
        },
        synthesizeTerminal: () => [
          {
            type: "session.failed",
            sessionId: "shutdown-drain",
            timestamp: new Date().toISOString(),
            error: "unexpected synthesis",
          },
        ],
      },
    });
    const collected: AgentEvent[] = [];
    const consume = (async () => {
      for await (const ev of runtime.events()) collected.push(ev);
    })();
    await waitFor(() => runtime.buffer.length === 1, "complete line");

    runtime.prepareForShutdown();
    const drain = runtime.drainForShutdown();
    await drain;
    await consume;

    expect(collected).toHaveLength(1);
    expect(collected[0]!.type).toBe("message");
    try { process.kill(-runtime.pid, "SIGKILL"); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

});

describe("SessionRuntime.reattach — daemon restart", () => {
  it("resumes a live process from the persisted offset and classifies its death", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const firstBatch: AgentEvent[] = [];
    const runtime = SessionRuntime.spawn({
      sessionId: "s",
      cmd: process.execPath,
      args: [
        "-e",
        `
const h = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
h({ type: "session", id: "native-r" });
let i = 0;
const t = setInterval(() => { i++; h({ type: "text", text: "tick" + i }); }, 100);
process.on("SIGTERM", () => { clearInterval(t); });
`,
      ],
      cwd: dir,
      hooks: makeHooks(firstBatch),
    });
    const consumeFirst = (async () => {
      for await (const ev of runtime.events()) firstBatch.push(ev);
    })();

    // Wait for proof the original runtime is streaming, then snapshot its
    // consumed offsets — what a restarting daemon would have persisted.
    await waitFor(() => firstBatch.filter((e) => e.type === "text.delta").length >= 2, "first runtime streaming");
    const offsets = { ...runtime.offsets };

    // The "new daemon": reattach to the SAME live pid and log files.
    const reattachedCollected: AgentEvent[] = [];
    const reattached = SessionRuntime.reattach({
      sessionId: "s",
      pid: runtime.pid,
      pidStartTime: processStartTime(runtime.pid),
      nativeSessionId: runtime.nativeSessionId,
      logOffset: offsets.log,
      stderrOffset: offsets.stderr,
      hooks: makeHooks(reattachedCollected),
    });
    const consumeReattached = (async () => {
      for await (const ev of reattached.events()) reattachedCollected.push(ev);
    })();

    // The reattached runtime must see NEW ticks without replaying old ones.
    await waitFor(() => reattachedCollected.filter((e) => e.type === "text.delta").length >= 1, "reattached streaming");
    expect(reattachedCollected.some((e) => e.type === "session.started")).toBe(false);
    // Native id survives the restart (from persisted state + log tail).
    expect(reattached.nativeSessionId).toBe("native-r");

    // Kill the harness; BOTH runtimes must conclude with a synthesized
    // terminal event (the harness never writes one).
    process.kill(-runtime.pid, "SIGKILL");
    await Promise.all([consumeFirst, consumeReattached]);
    expect(firstBatch[firstBatch.length - 1]!.type).toBe("session.failed");
    expect(reattachedCollected[reattachedCollected.length - 1]!.type).toBe("session.failed");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);
});

describe("SessionRuntime.stop — pid-based kill works without in-memory proc", () => {
  it("stops a reattached runtime by pid", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const reattachedCollected: AgentEvent[] = [];
    const runtime = SessionRuntime.spawn({
      sessionId: "stop-test",
      cmd: process.execPath,
      args: ["-e", 'setInterval(() => {}, 100);'],
      cwd: dir,
      hooks: makeHooks([]),
    });
    const reattached = SessionRuntime.reattach({
      sessionId: "stop-test",
      pid: runtime.pid,
      pidStartTime: processStartTime(runtime.pid),
      logOffset: runtime.offsets.log,
      stderrOffset: runtime.offsets.stderr,
      hooks: makeHooks(reattachedCollected),
    });
    const consume = (async () => {
      for await (const ev of reattached.events()) reattachedCollected.push(ev);
    })();
    await reattached.stop(500);
    await consume;
    // The daemon owns the single stopped terminal event; the runtime only
    // closes its feed here, so it cannot produce a duplicate terminal.
    expect(reattachedCollected).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("refuses to signal a reattached runtime with a mismatched identity", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
    const runtime = SessionRuntime.spawn({
      sessionId: "identity-test",
      cmd: process.execPath,
      args: ["-e", 'setInterval(() => {}, 100);'],
      cwd: dir,
      hooks: makeHooks([]),
    });
    const reattached = SessionRuntime.reattach({
      sessionId: "identity-test",
      pid: runtime.pid,
      pidStartTime: "not-the-process",
      logOffset: runtime.offsets.log,
      stderrOffset: runtime.offsets.stderr,
      hooks: makeHooks([]),
    });
    await reattached.stop(100);
    expect(processAlive(runtime.pid)).toBe(true);
    await runtime.stop(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
