import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { RequestMethod } from "../src/daemon/protocol.js";
import type { Session } from "../src/core/session.js";
import { fakeSocket, makeTempDir, removeTempDir, seed, seam } from "./helpers/daemon-seam.js";

let runAgentDir: string;
let homeDir: string;
let daemon: Daemon | undefined;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const originalHome = process.env.HOME;
let requestNumber = 0;

beforeEach(() => {
  runAgentDir = makeTempDir("orchestrator-usage-daemon-");
  homeDir = makeTempDir("orchestrator-usage-home-");
  process.env.RUN_AGENT_DIR = runAgentDir;
  process.env.HOME = homeDir;
  requestNumber = 0;
  daemon = new Daemon();
});

afterEach(() => {
  try { daemon && seam(daemon).db.close(); } catch {}
  daemon = undefined;
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

  it("logs transcript read errors and still replies to release", async () => {
    seedOpen("row-reader-error");
    await request("session.linkNative", { id: "row-reader-error", nativeId: "native-reader-error" });
    fs.mkdirSync(transcriptFile("native-reader-error"));

    const response = await request("session.release", { id: "row-reader-error" });

    expect(response.result.session.status).toBe("completed");
    expect(fs.readFileSync(path.join(runAgentDir, "daemon.log"), "utf-8"))
      .toContain("usage reconcile failed session=row-reader-error");
    expect((daemon as any).nativeLinks.unreconciled("row-reader-error")).toHaveLength(1);
  });
});
