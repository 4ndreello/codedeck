import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Windows as the daemon sees it: no process start times, so every live PID
// is "unknown". Liveness stays real unless a test steers it; killTree is a
// spy so nothing here can signal a real process.
vi.mock("../src/utils/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/process.js")>();
  return {
    ...actual,
    processStartTime: () => undefined,
    processAlive: vi.fn(actual.processAlive),
    pidIdentity: (
      pid: number | null | undefined,
      recorded: string | null | undefined,
      deps: import("../src/utils/process.js").PidIdentityDeps = {},
    ) => actual.pidIdentity(pid, recorded, { ...deps, platform: "win32" }),
    killTree: vi.fn(async () => {}),
  };
});

import { Daemon, livePidIdentity } from "../src/daemon/daemon.js";
import { SessionRuntime } from "../src/drivers/session-runtime.js";
import type { Session } from "../src/core/session.js";
import { killTree, processAlive, sleep } from "../src/utils/process.js";
import { makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

const mockedKillTree = vi.mocked(killTree);
const mockedAlive = vi.mocked(processAlive);
const DEAD_PID = 999_999;
let dir: string;

beforeEach(() => {
  dir = makeTempDir("windows-pid-");
  process.env.CODEDECK_DIR = dir;
  mockedKillTree.mockClear();
});

afterEach(() => {
  mockedAlive.mockRestore();
  delete process.env.CODEDECK_DIR;
  removeTempDir(dir);
});

function row(status: Session["status"], pid: number): Session {
  const now = new Date();
  return { id: "s", agent: "claude", status, cwd: "/tmp", createdAt: now, updatedAt: now, pid } as Session;
}

function withHandle(daemon: Daemon, handle: unknown): void {
  const driver = (daemon as unknown as {
    registry: { get(agent: "claude"): { getHandle?: (id: string) => unknown } };
  }).registry.get("claude");
  driver.getHandle = () => handle;
}

describe("livePidIdentity without start times", () => {
  it("trusts a live unknown PID only while the session could still own it", () => {
    expect(livePidIdentity(row("working", process.pid))).toBe(true);
    expect(livePidIdentity(row("orphaned", process.pid))).toBe(true);

    // A finished row keeps its pid; on Windows that PID is soon a stranger's.
    for (const status of ["completed", "failed", "stopped", "interrupted"] as const) {
      expect(livePidIdentity(row(status, process.pid))).toBe(false);
    }
  });

  it("drops an unknown PID once this daemon saw the process exit", () => {
    expect(livePidIdentity(row("working", process.pid), true)).toBe(false);
  });

  it("reports a dead PID as not live", () => {
    expect(livePidIdentity(row("working", DEAD_PID))).toBe(false);
  });
});

describe("daemon recover without start times", () => {
  it("keeps a live open session working instead of failing it as pid_reused", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-open", "working", { origin: "open", pid: process.pid });

    await seam(daemon).recover();

    expect(seam(daemon).sessions.get("s-open")?.status).toBe("working");
    expect(seam(daemon).events.list("s-open", 10).filter((e) => e.type === "session.failed")).toHaveLength(0);
  });

  it("completes an open session whose process is gone", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-gone", "working", { origin: "open", pid: DEAD_PID });

    await seam(daemon).recover();

    expect(seam(daemon).sessions.get("s-gone")?.status).toBe("completed");
  });
});

describe("daemon shutdown without start times", () => {
  it("does not signal a PID it cannot identify and holds no runtime for", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-unknown", "working", { pid: 4242 });

    await daemon.handleShutdown("SIGTERM");

    expect(mockedKillTree).not.toHaveBeenCalled();
  });

  it("signals a PID whose runtime this daemon still holds", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-owned", "working", { pid: 4242 });
    withHandle(daemon, { done: false, drainForShutdown: async () => {} });

    await daemon.handleShutdown("SIGTERM");

    expect(mockedKillTree).toHaveBeenCalledWith(4242, 1500, undefined);
  });

  it("does not signal through a runtime that already saw its process exit", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-done", "working", { pid: 4242 });
    withHandle(daemon, { done: true, drainForShutdown: async () => {} });

    await daemon.handleShutdown("SIGTERM");

    expect(mockedKillTree).not.toHaveBeenCalled();
  });
});

describe("SessionRuntime.stop without start times", () => {
  it("never kills a PID after the runtime saw its process exit", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-done-"));
    try {
      const runtime = SessionRuntime.spawn({
        sessionId: "s-done",
        cmd: process.execPath,
        args: ["-e", ""],
        cwd,
        hooks: { onLine: () => {}, synthesizeTerminal: () => [] },
      });
      const deadline = Date.now() + 5000;
      while (!runtime.done) {
        if (Date.now() > deadline) throw new Error("runtime never finished");
        await sleep(25);
      }

      // The PID now belongs to someone else, and nothing can prove otherwise.
      mockedAlive.mockReturnValue(true);
      await runtime.stop();

      expect(mockedKillTree).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
