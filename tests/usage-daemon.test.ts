import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { RequestMethod } from "../src/daemon/protocol.js";
import { fakeSocket, seed, seam } from "./helpers/daemon-seam.js";

let runAgentDir: string;
let daemon: Daemon | undefined;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
let requestNumber = 0;

beforeEach(() => {
  runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-daemon-"));
  process.env.RUN_AGENT_DIR = runAgentDir;
  requestNumber = 0;
  daemon = new Daemon();
  (daemon as unknown as { startDriverForSession: () => Promise<void> }).startDriverForSession = async () => {};
});

afterEach(() => {
  try { daemon && seam(daemon).db.close(); } catch {}
  daemon = undefined;
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  fs.rmSync(runAgentDir, { recursive: true, force: true });
});

async function request(method: RequestMethod, params: unknown): Promise<Record<string, any>> {
  const { writes, socket } = fakeSocket();
  await seam(daemon!).handleRequest(
    { id: `usage-${++requestNumber}`, method, params },
    socket,
  );
  return JSON.parse(writes[0]);
}

const createParams = (runId: unknown) => ({
  prompt: "collect usage",
  agent: "codex",
  model: "gpt-5.6-luna",
  cwd: runAgentDir,
  noWorktree: true,
  runId,
});

describe("usage daemon methods", () => {
  it("round-trips a created run id through the store and usage.get", async () => {
    const runId = "run-roundtrip";
    const createResponse = await request("session.create", createParams(runId));
    const created = createResponse.result.session;

    expect(created.runId).toBe(runId);
    expect(seam(daemon!).sessions.get(created.id)?.runId).toBe(runId);
    expect(seam(daemon!).sessions.getByRunId(runId).map((session) => session.id)).toEqual([created.id]);

    seam(daemon!).sessions.update(created.id, {
      usage: { inputTokens: 1_200, outputTokens: 800, cachedTokens: 300, cost: 0.42 },
    });
    seed(daemon!, "second-session", "completed", {
      cwd: runAgentDir,
      runId,
      model: "gpt-5.6-luna",
      usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 20, cost: 0.08 },
    });

    const usageResponse = await request("usage.get", { runId });
    expect(usageResponse.result).toEqual({
      runId,
      inputTokens: 1_300,
      outputTokens: 850,
      cachedTokens: 320,
      costUsd: 0.5,
      sessionCount: 2,
      activeSessionCount: 1,
      costComplete: true,
      sessionsWithoutCost: 0,
    });
  });

  it("does not persist a non-string run id", async () => {
    const createResponse = await request("session.create", createParams(42));
    const created = createResponse.result.session;

    expect(seam(daemon!).sessions.get(created.id)?.runId).toBeUndefined();
  });

  it.each([
    ["empty", { runId: "" }],
    ["missing", {}],
  ])("rejects an %s run id", async (_label, params) => {
    const response = await request("usage.get", params);

    expect(response.error).toMatchObject({
      code: "INVALID",
      message: "runId required",
    });
  });

  it("handles usage.query via IPC returning aggregated range and totals", async () => {
    const runId = "query-test-run";
    const createResponse = await request("session.create", createParams(runId));
    const created = createResponse.result.session;

    seam(daemon!).sessions.update(created.id, {
      usage: { inputTokens: 500, outputTokens: 200, cachedTokens: 100, cost: 0.25 },
    });

    const response = await request("usage.query", { period: "all" });
    expect(response.result).toBeDefined();
    expect(response.result.totals.sessionCount).toBe(1);
    expect(response.result.totals.inputTokens).toBe(500);
    expect(response.result.totals.outputTokens).toBe(200);
    expect(response.result.totals.costUsd).toBe(0.25);
    expect(response.result.byAgent.length).toBe(1);
    expect(response.result.byAgent[0].key).toBe("codex");
  });
});

