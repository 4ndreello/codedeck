import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processStartTime, processAlive, killTree } from "../src/utils/process.js";
import { defaultCapabilities } from "../src/core/capabilities.js";
import { Daemon } from "../src/daemon/daemon.js";
import type { Session, SessionStatus } from "../src/core/session.js";
import { fakeSocket, makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("session-adopt-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
  vi.restoreAllMocks();
});

async function callIpc(
  daemon: Daemon,
  method: string,
  params: unknown,
): Promise<{ result?: any; error?: { code: string; message: string } }> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "req-1", method, params }, socket);
  expect(writes.length).toBeGreaterThanOrEqual(1);
  return JSON.parse(writes[0]);
}

describe("session.adopt", () => {
  it("creates a head session with 4-hex canonical id, origin=open, and status=working", async () => {
    const daemon = new Daemon();
    const res = await callIpc(daemon, "session.adopt", {
      agent: "claude",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      name: "orchestrator",
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    const s: Session = res.result.session;
    expect(s.id).toMatch(/^[0-9a-f]{4}$/);
    expect(s.runId).toBe(s.id);
    expect(s.origin).toBe("open");
    expect(s.agent).toBe("claude");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.status).toBe("working");
    expect(s.name).toBe("orchestrator");

    const saved = seam(daemon).sessions.get(s.id);
    expect(saved).toBeDefined();
    expect(saved?.origin).toBe("open");
    expect(saved?.runId).toBe(s.id);
  });

  it("rejects unknown agent with AGENT_NOT_FOUND", async () => {
    const daemon = new Daemon();
    const res = await callIpc(daemon, "session.adopt", {
      agent: "invalid-agent",
      cwd: "/tmp",
    });

    expect(res.error).toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("avoids collision if generated session id already exists", async () => {
    const daemon = new Daemon();
    // Seed an existing 4-hex session
    seed(daemon, "1234", "working");

    const res = await callIpc(daemon, "session.adopt", {
      agent: "claude",
      cwd: "/tmp",
    });

    expect(res.error).toBeUndefined();
    expect(res.result.session.id).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe("session.patch", () => {
  it("patches pid and auto-resolves pidStartTime", async () => {
    const daemon = new Daemon();
    const adopt = await callIpc(daemon, "session.adopt", {
      agent: "claude",
      cwd: "/tmp",
    });
    const id = adopt.result.session.id;

    const patchRes = await callIpc(daemon, "session.patch", {
      id,
      pid: process.pid,
    });

    expect(patchRes.error).toBeUndefined();
    expect(patchRes.result.session.pid).toBe(process.pid);
    expect(patchRes.result.session.pidStartTime).toBe(processStartTime(process.pid));

    const saved = seam(daemon).sessions.get(id);
    expect(saved?.pid).toBe(process.pid);
    expect(saved?.pidStartTime).toBe(processStartTime(process.pid));
  });

  it("patches worktree, branch, baseCommit, and cwd", async () => {
    const daemon = new Daemon();
    const adopt = await callIpc(daemon, "session.adopt", {
      agent: "claude",
      cwd: "/tmp",
    });
    const id = adopt.result.session.id;

    const patchRes = await callIpc(daemon, "session.patch", {
      id,
      worktree: "/tmp/worktree",
      branch: "feat-test",
      baseCommit: "abc1234",
      cwd: "/tmp/worktree",
    });

    expect(patchRes.error).toBeUndefined();
    expect(patchRes.result.session.worktree).toBe("/tmp/worktree");
    expect(patchRes.result.session.branch).toBe("feat-test");
    expect(patchRes.result.session.baseCommit).toBe("abc1234");
    expect(patchRes.result.session.cwd).toBe("/tmp/worktree");
  });

  it("returns SESSION_NOT_FOUND for non-existent session", async () => {
    const daemon = new Daemon();
    const res = await callIpc(daemon, "session.patch", {
      id: "9999",
      pid: 12345,
    });
    expect(res.error).toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

describe("session.release", () => {
  it("transitions active session to completed and records nativeSessionId", async () => {
    const daemon = new Daemon();
    const adopt = await callIpc(daemon, "session.adopt", {
      agent: "claude",
      cwd: "/tmp",
    });
    const id = adopt.result.session.id;

    const relRes = await callIpc(daemon, "session.release", {
      id,
      nativeSessionId: "native-12345",
    });

    expect(relRes.error).toBeUndefined();
    expect(relRes.result.session.status).toBe("completed");
    expect(relRes.result.session.nativeSessionId).toBe("native-12345");

    const saved = seam(daemon).sessions.get(id);
    expect(saved?.status).toBe("completed");
    expect(saved?.nativeSessionId).toBe("native-12345");

    const lastEvent = seam(daemon).events.last(id);
    expect(lastEvent?.type).toBe("session.completed");
  });

  it("transitions active session to failed if requested", async () => {
    const daemon = new Daemon();
    const adopt = await callIpc(daemon, "session.adopt", {
      agent: "claude",
      cwd: "/tmp",
    });
    const id = adopt.result.session.id;

    const relRes = await callIpc(daemon, "session.release", {
      id,
      status: "failed",
      error: "spawn failed: binary not found",
    });

    expect(relRes.error).toBeUndefined();
    expect(relRes.result.session.status).toBe("failed");
    expect(relRes.result.session.lastEvent).toBe("spawn failed: binary not found");

    const saved = seam(daemon).sessions.get(id);
    expect(saved?.status).toBe("failed");

    const lastEvent = seam(daemon).events.last(id);
    expect(lastEvent?.type).toBe("session.failed");
  });

  it("is a no-op 200 if the session is already terminal (e.g. stopped)", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-term", "stopped", { origin: "open", nativeSessionId: "prev-id" });

    const relRes = await callIpc(daemon, "session.release", {
      id: "s-term",
      nativeSessionId: "new-native-id",
    });

    expect(relRes.error).toBeUndefined();
    expect(relRes.result.session.status).toBe("stopped");

    // Status was not overwritten
    const saved = seam(daemon).sessions.get("s-term");
    expect(saved?.status).toBe("stopped");
  });
});

describe("session.send capability rejection", () => {
  it("rejects session.send on head session (origin=open) with CAPABILITY_NOT_SUPPORTED", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-head", "working", { origin: "open" });

    const res = await callIpc(daemon, "session.send", {
      id: "s-head",
      message: "hello head",
    });

    expect(res.error).toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
    expect(res.error?.message).toContain("interactive head session");
  });
});

describe("session.stop head vs workers isolation", () => {
  it("stops head session without touching background workers", async () => {
    const daemon = new Daemon();
    const headPid = 55555;
    const workerPid = 66666;
    const startTime = "12345";

    // Head session
    seed(daemon, "s-head", "working", {
      origin: "open",
      pid: headPid,
      pidStartTime: startTime,
    });

    // Background worker session
    seed(daemon, "s-worker", "working", {
      origin: "run",
      pid: workerPid,
      pidStartTime: startTime,
    });

    const stoppedPids: number[] = [];
    seam(daemon).registry.register({
      id: "claude",
      capabilities: () => ({ ...defaultCapabilities(), resume: true }),
      stop: async (session: { pid?: number }) => {
        if (session.pid) stoppedPids.push(session.pid);
      },
      getHandle: () => undefined,
    });

    // Stop the head session
    const stopRes = await callIpc(daemon, "session.stop", { id: "s-head" });
    expect(stopRes.error).toBeUndefined();

    // Head is stopped
    expect(seam(daemon).sessions.get("s-head")?.status).toBe("stopped");
    expect(stoppedPids).toEqual([headPid]);

    // Worker remains working and was not killed
    expect(seam(daemon).sessions.get("s-worker")?.status).toBe("working");
  });
});

describe("recover Cycle A for head sessions", () => {
  it("marks session failed if pid is null (terminated before patch)", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-nopid", "working", { origin: "open", pid: undefined });

    await seam(daemon).recover();

    const saved = seam(daemon).sessions.get("s-nopid");
    expect(saved?.status).toBe("failed");
    expect(saved?.lastEvent).toBe("open session terminated before patch");
  });

  it("marks session completed if process is no longer alive", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-dead", "working", {
      origin: "open",
      pid: 999999999, // Dead PID
      pidStartTime: "1234",
    });

    await seam(daemon).recover();

    const saved = seam(daemon).sessions.get("s-dead");
    expect(saved?.status).toBe("completed");
    expect(saved?.lastEvent).toBe("closed while daemon was stopped");

    const lastEvent = seam(daemon).events.last("s-dead");
    expect(lastEvent?.type).toBe("session.completed");
  });

  it("keeps session working if process is alive and verified", async () => {
    const daemon = new Daemon();
    const currentStart = processStartTime(process.pid);
    seed(daemon, "s-live", "working", {
      origin: "open",
      pid: process.pid,
      pidStartTime: currentStart,
    });

    await seam(daemon).recover();

    const saved = seam(daemon).sessions.get("s-live");
    expect(saved?.status).toBe("working");
  });

  it("marks session failed if PID was recycled (identity mismatch)", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-recycled", "working", {
      origin: "open",
      pid: process.pid,
      pidStartTime: "mismatched-start-time",
    });

    await seam(daemon).recover();

    const saved = seam(daemon).sessions.get("s-recycled");
    expect(saved?.status).toBe("failed");
    expect(saved?.lastEvent).toContain("no longer identifies the head session");
    expect(saved?.failure?.reason).toBe("pid_reused");

    const lastEvent = seam(daemon).events.last("s-recycled");
    expect(lastEvent?.type).toBe("session.failed");
  });
});
