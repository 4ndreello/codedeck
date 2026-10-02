import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateSessionId } = vi.hoisted(() => ({ generateSessionId: vi.fn() }));

vi.mock("../src/core/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/session.js")>();
  return { ...actual, generateSessionId };
});

import { Daemon } from "../src/daemon/daemon.js";
import type { Session } from "../src/core/session.js";
import { fakeSocket, makeTempDir, removeTempDir, restoreEnv, seam, seed } from "./helpers/daemon-seam.js";

type DaemonResponse = {
  result?: { session?: Session; events?: Array<{ sessionId?: string }>; ok?: boolean; queued?: boolean };
  error?: { code: string; message: string };
};

const originalCodedeckDir = process.env.CODEDECK_DIR;
const originalConfigDir = process.env.CODEDECK_CONFIG_DIR;
let dir: string;
let configDir: string;
let daemon: Daemon;

beforeEach(() => {
  dir = makeTempDir("session-id-ipc-");
  configDir = makeTempDir("session-id-ipc-config-");
  process.env.CODEDECK_DIR = dir;
  process.env.CODEDECK_CONFIG_DIR = configDir;
  generateSessionId.mockReset().mockReturnValue("feed000000000001");
  daemon = new Daemon();
  (daemon as unknown as { startDriverForSession: () => Promise<void> }).startDriverForSession = async () => {};
});

afterEach(() => {
  try { seam(daemon).db.close(); } catch {}
  restoreEnv("CODEDECK_DIR", originalCodedeckDir);
  restoreEnv("CODEDECK_CONFIG_DIR", originalConfigDir);
  removeTempDir(dir);
  removeTempDir(configDir);
});

async function request(method: string, params: unknown): Promise<DaemonResponse> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "session-id-ipc", method, params }, socket);
  return JSON.parse(writes[0]!) as DaemonResponse;
}

function seedAmbiguousSessions(): void {
  seed(daemon, "dead000000000001", "working");
  seed(daemon, "dead000000000002", "working");
}

function registerLiveRuntime(id: string) {
  const handle = { done: false, drained: false };
  const getHandle = vi.fn((sessionId: string) => sessionId === id ? handle : undefined);
  const stop = vi.fn(async () => {});
  const send = vi.fn(async () => {});
  seam(daemon).registry.register({
    id: "claude",
    capabilities: () => ({
      streaming: true,
      resume: true,
      fork: false,
      approvals: false,
      usage: false,
      cost: false,
      modelSelection: false,
      nativeDiff: false,
      interrupt: false,
    }),
    getHandle,
    stop,
    send,
    events: async function* () {},
  });
  return { getHandle, stop, send };
}

describe("daemon session ID prefixes", () => {
  it("does not treat a legacy prefix as an allocator collision", async () => {
    seed(daemon, "beef");
    generateSessionId.mockReturnValueOnce("beef123456789abc");

    const response = await request("session.create", {
      prompt: "child",
      agent: "claude",
      cwd: dir,
      noWorktree: true,
    });

    expect(response.result?.session?.id).toBe("beef123456789abc");
    expect(generateSessionId).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["session.patch", { id: "dead", cwd: "/tmp/changed" }],
    ["session.linkNative", { id: "dead", nativeId: "native" }],
    ["session.release", { id: "dead" }],
    ["session.get", { id: "dead" }],
    ["session.rename", { id: "dead", name: "name" }],
    ["session.send", { id: "dead", message: "continue" }],
    ["session.stop", { id: "dead" }],
    ["session.logs", { id: "dead" }],
    ["session.subscribe", { id: "dead" }],
    ["session.diff", { id: "dead" }],
    ["claims.add", { sessionId: "dead", pathGlob: "file.txt", reason: "work" }],
    ["claims.query", { sessionId: "dead" }],
    ["claims.release", { sessionId: "dead", claimId: 1 }],
  ])("returns candidate IDs for ambiguous %s lookup", async (method, params) => {
    seedAmbiguousSessions();

    const response = await request(method, params);

    expect(response.result).toBeUndefined();
    expect(response.error).toEqual({
      code: "SESSION_AMBIGUOUS",
      message: 'Ambiguous session ID "dead". Matches: dead000000000001, dead000000000002',
    });
  });

  it("creates without a parent when parentId is an ambiguous prefix", async () => {
    seedAmbiguousSessions();

    const response = await request("session.create", {
      prompt: "child",
      agent: "claude",
      cwd: dir,
      noWorktree: true,
      parentId: "dead",
    });

    expect(response.error).toBeUndefined();
    expect(response.result?.session?.parentId ?? null).toBeNull();
  });

  it("does not infer a parent from a unique prefix", async () => {
    seed(daemon, "cafe000000000001");

    const response = await request("session.create", {
      prompt: "child",
      agent: "claude",
      cwd: dir,
      noWorktree: true,
      parentId: "cafe",
    });

    expect(response.error).toBeUndefined();
    expect(response.result?.session?.parentId ?? null).toBeNull();
  });

  it("uses the canonical ID for session, event, claim, subscription, and parent operations", async () => {
    const id = "cafe000000000001";
    seed(daemon, id, "working", { origin: "open" });
    const now = new Date().toISOString();
    seam(daemon).events.append(id, {
      type: "message",
      sessionId: id,
      timestamp: now,
      role: "assistant",
      content: "hello",
    });

    const got = await request("session.get", { id: "cafe" });
    expect(got.result?.session?.id).toBe(id);

    const renamed = await request("session.rename", { id: "cafe", name: "renamed" });
    expect(renamed.result).toBeDefined();
    expect(seam(daemon).sessions.getExact(id)?.name).toBe("renamed");

    const logs = await request("session.logs", { id: "cafe" });
    expect(logs.result?.session?.id).toBe(id);
    expect(logs.result?.events?.[0]?.sessionId).toBe(id);

    const claim = await request("claims.add", { sessionId: "cafe", pathGlob: "file.txt", reason: "test" });
    const claimId = (claim.result as { claim: { id: number; sessionId: string } }).claim.id;
    expect((claim.result as { claim: { sessionId: string } }).claim.sessionId).toBe(id);
    const claims = await request("claims.query", { sessionId: "cafe" });
    expect((claims.result as { claims: Array<{ sessionId: string }> }).claims[0]?.sessionId).toBe(id);
    await request("claims.release", { sessionId: "cafe", claimId });

    seam(daemon).sessions.setStatus(id, "completed");
    seam(daemon).events.append(id, {
      type: "session.completed",
      sessionId: id,
      timestamp: new Date().toISOString(),
      reason: "done",
    });
    const subscribed = await request("session.subscribe", { id: "cafe" });
    expect((subscribed as unknown as { type: string; id: string }).id).toBe(id);
    const child = await request("session.create", {
      prompt: "child",
      agent: "claude",
      cwd: dir,
      noWorktree: true,
      parentId: id,
    });
    expect(child.result?.session?.parentId).toBe(id);
  });

  it("stops a live runtime addressed by its unique short prefix", async () => {
    const id = "babe000000000001";
    const driver = registerLiveRuntime(id);
    seed(daemon, id, "working", { origin: "run" });

    const response = await request("session.stop", { id: "babe" });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ ok: true });
    expect(driver.getHandle).toHaveBeenNthCalledWith(1, id);
    expect(driver.stop).toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(seam(daemon).sessions.getExact(id)?.status).toBe("stopped");
  });

  it("queues a send behind a live runtime addressed by its unique short prefix", async () => {
    const id = "face000000000001";
    const driver = registerLiveRuntime(id);
    seed(daemon, id, "working", { origin: "run" });

    const response = await request("session.send", { id: "face", message: "follow-up" });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ ok: true, queued: true });
    expect(driver.getHandle).toHaveBeenNthCalledWith(1, id);
    expect(driver.send).not.toHaveBeenCalled();
    expect(seam(daemon).sessions.getExact(id)?.pendingMessage).toBe("follow-up");
    expect(seam(daemon).events.list(id, 10).map((event) => event.type)).toContain("message.queued");
  });
});
