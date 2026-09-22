import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { RequestMethod } from "../src/daemon/protocol.js";
import { parseClaudeLine } from "../src/drivers/claude/parser.js";
import { parseCodexLine } from "../src/drivers/codex/parser.js";
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

async function feedLines(
  sessionId: string,
  lines: string[],
  parse: (line: string, sessionId: string) => any[],
  sourcePrefix: string,
): Promise<void> {
  let eventIndex = 0;
  const driver = {
    getOffsets: () => undefined,
    async *events() {
      for (const line of lines) {
        for (const event of parse(line, sessionId)) {
          yield { ...event, sourceKey: `${sourcePrefix}:${eventIndex++}` };
        }
      }
    },
  };
  await (daemon as any).attachDriverEvents(sessionId, driver, {});
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
      orchestrator: {
        costUsd: 0,
        costComplete: true,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        sources: [],
      },
      total: { costUsd: 0.5 },
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

  it("keeps cumulative usage updates at the source high-water mark", async () => {
    const createResponse = await request("session.create", createParams("run-cumulative"));
    const created = createResponse.result.session;

    const daemonAny = daemon as any;
    daemonAny.updateSessionFromEvent(created.id, {
      type: "usage.updated",
      sessionId: created.id,
      timestamp: new Date().toISOString(),
      usage: { inputTokens: 300, outputTokens: 40, cachedTokens: 10, cost: 0.02 },
    });
    let sess = seam(daemon!).sessions.get(created.id);
    expect(sess?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      cachedTokens: 10,
      cost: 0.02,
    });

    daemonAny.updateSessionFromEvent(created.id, {
      type: "usage.updated",
      sessionId: created.id,
      timestamp: new Date().toISOString(),
      usage: { inputTokens: 500, outputTokens: 100, cachedTokens: 0, cost: 0.1 },
    });
    sess = seam(daemon!).sessions.get(created.id);
    expect(sess?.usage).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 10,
      cost: 0.1,
    });
  });

  it("accumulates incremental events without cost and computes table cost on usage.get", async () => {
    const runId = "run-incremental-no-cost";
    const createResponse = await request("session.create", {
      ...createParams(runId),
      agent: "opencode",
      model: "alibaba-token-plan/qwen3.8-max",
    });
    const created = createResponse.result.session;
    const daemonAny = daemon as any;

    // Step 1: incremental usage with cost: undefined (OpenCode behavior)
    daemonAny.updateSessionFromEvent(created.id, {
      type: "usage.updated",
      sessionId: created.id,
      timestamp: new Date().toISOString(),
      incremental: true,
      usage: { inputTokens: 500_000, outputTokens: 250_000, cachedTokens: 500_000, cost: undefined },
    });

    // Step 2: second step incremental usage with cost: undefined
    daemonAny.updateSessionFromEvent(created.id, {
      type: "usage.updated",
      sessionId: created.id,
      timestamp: new Date().toISOString(),
      incremental: true,
      usage: { inputTokens: 500_000, outputTokens: 250_000, cachedTokens: 500_000, cost: undefined },
    });

    const sess = seam(daemon!).sessions.get(created.id);
    expect(sess?.usage?.inputTokens).toBe(1_000_000);
    expect(sess?.usage?.outputTokens).toBe(500_000);
    expect(sess?.usage?.cachedTokens).toBe(1_000_000);
    expect(sess?.usage?.cost).toBeUndefined();

    // Query usage: should compute cost using alibaba-token-plan/qwen3.8-max table price:
    // (1M * 2.0 + 0.5M * 6.0 + 1M * 0.2) = 5.2
    const usageResponse = await request("usage.get", { runId });
    expect(usageResponse.result.inputTokens).toBe(1_000_000);
    expect(usageResponse.result.outputTokens).toBe(500_000);
    expect(usageResponse.result.cachedTokens).toBe(1_000_000);
    expect(usageResponse.result.costUsd).toBeCloseTo(5.2, 5);
    expect(usageResponse.result.costComplete).toBe(true);
    expect(usageResponse.result.sessionsWithoutCost).toBe(0);
  });

  it("adds cumulative Claude cost across processes and ignores replayed lines", async () => {
    const sessionId = "claude-worker";
    seed(daemon!, sessionId, "working", { agent: "claude", runId: "claude-run" });
    const firstLines = fs.readFileSync(
      path.join(process.cwd(), "tests/fixtures/usage/claude-process-1.jsonl"),
      "utf-8",
    ).trim().split("\n");
    const secondLines = fs.readFileSync(
      path.join(process.cwd(), "tests/fixtures/usage/claude-process-2.jsonl"),
      "utf-8",
    ).trim().split("\n");

    await feedLines(sessionId, firstLines, parseClaudeLine, "claude-process-1");
    expect(seam(daemon!).sessions.get(sessionId)?.usage?.cost).toBeCloseTo(0.46615920000000005);

    await feedLines(sessionId, firstLines, parseClaudeLine, "claude-process-1");
    expect(seam(daemon!).sessions.get(sessionId)?.usage?.cost).toBeCloseTo(0.46615920000000005);

    await feedLines(sessionId, secondLines, parseClaudeLine, "claude-process-2");
    expect(seam(daemon!).sessions.get(sessionId)?.usage?.cost).toBeCloseTo(0.6278055);
  });

  it("keeps the latest cumulative Codex thread token totals", async () => {
    const sessionId = "codex-worker";
    seed(daemon!, sessionId, "working", { agent: "codex", runId: "codex-run" });
    const lines = fs.readFileSync(
      path.join(process.cwd(), "tests/fixtures/usage/codex-thread.jsonl"),
      "utf-8",
    ).trim().split("\n");

    await feedLines(sessionId, lines, parseCodexLine, "codex-thread");

    expect(seam(daemon!).sessions.get(sessionId)?.usage).toMatchObject({
      inputTokens: 10_891_738,
      outputTokens: 611,
      cachedTokens: 10_551_808,
    });
  });
});
