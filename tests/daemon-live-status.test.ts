import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { makeTempDir, removeTempDir, seam, seed, fakeSocket } from "./helpers/daemon-seam.js";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("live-status-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});

async function listStatuses(daemon: Daemon): Promise<string[]> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.list", params: { all: true } }, socket);
  const body = JSON.parse(writes[0]) as { result?: { sessions?: { id: string; status: string }[] } };
  return (body.result?.sessions ?? []).map((s) => `${s.id}:${s.status}`);
}

describe("session.list liveness guard", () => {
  it("reports dead for a working session whose process is gone", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-corpse", "working", { pid: 999999999 });
    expect(await listStatuses(daemon)).toContain("s-corpse:dead");
  });

  it("keeps working for a working session whose process is alive", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-live", "working", { pid: process.pid });
    expect(await listStatuses(daemon)).toContain("s-live:working");
  });

  it("keeps a terminal status even when its pid is gone", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-done", "completed", { pid: 999999999 });
    expect(await listStatuses(daemon)).toContain("s-done:completed");
  });

  it("does not mutate the stored row", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-corpse", "working", { pid: 999999999 });
    await listStatuses(daemon);
    expect(seam(daemon).sessions.get("s-corpse")?.status).toBe("working");
  });

  it("session.get reports dead for the same corpse", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-corpse", "working", { pid: 999999999 });
    const { writes, socket } = fakeSocket();
    await seam(daemon).handleRequest({ id: "r2", method: "session.get", params: { id: "s-corpse" } }, socket);
    const body = JSON.parse(writes[0]) as { result?: { session?: { status: string } } };
    expect(body.result?.session?.status).toBe("dead");
  });
});
