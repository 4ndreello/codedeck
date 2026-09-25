import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import { generateSessionId } from "../src/core/session.js";
import type { Session } from "../src/core/session.js";
import { getGitInfo } from "../src/git/repository.js";
import { createWorktree } from "../src/git/worktree.js";
import { fakeSocket, makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

vi.mock("../src/core/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/session.js")>();
  return { ...actual, generateSessionId: vi.fn() };
});
vi.mock("../src/git/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git/repository.js")>();
  return { ...actual, getGitInfo: vi.fn() };
});
vi.mock("../src/git/worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git/worktree.js")>();
  return { ...actual, createWorktree: vi.fn() };
});

type DaemonResponse = {
  result?: { session: Session };
  error?: { code: string; message: string };
};

let dir: string;
let configDir: string;
let daemon: Daemon;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  dir = makeTempDir("session-create-collision-");
  configDir = makeTempDir("session-create-collision-config-");
  process.env.RUN_AGENT_DIR = dir;
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
  vi.mocked(generateSessionId).mockReset();
  vi.mocked(getGitInfo).mockReset().mockResolvedValue(null);
  vi.mocked(createWorktree).mockReset();
  daemon = new Daemon();
  (daemon as unknown as { startDriverForSession: () => Promise<void> }).startDriverForSession = async () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  try { seam(daemon).db.close(); } catch {}
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
  removeTempDir(dir);
  removeTempDir(configDir);
});

async function request(method: string, params: unknown): Promise<DaemonResponse> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "session-create-collision", method, params }, socket);
  return JSON.parse(writes[0]!) as DaemonResponse;
}

async function create(params: Record<string, unknown> = {}): Promise<Session> {
  const response = await request("session.create", {
    prompt: "task",
    agent: "claude",
    cwd: dir,
    noWorktree: true,
    ...params,
  });
  if (!response.result) throw new Error(response.error?.message ?? "session.create failed");
  return response.result.session;
}

async function adopt(): Promise<Session> {
  const response = await request("session.adopt", { agent: "claude", cwd: dir });
  if (!response.result) throw new Error(response.error?.message ?? "session.adopt failed");
  return response.result.session;
}

describe("daemon session ID collisions", () => {
  it("retries an existing id and creates the session with the next id", async () => {
    seed(daemon, "dead", "completed");
    vi.mocked(generateSessionId).mockReturnValueOnce("dead").mockReturnValueOnce("beef");

    const session = await create();

    expect(session.id).toBe("beef");
    expect(seam(daemon).sessions.get("beef")).toMatchObject({ id: "beef", status: "starting" });
    expect(seam(daemon).sessions.list(50, true)).toHaveLength(2);
    expect(generateSessionId).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error after 100 colliding IDs", async () => {
    seed(daemon, "dead", "completed");
    vi.mocked(generateSessionId).mockReturnValue("dead");

    await expect(create()).rejects.toThrow("Unable to generate a unique session ID after 100 attempts");

    expect(generateSessionId).toHaveBeenCalledTimes(100);
    expect(seam(daemon).sessions.list(50, true)).toHaveLength(1);
  });

  it("retries an existing id in session.adopt", async () => {
    seed(daemon, "dead", "completed");
    vi.mocked(generateSessionId).mockReturnValueOnce("dead").mockReturnValueOnce("beef");

    const session = await adopt();

    expect(session.id).toBe("beef");
    expect(generateSessionId).toHaveBeenCalledTimes(2);
  });

  it("reserves ids across concurrent session.create requests", async () => {
    vi.mocked(generateSessionId)
      .mockReturnValueOnce("beef")
      .mockReturnValueOnce("beef")
      .mockReturnValueOnce("cafe");

    const responses = await Promise.all([create(), create()]);
    const ids = responses.map((session) => session.id);

    expect([...ids].sort()).toEqual(["beef", "cafe"]);
    expect(seam(daemon).sessions.list(50, true)).toHaveLength(2);
    expect(generateSessionId).toHaveBeenCalledTimes(3);
  });

  it("releases an id after worktree creation fails", async () => {
    vi.mocked(getGitInfo).mockResolvedValue({ root: dir, head: null, branch: null, isDirty: false });
    vi.mocked(createWorktree)
      .mockRejectedValueOnce(new Error("worktree unavailable"))
      .mockResolvedValueOnce({ path: path.join(dir, "worktree"), branch: "ra/task-beef", baseCommit: null });
    vi.mocked(generateSessionId).mockReturnValueOnce("beef").mockReturnValueOnce("beef");

    const failed = await request("session.create", { prompt: "task", agent: "claude", cwd: dir, worktree: true });
    const retried = await request("session.create", { prompt: "task", agent: "claude", cwd: dir, worktree: true });

    expect(failed.error).toMatchObject({ code: "WORKTREE_FAILED", message: "worktree unavailable" });
    expect(retried.result?.session.id).toBe("beef");
    expect(generateSessionId).toHaveBeenCalledTimes(2);
  });

  it("releases an id when git info lookup fails", async () => {
    vi.mocked(getGitInfo).mockRejectedValueOnce(new Error("git lookup failed"));
    vi.mocked(generateSessionId).mockReturnValueOnce("beef").mockReturnValueOnce("beef");

    await expect(create()).rejects.toThrow("git lookup failed");
    const retried = await create();

    expect(retried.id).toBe("beef");
    expect(generateSessionId).toHaveBeenCalledTimes(2);
  });

  it("releases an id when shutdown starts after git info lookup", async () => {
    vi.mocked(getGitInfo).mockImplementationOnce(async () => {
      (daemon as unknown as { shuttingDown: boolean }).shuttingDown = true;
      return null;
    });
    vi.mocked(generateSessionId).mockReturnValueOnce("beef").mockReturnValueOnce("beef");

    const shuttingDown = await request("session.create", { prompt: "task", agent: "claude", cwd: dir });
    (daemon as unknown as { shuttingDown: boolean }).shuttingDown = false;
    const retried = await create();

    expect(shuttingDown.error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(retried.id).toBe("beef");
    expect(generateSessionId).toHaveBeenCalledTimes(2);
  });

  it("releases an id when session persistence throws", async () => {
    vi.spyOn(seam(daemon).sessions, "create").mockImplementationOnce(() => {
      throw new Error("session store unavailable");
    });
    vi.mocked(generateSessionId).mockReturnValueOnce("beef").mockReturnValueOnce("beef");

    await expect(create()).rejects.toThrow("session store unavailable");
    const retried = await create();

    expect(retried.id).toBe("beef");
    expect(generateSessionId).toHaveBeenCalledTimes(2);
  });
});
