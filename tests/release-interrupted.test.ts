import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { makeTempDir, removeTempDir, seam, seed, fakeSocket } from "./helpers/daemon-seam.js";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("release-int-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});

interface ReleaseOutcome {
  result?: { session?: { id: string; status: string } };
  error?: { code?: string; message?: string };
}

async function release(daemon: Daemon, params: unknown): Promise<ReleaseOutcome> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.release", params }, socket);
  return JSON.parse(writes[0]) as ReleaseOutcome;
}

describe("session.release archival", () => {
  it("finalizes interrupted as completed", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-int", "interrupted", { origin: "run" });
    const body = await release(daemon, { id: "s-int" });
    expect(body.result?.session?.status).toBe("completed");
    expect(seam(daemon).sessions.get("s-int")?.status).toBe("completed");
    const types = seam(daemon).events.list("s-int", 10).map((e) => e.type);
    expect(types).toContain("session.completed");
  });

  it("finalizes interrupted as failed when asked", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-int", "interrupted", { origin: "run" });
    const body = await release(daemon, { id: "s-int", status: "failed", error: "gave up" });
    expect(body.result?.session?.status).toBe("failed");
    expect(seam(daemon).sessions.get("s-int")?.lastEvent).toBe("gave up");
  });

  it("clears a queued message while archiving", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-int", "interrupted", {
      origin: "run",
      pendingMessage: "stale",
      pendingAt: new Date().toISOString(),
    });
    await release(daemon, { id: "s-int" });
    const stored = seam(daemon).sessions.get("s-int")!;
    expect(stored.status).toBe("completed");
    expect(stored.pendingMessage).toBeUndefined();
  });

  it("leaves other terminal rows untouched", async () => {
    const daemon = new Daemon();
    seed(daemon, "s-done", "completed", { origin: "run" });
    const body = await release(daemon, { id: "s-done" });
    expect(body.result?.session?.status).toBe("completed");
  });

  it("reports unknown sessions", async () => {
    const daemon = new Daemon();
    const body = await release(daemon, { id: "nope" });
    expect(body.error?.code).toBe("SESSION_NOT_FOUND");
  });
});
