import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { Session } from "../src/core/session.js";
import { fakeSocket, seam } from "./helpers/daemon-seam.js";

let runAgentDir: string;
let configDir: string;
let daemon: Daemon;
let requestNumber: number;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-lineage-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-lineage-config-"));
  process.env.RUN_AGENT_DIR = runAgentDir;
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
  requestNumber = 0;
  daemon = new Daemon();
  (daemon as unknown as { startDriverForSession: () => Promise<void> }).startDriverForSession = async () => {};
});

afterEach(() => {
  try { seam(daemon).db.close(); } catch {}
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
  fs.rmSync(runAgentDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function call(method: string, params: Record<string, unknown>): Promise<Session> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: `lineage-${++requestNumber}`, method, params }, socket);
  const response = JSON.parse(writes[0]) as { result: { session: Session } };
  const session = seam(daemon).sessions.get(response.result.session.id);
  if (!session) throw new Error("session was not persisted");
  return session;
}

const run = (extra: Record<string, unknown>) =>
  call("session.create", { prompt: "task", agent: "claude", cwd: runAgentDir, noWorktree: true, ...extra });

describe("session lineage", () => {
  it("records the open session's role and each run's dispatcher", async () => {
    const root = await call("session.adopt", { agent: "claude", cwd: runAgentDir, name: "general", role: "general" });
    expect(root.role).toBe("general");
    expect(root.parentId).toBeUndefined();

    const worker = await run({ runId: root.id, parentId: root.id, role: "general" });
    const reviewer = await run({ runId: root.id, parentId: worker.id, role: "rev" });

    expect(worker.parentId).toBe(root.id);
    expect(reviewer.parentId).toBe(worker.id);
    expect(reviewer.runId).toBe(root.id);
    expect(reviewer.role).toBe("reviewer");
  });

  it("drops a parent the store does not know", async () => {
    const orphan = await run({ parentId: "nope-not-a-session", role: "nonsense" });
    expect(orphan.parentId).toBeUndefined();
    expect(orphan.role).toBeUndefined();
  });

  it("inherits the parent's run when the request carries none", async () => {
    const root = await call("session.adopt", { agent: "claude", cwd: runAgentDir, name: "general" });
    const worker = await run({ parentId: root.id });
    expect(worker.runId).toBe(root.id);
  });
});
