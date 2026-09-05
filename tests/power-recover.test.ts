import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processStartTime } from "../src/utils/process.js";
import { defaultCapabilities } from "../src/core/capabilities.js";
import { Daemon } from "../src/daemon/daemon.js";
import { makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("power-recover-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});


function installAttachSpy(daemon: Daemon, attached: unknown[]): void {
  seam(daemon).registry.register({
    id: "claude",
    capabilities: () => ({ ...defaultCapabilities(), resume: true }),
    attach: async (req: unknown) => { attached.push(req); },
  });
}

describe("power recover ignores interrupted", () => {
  it("leaves an interrupted row with a live pid untouched", async () => {
    const daemon = new Daemon();
    const attached: unknown[] = [];
    installAttachSpy(daemon, attached);
    seed(daemon, "s-live", "interrupted", {
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
      nativeSessionId: "n-live",
    });

    await seam(daemon).recover();

    expect(seam(daemon).sessions.get("s-live")?.status).toBe("interrupted");
    expect(seam(daemon).events.count("s-live")).toBe(0);
    expect(attached).toHaveLength(0);
  });

  it("leaves an interrupted row with a dead pid untouched", async () => {
    const daemon = new Daemon();
    const attached: unknown[] = [];
    installAttachSpy(daemon, attached);
    seed(daemon, "s-dead", "interrupted", { pid: 999999999, pidStartTime: "gone" });

    await seam(daemon).recover();

    expect(seam(daemon).sessions.get("s-dead")?.status).toBe("interrupted");
    expect(seam(daemon).events.count("s-dead")).toBe(0);
    expect(attached).toHaveLength(0);
  });

  it("keeps pid_reused classification for active rows", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-reused", "working", { pid: process.pid, pidStartTime: "stale-tick" });

    await seam(daemon).recover();

    const s = seam(daemon).sessions.get("s-reused");
    expect(s?.status).toBe("failed");
    expect(s?.failure).toMatchObject({ code: "HARNESS_CRASH", reason: "pid_reused" });
    expect(seam(daemon).events.last("s-reused")?.type).toBe("session.failed");
  });

  it("still fails an active row whose pid is gone", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-gone", "working", { pid: 999999999 });

    await seam(daemon).recover();

    expect(seam(daemon).sessions.get("s-gone")?.status).toBe("failed");
  });
});
