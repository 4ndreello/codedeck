import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { RequestMethod } from "../src/daemon/protocol.js";
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

function seedOpen(id: string, extra: Record<string, unknown> = {}): void {
  seed(daemon!, id, "working", { runId: id, origin: "open", agent: "claude", ...extra });
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
});
