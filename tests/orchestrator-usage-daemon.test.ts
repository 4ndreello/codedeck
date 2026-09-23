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
});
