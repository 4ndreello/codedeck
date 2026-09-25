import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import type { AgentEvent } from "../src/core/events.js";
import type { FailureInfo } from "../src/core/errors.js";
import { isTerminalStatus } from "../src/core/session.js";
import { processStartTime } from "../src/utils/process.js";
import { makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

// The df94 incident: the event loop died on "database is locked" and marked
// a live codex session failed. The harness kept writing its log, so every
// missing event is still on disk past the persisted offset. On boot the
// daemon heals such rows from the log instead of leaving them failed.

let dir: string;
let daemon: Daemon | undefined;
let child: ChildProcess | undefined;

const firstTurn = [
  { type: "thread.started", thread_id: "01a0d643-0000-7000-8000-000000000001" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first turn" } },
];
const secondTurn = [
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "second turn" } },
  { type: "turn.completed", usage: { input_tokens: 5400, output_tokens: 320 } },
];
const ndjson = (lines: object[]) => lines.map((line) => JSON.stringify(line) + "\n").join("");

// What the pre-fix catch in attachDriverEvents wrote.
const lockedFailure: FailureInfo = { code: "UNKNOWN", blame: "harness", retryable: true, detail: "database is locked" };

beforeEach(() => {
  dir = makeTempDir("heal-store-busy-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  try { if (daemon) seam(daemon).db.close(); } catch {}
  daemon = undefined;
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});

function writeLog(id: string, content: string): string {
  const logs = path.join(dir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, `${id}.ndjson`);
  fs.writeFileSync(file, content);
  return file;
}

function seedLockedFailure(id: string, pid: number, pidStartTime: string | undefined, failure: FailureInfo = lockedFailure): void {
  seed(daemon!, id, "failed", {
    agent: "codex",
    nativeSessionId: firstTurn[0]!.thread_id as string,
    pid,
    pidStartTime,
    logOffset: Buffer.byteLength(ndjson(firstTurn)),
    stderrOffset: 0,
    failure,
    lastEvent: failure.detail,
    completedAt: new Date("2026-09-25T02:08:21.000Z"),
  });
  const events = seam(daemon!).events;
  const ts = "2026-09-25T02:08:00.000Z";
  events.append(id, { type: "message", sessionId: id, timestamp: ts, content: "first turn", sourceKey: "log:0:0" } as AgentEvent);
  events.append(id, { type: "session.failed", sessionId: id, timestamp: "2026-09-25T02:08:21.000Z", error: "database is locked", failure } as AgentEvent);
}

function deadPid(): number {
  return spawnSync("true").pid!;
}

describe("healing sessions failed by a locked store", { timeout: 15000 }, () => {
  it("drains a dead harness's log and closes the session at the log's mtime", async () => {
    daemon = new Daemon();
    const log = writeLog("s-dead", ndjson([...firstTurn, ...secondTurn]));
    const endedAt = new Date("2026-09-25T02:10:15.000Z");
    fs.utimesSync(log, endedAt, endedAt);
    seedLockedFailure("s-dead", deadPid(), "boot-1");

    await seam(daemon).recover();

    // Codex writes no terminal frame; completion comes from exit 0, which a
    // reattach cannot observe. Whether a trailing turn.completed may stand in
    // for it is still open, so this pins a terminal outcome, not which one.
    await vi.waitFor(() => expect(isTerminalStatus(seam(daemon!).sessions.get("s-dead")!.status)).toBe(true), { timeout: 8000 });
    const session = seam(daemon).sessions.get("s-dead")!;
    expect(session.completedAt?.toISOString()).toBe(endedAt.toISOString());
    expect(session.lastEvent).not.toMatch(/database is locked/);

    const events = seam(daemon).events.list("s-dead");
    const healed = events.slice(events.findIndex((e) => e.type === "session.failed") + 1);
    expect(healed.map((e) => e.type)).toEqual(expect.arrayContaining(["usage.updated", "turn.completed"]));
    expect(["session.completed", "session.failed"]).toContain(healed.at(-1)?.type);
    expect(healed.some((e) => e.type === "message" && (e as { content?: string }).content === "second turn")).toBe(true);
    // Parsers stamp read time; a drained backlog cannot postdate the log.
    for (const event of healed) expect(event.timestamp).toBe(endedAt.toISOString());
  });

  it("reattaches a live harness and keeps it working", async () => {
    daemon = new Daemon();
    writeLog("s-live", ndjson([...firstTurn, secondTurn[0]!]));
    child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid!;
    await vi.waitFor(() => expect(processStartTime(pid)).toBeDefined());
    seedLockedFailure("s-live", pid, processStartTime(pid));

    await seam(daemon).recover();

    const session = seam(daemon).sessions.get("s-live")!;
    expect(session.status).toBe("working");
    expect(session.completedAt).toBeUndefined();
    await vi.waitFor(() => {
      const contents = seam(daemon!).events.list("s-live").map((e) => (e as { content?: string }).content);
      expect(contents).toContain("second turn");
    }, { timeout: 8000 });
  });

  it("heals rows already classified STORE_BUSY", async () => {
    daemon = new Daemon();
    writeLog("s-code", ndjson([...firstTurn, ...secondTurn]));
    seedLockedFailure("s-code", deadPid(), "boot-1", { code: "STORE_BUSY", blame: "infra", retryable: true, detail: "database is locked" });

    await seam(daemon).recover();

    await vi.waitFor(() => expect(seam(daemon!).sessions.get("s-code")?.lastEvent).not.toMatch(/database is locked|healing/), { timeout: 8000 });
    expect(seam(daemon).events.list("s-code").map((e) => e.type)).toContain("usage.updated");
  });

  it("leaves failures that are not a locked store alone", async () => {
    daemon = new Daemon();
    writeLog("s-task", ndjson([...firstTurn, ...secondTurn]));
    seedLockedFailure("s-task", deadPid(), "boot-1", { code: "TASK_ERROR", blame: "task", retryable: false, detail: "exit code 1" });

    await seam(daemon).recover();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seam(daemon).sessions.get("s-task")?.status).toBe("failed");
    expect(seam(daemon).events.last("s-task")?.type).toBe("session.failed");
  });

  it("leaves a locked-store failure without a log to drain", async () => {
    daemon = new Daemon();
    seedLockedFailure("s-nolog", deadPid(), "boot-1");

    await seam(daemon).recover();

    expect(seam(daemon).sessions.get("s-nolog")?.status).toBe("failed");
  });
});
