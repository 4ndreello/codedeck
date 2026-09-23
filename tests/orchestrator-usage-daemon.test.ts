import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { RequestMethod } from "../src/daemon/protocol.js";
import type { Session } from "../src/core/session.js";
import { processStartTime } from "../src/utils/process.js";
import { fakeSocket, makeTempDir, removeTempDir, seed, seam } from "./helpers/daemon-seam.js";

let runAgentDir: string;
let homeDir: string;
let daemon: Daemon | undefined;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const originalHome = process.env.HOME;
let signalListenerSnapshot = new Map<string, Function[]>();
let requestNumber = 0;

const shutdownSignals = ["SIGTERM", "SIGINT", "SIGHUP"];

async function closeStartedDaemon(instance: Daemon): Promise<void> {
  const daemonAny = instance as any;
  if (daemonAny.server?.listening) {
    await new Promise<void>((resolve) => daemonAny.server.close(() => resolve()));
  }
  for (const name of ["daemon.sock", "daemon.pid"]) {
    try { fs.unlinkSync(path.join(runAgentDir, name)); } catch {}
  }
  try { daemonAny.db.close(); } catch {}
}

function removeAddedSignalListeners(): void {
  for (const signal of shutdownSignals) {
    const previous = signalListenerSnapshot.get(signal) ?? [];
    for (const listener of process.listeners(signal as NodeJS.Signals)) {
      if (!previous.includes(listener)) process.removeListener(signal as NodeJS.Signals, listener as (...args: any[]) => void);
    }
  }
}

beforeEach(() => {
  runAgentDir = makeTempDir("orchestrator-usage-daemon-");
  homeDir = makeTempDir("orchestrator-usage-home-");
  process.env.RUN_AGENT_DIR = runAgentDir;
  process.env.HOME = homeDir;
  requestNumber = 0;
  signalListenerSnapshot = new Map(
    shutdownSignals.map((signal) => [signal, process.listeners(signal as NodeJS.Signals)]),
  );
  daemon = new Daemon();
});

afterEach(async () => {
  if (daemon) await closeStartedDaemon(daemon);
  try { daemon && seam(daemon).db.close(); } catch {}
  daemon = undefined;
  removeAddedSignalListeners();
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  removeTempDir(runAgentDir);
  removeTempDir(homeDir);
});

async function request(method: RequestMethod, params: unknown): Promise<Record<string, any>> {
  const { writes, socket } = fakeSocket();
  await seam(daemon!).handleRequest(
    { id: `orchestrator-${++requestNumber}`, method, params },
    socket,
  );
  return JSON.parse(writes[0]);
}

function seedOpen(id: string, extra: Partial<Session> = {}): void {
  seed(daemon!, id, "working", { runId: id, origin: "open", agent: "claude", ...extra });
}

function transcriptFile(nativeId: string): string {
  const projectDir = path.join(homeDir, ".claude", "projects", "fixture-project");
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, `${nativeId}.jsonl`);
}

function installTranscript(nativeId: string, fixture: string): void {
  fs.copyFileSync(
    path.join(process.cwd(), "tests/fixtures/usage", fixture),
    transcriptFile(nativeId),
  );
}

function assistantLine(
  messageId: string,
  requestId: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  paddingBytes = 0,
): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    message: {
      id: messageId,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedTokens,
      },
    },
    ...(paddingBytes > 0 ? { padding: "x".repeat(paddingBytes) } : {}),
  });
}

function liveCursor(nativeId: string): Record<string, any> | undefined {
  return (daemon as any).liveTranscriptCursors.get(nativeId);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("orchestrator usage daemon methods", () => {
  it("links multiple native ids to an open row and reports whether each link was created", async () => {
    seedOpen("open-link-row");

    await expect(request("session.linkNative", { id: "open-link-row", nativeId: "native-x" }))
      .resolves.toMatchObject({ result: { created: true } });
    await expect(request("session.linkNative", { id: "open-link-row", nativeId: "native-y" }))
      .resolves.toMatchObject({ result: { created: true } });
    await expect(request("session.linkNative", { id: "open-link-row", nativeId: "native-x" }))
      .resolves.toMatchObject({ result: { created: false } });

    const links = (daemon as any).nativeLinks.linksFor(["open-link-row"]);
    expect(links.map((link: { nativeId: string }) => link.nativeId)).toEqual(["native-x", "native-y"]);
  });

  it("records a finite live cost observation and returns updated run usage", async () => {
    seedOpen("open-observe-row");
    const response = await request("usage.get", {
      runId: "open-observe-row",
      observe: { nativeId: "native-observed", costUsd: 1.25 },
    });

    expect(response.result).toMatchObject({
      runId: "open-observe-row",
      sessionCount: 0,
      costComplete: true,
      costUsd: 0,
      orchestrator: {
        costUsd: 1.25,
        sources: [{ nativeId: "native-observed", costUsd: 1.25 }],
      },
      total: { costUsd: 1.25 },
    });
    expect((daemon as any).nativeLinks.linksFor(["open-observe-row"])).toMatchObject([
      { nativeId: "native-observed", state: null },
    ]);
  });

  it("seeds legacy Claude usage into the incoming source when no prior usage event exists", () => {
    const sessionId = "legacy-claude-no-prior";
    const nativeId = "native-no-prior";
    seed(daemon!, sessionId, "working", {
      agent: "claude",
      nativeSessionId: nativeId,
      usage: { cost: 0.4 },
    });
    const events = seam(daemon!).events;
    const timestamp = new Date().toISOString();
    events.append(sessionId, {
      type: "session.started",
      sessionId,
      timestamp,
      agent: "claude",
      nativeSessionId: nativeId,
    });
    const nextUsage = {
      type: "usage.updated" as const,
      sessionId,
      timestamp,
      usage: { cost: 0.5 },
    };
    const sequence = events.append(sessionId, nextUsage);

    (daemon as any).updateSessionFromEvent(sessionId, nextUsage, sequence);

    expect(seam(daemon!).sessions.get(sessionId)?.usage?.cost).toBeCloseTo(0.5, 8);
  });

  it("keeps legacy Claude usage when the next process reports its own cost", () => {
    const sessionId = "legacy-claude-row";
    const nativeId = "native-legacy";
    seed(daemon!, sessionId, "working", {
      agent: "claude",
      nativeSessionId: nativeId,
      usage: { cost: 0.4661592 },
    });
    const events = seam(daemon!).events;
    const timestamp = new Date().toISOString();
    events.append(sessionId, {
      type: "session.started",
      sessionId,
      timestamp,
      agent: "claude",
      nativeSessionId: nativeId,
    });
    events.append(sessionId, {
      type: "usage.updated",
      sessionId,
      timestamp,
      usage: { cost: 0.4661592 },
    });
    events.append(sessionId, {
      type: "session.started",
      sessionId,
      timestamp,
      agent: "claude",
      nativeSessionId: nativeId,
    });
    const nextUsage = {
      type: "usage.updated" as const,
      sessionId,
      timestamp,
      usage: { cost: 0.1616463 },
    };
    const sequence = events.append(sessionId, nextUsage);

    (daemon as any).updateSessionFromEvent(sessionId, nextUsage, sequence);

    expect(seam(daemon!).sessions.get(sessionId)?.usage?.cost).toBeCloseTo(0.6278055, 8);
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid observed cost %s",
    async (costUsd) => {
      seedOpen("open-invalid-observe");

      const response = await request("usage.get", {
        runId: "open-invalid-observe",
        observe: { nativeId: "native-invalid", costUsd },
      });

      expect(response.error?.code).toBe("INVALID");
      expect((daemon as any).nativeLinks.linksFor(["open-invalid-observe"])).toEqual([]);
    },
  );

  it("drops valid observations when the run is missing or its row is not open", async () => {
    seed(daemon!, "worker-run-row", "working", {
      runId: "worker-run-row",
      origin: "run",
      agent: "codex",
    });

    const missing = await request("usage.get", {
      runId: "missing-open-row",
      observe: { nativeId: "native-drop", costUsd: 2 },
    });
    const nonOpen = await request("usage.get", {
      runId: "worker-run-row",
      observe: { nativeId: "native-drop", costUsd: 2 },
    });

    expect(missing.result.runId).toBe("missing-open-row");
    expect(nonOpen.result.runId).toBe("worker-run-row");
    expect((daemon as any).nativeLinks.linksFor(["worker-run-row"])).toEqual([]);
    expect(seam(daemon!).sessions.get("worker-run-row")?.usage).toBeUndefined();
  });

  it("returns SESSION_NOT_FOUND for a missing link target and ignores non-open rows", async () => {
    seed(daemon!, "worker-link-row", "working", { origin: "run" });

    const missing = await request("session.linkNative", { id: "absent", nativeId: "native-x" });
    const worker = await request("session.linkNative", { id: "worker-link-row", nativeId: "native-x" });

    expect(missing.error?.code).toBe("SESSION_NOT_FOUND");
    expect(worker.result).toEqual({ created: false });
    expect((daemon as any).nativeLinks.linksFor(["worker-link-row"])).toEqual([]);
  });

  it("reconciles transcript high-water totals across two open rows", async () => {
    const nativeId = "native-shared";
    seedOpen("row-a");
    seedOpen("row-b");

    await request("session.linkNative", { id: "row-a", nativeId });
    await request("usage.get", { runId: "row-a", observe: { nativeId, costUsd: 4 } });
    await request("usage.get", { runId: "row-a", observe: { nativeId, costUsd: 3.5 } });
    installTranscript(nativeId, "cost-state-10.jsonl");
    const releasedA = await request("session.release", { id: "row-a" });
    expect(releasedA.result.session.status).toBe("completed");

    await request("session.linkNative", { id: "row-b", nativeId });
    await request("usage.get", { runId: "row-b", observe: { nativeId, costUsd: 10 } });
    await request("usage.get", { runId: "row-b", observe: { nativeId, costUsd: 12 } });
    installTranscript(nativeId, "cost-state-15.jsonl");
    await request("session.release", { id: "row-b" });

    expect(seam(daemon!).sessions.get("row-a")?.usage).toMatchObject({
      cost: 10,
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 35,
    });
    expect(seam(daemon!).sessions.get("row-b")?.usage).toMatchObject({
      cost: 5,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 20,
    });
    const query = await request("usage.query", { period: "all" });
    expect(query.result.byOrigin.find((bucket: { key: string }) => bucket.key === "orchestrator").costUsd)
      .toBe(15);
  });

  it("reconciles a previously linked native id after resuming its row", async () => {
    const nativeId = "native-resumed";
    seedOpen("row-resumed", { nativeSessionId: nativeId });
    installTranscript(nativeId, "cost-state-10.jsonl");

    await request("session.linkNative", { id: "row-resumed", nativeId });
    await request("session.release", { id: "row-resumed" });
    expect(seam(daemon!).sessions.get("row-resumed")?.usage?.cost).toBe(10);

    const adopted = await request("session.adopt", {
      agent: "claude",
      cwd: "/tmp",
      resume: nativeId,
    });
    expect(adopted.result.session.id).toBe("row-resumed");
    await request("session.linkNative", { id: "row-resumed", nativeId });
    installTranscript(nativeId, "cost-state-15.jsonl");
    await request("session.release", { id: "row-resumed" });

    expect(seam(daemon!).sessions.get("row-resumed")?.usage?.cost).toBe(15);
    await (daemon as any).reconcileOpenUsage("row-resumed");
    expect(seam(daemon!).sessions.get("row-resumed")?.usage?.cost).toBe(15);
    expect((daemon as any).usageLedger.attributionsFor(["row-resumed"])).toMatchObject([
      { sourceKey: "claude-open:native-resumed", cost: 15 },
    ]);
  });

  it("keeps the known state of a reconciled link whose transcript later disappears", async () => {
    seedOpen("row-vanished");
    installTranscript("native-gone", "cost-state-10.jsonl");
    await request("session.linkNative", { id: "row-vanished", nativeId: "native-gone" });
    await request("session.release", { id: "row-vanished" });
    expect((daemon as any).nativeLinks.linksFor(["row-vanished"])).toMatchObject([
      { nativeId: "native-gone", state: "cost-state" },
    ]);

    fs.rmSync(transcriptFile("native-gone"));
    await (daemon as any).reconcileOpenUsage("row-vanished");

    expect((daemon as any).nativeLinks.linksFor(["row-vanished"])).toMatchObject([
      { nativeId: "native-gone", state: "cost-state" },
    ]);
    expect(seam(daemon!).sessions.get("row-vanished")?.usage?.cost).toBe(10);
    const query = await request("usage.query", { period: "all" });
    expect(query.result.byOrigin.find((bucket: { key: string }) => bucket.key === "orchestrator"))
      .toMatchObject({ costUsd: 10, costComplete: true });
  });

  it("re-reads reconciled links on release and keeps each source total once", async () => {
    seedOpen("row-multiple-links");
    installTranscript("native-x", "cost-state-10.jsonl");
    await request("session.linkNative", { id: "row-multiple-links", nativeId: "native-x" });
    await request("session.linkNative", { id: "row-multiple-links", nativeId: "native-y" });
    expect(seam(daemon!).sessions.get("row-multiple-links")?.usage?.cost).toBe(10);

    installTranscript("native-x", "cost-state-15.jsonl");
    installTranscript("native-y", "cost-state-3.jsonl");
    await request("session.release", { id: "row-multiple-links" });

    expect(seam(daemon!).sessions.get("row-multiple-links")?.usage?.cost).toBe(18);
    expect((daemon as any).usageLedger.attributionsFor(["row-multiple-links"])).toMatchObject([
      { sourceKey: "claude-open:native-x", cost: 15 },
      { sourceKey: "claude-open:native-y", cost: 3 },
    ]);
  });

  it("links a release native id before final transcript reconciliation", async () => {
    const nativeId = "native-release-flush";
    seedOpen("row-release-flush");
    installTranscript(nativeId, "cost-state-3.jsonl");

    const response = await request("session.release", {
      id: "row-release-flush",
      nativeSessionId: nativeId,
    });

    expect(response.result.session.status).toBe("completed");
    expect(seam(daemon!).sessions.get("row-release-flush")?.usage?.cost).toBe(3);
    expect((daemon as any).nativeLinks.linksFor(["row-release-flush"])).toMatchObject([
      { nativeId, state: "cost-state" },
    ]);
  });

  it("reconciles an earlier linked id when another id is added", async () => {
    seedOpen("row-relink");
    installTranscript("native-x", "cost-state-3.jsonl");
    await request("session.linkNative", { id: "row-relink", nativeId: "native-x" });

    await request("session.linkNative", { id: "row-relink", nativeId: "native-y" });

    expect(seam(daemon!).sessions.get("row-relink")?.usage?.cost).toBe(3);
    expect((daemon as any).nativeLinks.linksFor(["row-relink"])).toMatchObject([
      { nativeId: "native-x", state: "cost-state" },
      { nativeId: "native-y", state: null },
    ]);
  });

  it.each(["completed", "failed"] as const)(
    "releases an open row as %s when its transcript is missing",
    async (status) => {
      const rowId = `row-missing-${status}`;
      seedOpen(rowId);
      await request("session.linkNative", { id: rowId, nativeId: `native-missing-${status}` });

      const response = await request("session.release", { id: rowId, status });

      expect(response.result.session.status).toBe(status);
      expect(seam(daemon!).sessions.get(rowId)?.usage).toBeUndefined();
      expect((daemon as any).nativeLinks.linksFor([rowId])).toMatchObject([
        { state: "missing" },
      ]);
    },
  );

  it("logs transcript read errors, replies to release, and retries at startup", async () => {
    seedOpen("row-reader-error");
    const nativeId = "native-reader-error";
    await request("session.linkNative", { id: "row-reader-error", nativeId });
    const brokenTranscript = transcriptFile(nativeId);
    fs.mkdirSync(brokenTranscript);

    const response = await request("session.release", { id: "row-reader-error" });

    expect(response.result.session.status).toBe("completed");
    expect(fs.readFileSync(path.join(runAgentDir, "daemon.log"), "utf-8"))
      .toContain("usage reconcile failed session=row-reader-error");
    expect((daemon as any).nativeLinks.unreconciled("row-reader-error")).toHaveLength(1);

    fs.rmSync(brokenTranscript, { recursive: true, force: true });
    installTranscript(nativeId, "cost-state-3.jsonl");
    (daemon as any).maybeSpawnInhibit = () => {};
    await daemon!.start();
    await (daemon as any).startupReconcilePromise;

    expect(seam(daemon!).sessions.get("row-reader-error")?.usage?.cost).toBe(3);
    expect((daemon as any).nativeLinks.unreconciled("row-reader-error")).toHaveLength(0);
  });

  it("reconciles stale open rows after startup without reading a live row", async () => {
    seed(daemon!, "startup-interrupted", "interrupted", {
      runId: "startup-interrupted",
      origin: "open",
      agent: "claude",
    });
    seed(daemon!, "startup-dead", "working", {
      runId: "startup-dead",
      origin: "open",
      agent: "claude",
      pid: 999_999_999,
      pidStartTime: "dead-process",
    });
    seed(daemon!, "startup-live", "working", {
      runId: "startup-live",
      origin: "open",
      agent: "claude",
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
    });
    installTranscript("native-startup-interrupted", "cost-state-3.jsonl");
    installTranscript("native-startup-dead", "cost-state-3.jsonl");
    installTranscript("native-startup-live", "cost-state-3.jsonl");
    await request("session.linkNative", { id: "startup-interrupted", nativeId: "native-startup-interrupted" });
    await request("session.linkNative", { id: "startup-dead", nativeId: "native-startup-dead" });
    await request("session.linkNative", { id: "startup-live", nativeId: "native-startup-live" });
    (daemon as any).maybeSpawnInhibit = () => {};

    const firstDaemon = daemon!;
    await firstDaemon.start();
    await (firstDaemon as any).startupReconcilePromise;

    expect(seam(firstDaemon).sessions.get("startup-interrupted")?.usage?.cost).toBe(3);
    expect(seam(firstDaemon).sessions.get("startup-dead")?.usage?.cost).toBe(3);
    expect(seam(firstDaemon).sessions.get("startup-live")?.usage).toBeUndefined();
    expect((firstDaemon as any).nativeLinks.unreconciled("startup-live")).toHaveLength(1);
    const firstTotal = (await request("usage.query", { period: "all" })).result.byOrigin
      .find((bucket: { key: string }) => bucket.key === "orchestrator").costUsd;

    await closeStartedDaemon(firstDaemon);
    removeAddedSignalListeners();
    daemon = new Daemon();
    (daemon as any).maybeSpawnInhibit = () => {};
    await daemon.start();
    await (daemon as any).startupReconcilePromise;

    const secondTotal = (await request("usage.query", { period: "all" })).result.byOrigin
      .find((bucket: { key: string }) => bucket.key === "orchestrator").costUsd;
    expect(secondTotal).toBe(firstTotal);
    expect(secondTotal).toBe(6);
  });

  it("accepts an in-project symlink and rejects an outside-project symlink", async () => {
    seedOpen("row-path-validation");
    const insideId = "native-inside-link";
    const insidePath = transcriptFile(insideId);
    fs.writeFileSync(insidePath, `${assistantLine("message-inside", "request-inside", 7, 3)}\n`);
    const aliasPath = path.join(path.dirname(insidePath), "transcript-alias.jsonl");
    fs.symlinkSync(insidePath, aliasPath);

    const inside = await request("usage.get", {
      runId: "row-path-validation",
      transcript: { nativeId: insideId, path: aliasPath },
    });
    expect(inside.result.orchestrator).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(liveCursor(insideId)?.byteOffset).toBeGreaterThan(0);

    const outsideId = "native-outside-link";
    const outsideDir = path.join(homeDir, "outside-projects");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, `${outsideId}.jsonl`);
    fs.writeFileSync(outsidePath, `${assistantLine("message-outside", "request-outside", 90, 40)}\n`);
    const outsideAlias = path.join(path.dirname(insidePath), "outside-transcript-alias.jsonl");
    fs.symlinkSync(outsidePath, outsideAlias);
    const outside = await request("usage.get", {
      runId: "row-path-validation",
      observe: { nativeId: outsideId, costUsd: 1.5 },
      transcript: { nativeId: outsideId, path: outsideAlias },
    });

    expect(outside.result.orchestrator.costUsd).toBe(1.5);
    expect(outside.result.orchestrator.inputTokens).toBe(7);
    expect(liveCursor(outsideId)).toBeUndefined();
    expect((daemon as any).usageLedger.attributionsFor(["row-path-validation"]))
      .toContainEqual(expect.objectContaining({ sourceKey: `claude-open:${outsideId}`, cost: 1.5, inputTokens: 0 }));

    const wrongBasenameId = "native-wrong-basename";
    const wrongBasenamePath = path.join(path.dirname(insidePath), "wrong-basename.jsonl");
    fs.writeFileSync(wrongBasenamePath, `${assistantLine("message-wrong-basename", "request-wrong-basename", 60, 20)}\n`);
    await request("usage.get", {
      runId: "row-path-validation",
      transcript: { nativeId: wrongBasenameId, path: wrongBasenamePath },
    });
    expect(liveCursor(wrongBasenameId)).toBeUndefined();
    expect((daemon as any).nativeLinks.linksFor(["row-path-validation"]))
      .not.toContainEqual(expect.objectContaining({ nativeId: wrongBasenameId }));

    const directoryId = "native-directory-path";
    const directoryPath = transcriptFile(directoryId);
    fs.mkdirSync(directoryPath);
    await request("usage.get", {
      runId: "row-path-validation",
      transcript: { nativeId: directoryId, path: directoryPath },
    });
    expect(liveCursor(directoryId)).toBeUndefined();
    expect((daemon as any).nativeLinks.linksFor(["row-path-validation"]))
      .not.toContainEqual(expect.objectContaining({ nativeId: directoryId }));

    const retryId = "native-open-retry";
    const retryPath = transcriptFile(retryId);
    const firstLine = assistantLine("message-open-first", "request-open-first", 4, 2);
    const secondLine = assistantLine("message-open-second", "request-open-second", 6, 3);
    fs.writeFileSync(retryPath, `${firstLine}\n`);
    await request("usage.get", { runId: "row-path-validation", transcript: { nativeId: retryId, path: retryPath } });
    const oldCursor = { ...liveCursor(retryId) };
    fs.appendFileSync(retryPath, `${secondLine}\n`);

    const originalOpen = fs.promises.open.bind(fs.promises);
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      if (args[0] === retryPath) throw new Error("injected open failure");
      return originalOpen(...args);
    }) as typeof fs.promises.open;
    try {
      const failedOpen = await request("usage.get", {
        runId: "row-path-validation",
        transcript: { nativeId: retryId, path: retryPath },
      });
      expect(failedOpen.result.orchestrator).toMatchObject({ inputTokens: 11, outputTokens: 5 });
      expect(liveCursor(retryId)).toMatchObject({
        byteOffset: oldCursor.byteOffset,
        inputTokens: oldCursor.inputTokens,
        outputTokens: oldCursor.outputTokens,
      });
    } finally {
      fs.promises.open = originalOpen;
    }
    const retriedOpen = await request("usage.get", {
      runId: "row-path-validation",
      transcript: { nativeId: retryId, path: retryPath },
    });
    expect(retriedOpen.result.orchestrator).toMatchObject({ inputTokens: 17, outputTokens: 8 });
  });

  it("ignores malformed transcripts, rejects malformed costs first, and rejects mismatched ids", async () => {
    seedOpen("row-malformed-observations");
    const malformedTranscriptId = "native-malformed-transcript";
    const malformedTranscriptPath = transcriptFile(malformedTranscriptId);
    fs.writeFileSync(malformedTranscriptPath, `${assistantLine("message-malformed", "request-malformed", 8, 4)}\n`);

    const costWithMalformedTranscript = await request("usage.get", {
      runId: "row-malformed-observations",
      observe: { nativeId: "native-cost-with-malformed-transcript", costUsd: 2.25 },
      transcript: { nativeId: malformedTranscriptId, path: 27 },
    });
    expect(costWithMalformedTranscript.result.orchestrator.costUsd).toBe(2.25);
    expect(liveCursor(malformedTranscriptId)).toBeUndefined();

    const invalidCost = await request("usage.get", {
      runId: "row-malformed-observations",
      observe: null,
      transcript: { nativeId: malformedTranscriptId, path: malformedTranscriptPath },
    });
    expect(invalidCost.error?.code).toBe("INVALID");
    expect(liveCursor(malformedTranscriptId)).toBeUndefined();
    expect((daemon as any).nativeLinks.linksFor(["row-malformed-observations"]))
      .not.toContainEqual(expect.objectContaining({ nativeId: malformedTranscriptId }));

    const mismatchId = "native-transcript-mismatch";
    const mismatchPath = transcriptFile(mismatchId);
    fs.writeFileSync(mismatchPath, `${assistantLine("message-mismatch", "request-mismatch", 11, 9)}\n`);
    const mismatch = await request("usage.get", {
      runId: "row-malformed-observations",
      observe: { nativeId: "native-cost-mismatch", costUsd: 3 },
      transcript: { nativeId: mismatchId, path: mismatchPath },
    });
    expect(mismatch.result.orchestrator.costUsd).toBe(5.25);
    expect(liveCursor(mismatchId)).toBeUndefined();
    expect((daemon as any).nativeLinks.linksFor(["row-malformed-observations"]))
      .toContainEqual(expect.objectContaining({ nativeId: "native-cost-mismatch" }));
  });

  it("skips transcript ingestion for terminal rows while keeping valid cost observations", async () => {
    seedOpen("row-terminal-live");
    const nativeId = "native-terminal-live";
    const file = transcriptFile(nativeId);
    fs.writeFileSync(file, `${assistantLine("message-terminal", "request-terminal", 14, 6)}\n`);
    seam(daemon!).sessions.setStatus("row-terminal-live", "completed");

    const response = await request("usage.get", {
      runId: "row-terminal-live",
      observe: { nativeId, costUsd: 4 },
      transcript: { nativeId, path: file },
    });

    expect(response.result.orchestrator).toMatchObject({ costUsd: 4, inputTokens: 0, outputTokens: 0 });
    expect(liveCursor(nativeId)).toBeUndefined();
  });

  it("does not recreate a cursor after release", async () => {
    seedOpen("row-post-release-live");
    const nativeId = "native-post-release-live";
    const file = transcriptFile(nativeId);
    fs.writeFileSync(file, `${assistantLine("message-post-release", "request-post-release", 12, 5)}\n`);
    await request("usage.get", {
      runId: "row-post-release-live",
      transcript: { nativeId, path: file },
    });
    expect(liveCursor(nativeId)).toBeDefined();

    await request("session.release", { id: "row-post-release-live" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(liveCursor(nativeId)).toBeUndefined();

    const response = await request("usage.get", {
      runId: "row-post-release-live",
      observe: { nativeId, costUsd: 2 },
      transcript: { nativeId, path: file },
    });
    expect(response.result.orchestrator).toMatchObject({ costUsd: 2, inputTokens: 12, outputTokens: 5 });
    expect(liveCursor(nativeId)).toBeUndefined();
  });

  it("reads at most one MiB and carries an incomplete line to the next request", async () => {
    seedOpen("row-live-chunk");
    const nativeId = "native-live-chunk";
    const file = transcriptFile(nativeId);
    const line = assistantLine("message-chunk", "request-chunk", 21, 9, 4, 1_048_600);
    fs.writeFileSync(file, `${line}\n`);

    const first = await request("usage.get", {
      runId: "row-live-chunk",
      transcript: { nativeId, path: file },
    });
    expect(first.result.orchestrator.totalTokens).toBe(0);
    expect(liveCursor(nativeId)).toMatchObject({
      byteOffset: 1_048_576,
      pendingLine: expect.any(Uint8Array),
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(liveCursor(nativeId)?.pendingLine.byteLength).toBe(1_048_576);

    const second = await request("usage.get", {
      runId: "row-live-chunk",
      transcript: { nativeId, path: file },
    });
    expect(second.result.orchestrator).toMatchObject({ inputTokens: 21, outputTokens: 9, cachedTokens: 4, totalTokens: 34 });
    expect(liveCursor(nativeId)?.byteOffset).toBe(Buffer.byteLength(`${line}\n`));
  });

  it("resets pending parser state after truncation and preserves totals and seen keys", async () => {
    seedOpen("row-live-reset");
    const nativeId = "native-live-reset";
    const file = transcriptFile(nativeId);
    const duplicate = assistantLine("message-reset-duplicate", "request-reset-duplicate", 10, 4);
    fs.writeFileSync(file, `${duplicate}\n${"x".repeat(1_100_000)}`);
    await request("usage.get", { runId: "row-live-reset", transcript: { nativeId, path: file } });
    expect(liveCursor(nativeId)).toMatchObject({ byteOffset: 1_048_576, inputTokens: 10, outputTokens: 4 });

    const added = assistantLine("message-reset-added", "request-reset-added", 5, 3);
    const replacement = `${duplicate}\n${added}\n`;
    fs.writeFileSync(file, replacement);
    const afterTruncate = await request("usage.get", {
      runId: "row-live-reset",
      transcript: { nativeId, path: file },
    });
    expect(afterTruncate.result.orchestrator).toMatchObject({ inputTokens: 15, outputTokens: 7 });
    expect(liveCursor(nativeId)?.pendingLine.byteLength).toBe(0);
    expect(liveCursor(nativeId)?.discardUntilNewline).toBe(false);

    const replaced = `${duplicate}\n${assistantLine("message-new-inode", "request-new-inode", 6, 2)}\n${"z".repeat(500)}`;
    const replacementPath = `${file}.replacement`;
    fs.writeFileSync(replacementPath, replaced);
    fs.renameSync(replacementPath, file);
    const afterReplace = await request("usage.get", {
      runId: "row-live-reset",
      transcript: { nativeId, path: file },
    });
    expect(afterReplace.result.orchestrator).toMatchObject({ inputTokens: 21, outputTokens: 9 });
  });

  it("serializes an in-flight transcript read with release cursor cleanup", async () => {
    seedOpen("row-release-overlap");
    const nativeId = "native-release-overlap";
    const file = transcriptFile(nativeId);
    fs.writeFileSync(file, `${assistantLine("message-overlap-first", "request-overlap-first", 5, 2)}\n`);
    await request("usage.get", { runId: "row-release-overlap", transcript: { nativeId, path: file } });
    fs.appendFileSync(file, `${assistantLine("message-overlap-second", "request-overlap-second", 7, 3)}\n`);

    const opened = deferred();
    const allowRead = deferred();
    const originalOpen = fs.promises.open.bind(fs.promises);
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === file) {
        const originalRead = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          opened.resolve();
          await allowRead.promise;
          return originalRead(...readArgs);
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.promises.open;

    try {
      const liveRequest = request("usage.get", {
        runId: "row-release-overlap",
        transcript: { nativeId, path: file },
      });
      await opened.promise;
      const releaseRequest = request("session.release", { id: "row-release-overlap" });
      expect(seam(daemon!).sessions.get("row-release-overlap")?.status).toBe("completed");
      const released = await releaseRequest;
      expect(released.result.session.status).toBe("completed");
      allowRead.resolve();
      await liveRequest;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      allowRead.resolve();
      fs.promises.open = originalOpen;
    }

    expect(liveCursor(nativeId)).toBeUndefined();
    expect(seam(daemon!).sessions.get("row-release-overlap")?.usage)
      .toMatchObject({ inputTokens: 12, outputTokens: 5 });
  });

  it("cleans every released cursor after successful reconciliation and keeps a shared active id", async () => {
    seedOpen("row-release-cleanup");
    seedOpen("row-shared-cleanup");
    const ids = ["native-cleanup-one", "native-cleanup-two", "native-cleanup-shared"];
    for (const [index, nativeId] of ids.entries()) {
      const file = transcriptFile(nativeId);
      fs.writeFileSync(file, `${assistantLine(`message-cleanup-${index}`, `request-cleanup-${index}`, 1, 1)}\n`);
      await request("usage.get", { runId: "row-release-cleanup", transcript: { nativeId, path: file } });
    }
    await request("session.linkNative", { id: "row-shared-cleanup", nativeId: ids[2] });

    await request("session.release", { id: "row-release-cleanup" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(liveCursor(ids[0])).toBeUndefined();
    expect(liveCursor(ids[1])).toBeUndefined();
    expect(liveCursor(ids[2])).toBeDefined();
  });

  it("retains every cursor when a full release reconciliation fails", async () => {
    seedOpen("row-release-reconcile-failure");
    const ids = ["native-a-reconcile-good", "native-z-reconcile-fails"];
    for (const [index, nativeId] of ids.entries()) {
      const file = transcriptFile(nativeId);
      fs.writeFileSync(file, `${assistantLine(`message-failure-${index}`, `request-failure-${index}`, 2, 1)}\n`);
      await request("usage.get", { runId: "row-release-reconcile-failure", transcript: { nativeId, path: file } });
    }

    const ledger = (daemon as any).usageLedger;
    const originalObserve = ledger.observe.bind(ledger);
    ledger.observe = (sessionId: string, sourceKey: string, observation: unknown, seedIntoIncoming?: boolean) => {
      if (sourceKey === `claude-open:${ids[1]}`) throw new Error("injected ledger failure");
      return originalObserve(sessionId, sourceKey, observation, seedIntoIncoming);
    };
    try {
      await request("session.release", { id: "row-release-reconcile-failure" });
    } finally {
      ledger.observe = originalObserve;
    }

    expect(liveCursor(ids[0])).toBeDefined();
    expect(liveCursor(ids[1])).toBeDefined();
    expect((daemon as any).nativeLinks.unreconciled("row-release-reconcile-failure")).toHaveLength(1);
  });

  it("marks a vanished transcript missing and cleans its cursor after release", async () => {
    seedOpen("row-missing-live-transcript");
    const nativeId = "native-missing-live-transcript";
    const file = transcriptFile(nativeId);
    fs.writeFileSync(file, `${assistantLine("message-missing-live", "request-missing-live", 3, 2)}\n`);
    await request("usage.get", { runId: "row-missing-live-transcript", transcript: { nativeId, path: file } });
    expect(liveCursor(nativeId)).toBeDefined();
    fs.unlinkSync(file);

    await request("session.release", { id: "row-missing-live-transcript" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect((daemon as any).nativeLinks.linksFor(["row-missing-live-transcript"]))
      .toMatchObject([{ nativeId, state: "missing" }]);
    expect(liveCursor(nativeId)).toBeUndefined();
  });

  it("keeps the cursor unchanged when ledger persistence fails, then rereads on retry", async () => {
    seedOpen("row-live-ledger-failure");
    const earlierId = "native-earlier-ledger-failure";
    await request("session.linkNative", { id: "row-live-ledger-failure", nativeId: earlierId });
    const nativeId = "native-live-ledger-failure";
    const file = transcriptFile(nativeId);
    fs.writeFileSync(file, `${assistantLine("message-ledger-failure", "request-ledger-failure", 13, 7)}\n`);
    const ledger = (daemon as any).usageLedger;
    const originalObserve = ledger.observe.bind(ledger);
    const reconciliationQueued = deferred();
    let queuedSessionId: string | undefined;
    let queuedNativeIds: readonly string[] | undefined;
    const originalReconcile = (daemon as any).reconcileOpenUsageSafely.bind(daemon);
    (daemon as any).reconcileOpenUsageSafely = async (sessionId: string, nativeIds?: readonly string[]) => {
      queuedSessionId = sessionId;
      queuedNativeIds = nativeIds;
      reconciliationQueued.resolve();
      return true;
    };
    ledger.observe = () => { throw new Error("injected live ledger failure"); };
    try {
      const failed = await request("usage.get", { runId: "row-live-ledger-failure", transcript: { nativeId, path: file } });
      await reconciliationQueued.promise;
      expect(failed.result.runId).toBe("row-live-ledger-failure");
      expect(liveCursor(nativeId)).toBeUndefined();
      expect((daemon as any).usageLedger.attributionsFor(["row-live-ledger-failure"])).toEqual([]);
      expect(queuedSessionId).toBe("row-live-ledger-failure");
      expect(queuedNativeIds).toEqual([earlierId]);
    } finally {
      ledger.observe = originalObserve;
      (daemon as any).reconcileOpenUsageSafely = originalReconcile;
    }

    const retried = await request("usage.get", { runId: "row-live-ledger-failure", transcript: { nativeId, path: file } });
    expect(retried.result.orchestrator).toMatchObject({ inputTokens: 13, outputTokens: 7 });
    expect(liveCursor(nativeId)?.byteOffset).toBe(Buffer.byteLength(`${assistantLine("message-ledger-failure", "request-ledger-failure", 13, 7)}\n`));
  });

  it("restarts at byte zero without lowering high-water totals and catches up later chunks", async () => {
    seedOpen("row-live-restart");
    const nativeId = "native-live-restart";
    const file = transcriptFile(nativeId);
    const firstLine = assistantLine("message-restart-first", "request-restart-first", 10, 4);
    const secondLine = assistantLine("message-restart-second", "request-restart-second", 20, 8, 0, 1_048_600);
    fs.writeFileSync(file, `${firstLine}\n${secondLine}\n`);

    await request("usage.get", { runId: "row-live-restart", transcript: { nativeId, path: file } });
    expect(seam(daemon!).sessions.get("row-live-restart")?.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    await request("usage.get", { runId: "row-live-restart", transcript: { nativeId, path: file } });
    expect(seam(daemon!).sessions.get("row-live-restart")?.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });

    seam(daemon!).db.close();
    daemon = new Daemon();
    expect(liveCursor(nativeId)).toBeUndefined();
    const afterRestartFirst = await request("usage.get", { runId: "row-live-restart", transcript: { nativeId, path: file } });
    expect(afterRestartFirst.result.orchestrator).toMatchObject({ inputTokens: 30, outputTokens: 12 });
    expect(liveCursor(nativeId)?.byteOffset).toBe(1_048_576);
    expect(seam(daemon!).sessions.get("row-live-restart")?.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });

    await request("usage.get", { runId: "row-live-restart", transcript: { nativeId, path: file } });
    fs.appendFileSync(file, `${assistantLine("message-restart-later", "request-restart-later", 5, 2)}\n`);
    const caughtUp = await request("usage.get", { runId: "row-live-restart", transcript: { nativeId, path: file } });
    expect(caughtUp.result.orchestrator).toMatchObject({ inputTokens: 35, outputTokens: 14 });
    expect(seam(daemon!).sessions.get("row-live-restart")?.usage).toMatchObject({ inputTokens: 35, outputTokens: 14 });
  });

  it("deduplicates deferred earlier-id reconciliation while it is in flight", async () => {
    seedOpen("row-deferred-reconcile");
    await request("session.linkNative", { id: "row-deferred-reconcile", nativeId: "native-earlier-unreconciled" });
    const liveId = "native-current-live";
    const file = transcriptFile(liveId);
    fs.writeFileSync(file, `${assistantLine("message-current-live", "request-current-live", 9, 4)}\n`);

    const reconciliationStarted = deferred();
    const finishFirstReconciliation = deferred();
    const secondReconciliationStarted = deferred();
    const reconciliations: Array<{ sessionId: string; nativeIds?: readonly string[] }> = [];
    const originalReconcile = (daemon as any).reconcileOpenUsageSafely.bind(daemon);
    (daemon as any).reconcileOpenUsageSafely = async (sessionId: string, nativeIds?: readonly string[]) => {
      reconciliations.push({ sessionId, nativeIds });
      if (reconciliations.length === 1) {
        reconciliationStarted.resolve();
        await finishFirstReconciliation.promise;
      }
      if (reconciliations.length === 2) secondReconciliationStarted.resolve();
      return true;
    };
    try {
      const response = await request("usage.get", {
        runId: "row-deferred-reconcile",
        transcript: { nativeId: liveId, path: file },
      });
      expect(response.result.orchestrator).toMatchObject({ inputTokens: 9, outputTokens: 4 });
      await reconciliationStarted.promise;
      expect(reconciliations[0]).toEqual({
        sessionId: "row-deferred-reconcile",
        nativeIds: ["native-earlier-unreconciled"],
      });

      const secondResponse = await request("usage.get", {
        runId: "row-deferred-reconcile",
        transcript: { nativeId: liveId, path: file },
      });
      expect(secondResponse.result.orchestrator).toMatchObject({ inputTokens: 9, outputTokens: 4 });
      expect(reconciliations).toHaveLength(1);

      finishFirstReconciliation.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const thirdResponse = await request("usage.get", {
        runId: "row-deferred-reconcile",
        transcript: { nativeId: liveId, path: file },
      });
      expect(thirdResponse.result.orchestrator).toMatchObject({ inputTokens: 9, outputTokens: 4 });
      await secondReconciliationStarted.promise;
      expect(reconciliations).toHaveLength(2);
      expect(reconciliations[1]).toEqual({
        sessionId: "row-deferred-reconcile",
        nativeIds: ["native-earlier-unreconciled"],
      });
    } finally {
      finishFirstReconciliation.resolve();
      (daemon as any).reconcileOpenUsageSafely = originalReconcile;
    }
  });

  it("attributes only release output growth above live input and output marks", async () => {
    seedOpen("row-live-release-high-water");
    const nativeId = "native-live-release-high-water";
    const file = transcriptFile(nativeId);
    fs.writeFileSync(file, `${assistantLine("message-live-high-water", "request-live-high-water", 100, 20)}\n`);
    await request("usage.get", { runId: "row-live-release-high-water", transcript: { nativeId, path: file } });
    expect(seam(daemon!).sessions.get("row-live-release-high-water")?.usage)
      .toMatchObject({ inputTokens: 100, outputTokens: 20 });

    fs.writeFileSync(file, `${JSON.stringify({
      type: "cost-state",
      totalCostUSD: 5,
      modelUsage: {
        "claude-sonnet-4-5": {
          inputTokens: 80,
          outputTokens: 45,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 5,
        },
      },
    })}\n`);
    await request("session.release", { id: "row-live-release-high-water" });

    expect(seam(daemon!).sessions.get("row-live-release-high-water")?.usage)
      .toMatchObject({ inputTokens: 100, outputTokens: 45 });
    expect((daemon as any).usageLedger.attributionsFor(["row-live-release-high-water"]))
      .toContainEqual(expect.objectContaining({
        sourceKey: `claude-open:${nativeId}`,
        inputTokens: 100,
        outputTokens: 45,
      }));
  });
});
