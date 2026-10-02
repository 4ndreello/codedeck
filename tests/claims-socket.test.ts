import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { createIpcServer, IpcClient } from "../src/daemon/ipc.js";
import type { ClaimAddResult, ClaimQueryResult, IpcRequest } from "../src/daemon/protocol.js";
import type { Claim } from "../src/store/claims.js";
import { seed, seam } from "./helpers/daemon-seam.js";

const originalCodedeckDir = process.env.CODEDECK_DIR;
let codedeckDir: string;
let socketPath: string;
let daemon: Daemon | undefined;
let server: net.Server | undefined;

async function listen(serverToStart: net.Server, pathToListen: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      serverToStart.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      serverToStart.removeListener("error", onError);
      resolve();
    };
    serverToStart.once("error", onError);
    serverToStart.once("listening", onListening);
    serverToStart.listen(pathToListen);
  });
}

async function closeServer(serverToClose: net.Server): Promise<void> {
  if (!serverToClose.listening) return;
  await new Promise<void>((resolve) => serverToClose.close(() => resolve()));
}

beforeEach(async () => {
  codedeckDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-claims-socket-"));
  socketPath = path.join(codedeckDir, "daemon.sock");
  process.env.CODEDECK_DIR = codedeckDir;

  daemon = new Daemon();
  seed(daemon, "owner", "working", { cwd: codedeckDir, repository: codedeckDir });
  seed(daemon, "reader", "working", { cwd: codedeckDir, repository: codedeckDir });
  server = createIpcServer((request: IpcRequest, socket) => seam(daemon!).handleRequest(request, socket));
  await listen(server, socketPath);
});

afterEach(async () => {
  if (server) await closeServer(server);
  try { if (daemon) seam(daemon).db.close(); } catch {}
  server = undefined;
  daemon = undefined;
  if (originalCodedeckDir === undefined) delete process.env.CODEDECK_DIR;
  else process.env.CODEDECK_DIR = originalCodedeckDir;
  fs.rmSync(codedeckDir, { recursive: true, force: true });
});

describe("claims IPC success", () => {
  it("round-trips a claim between sessions over a live socket", async () => {
    const ownerClient = new IpcClient(socketPath);
    const readerClient = new IpcClient(socketPath);
    const addResult = await ownerClient.request<ClaimAddResult>("claims.add", {
      sessionId: "owner",
      pathGlob: "src/auth/*",
      reason: "refactor login flow",
    });

    const queryResult = await readerClient.request<ClaimQueryResult>("claims.query", {
      sessionId: "reader",
      path: "src/auth/login.ts",
    });

    expect(queryResult.claims).toHaveLength(1);
    const claim: Claim = queryResult.claims[0]!;
    expect(Object.keys(claim)).toEqual([
      "id",
      "sessionId",
      "pathGlob",
      "reason",
      "createdAt",
      "active",
    ]);
    expect(claim).toEqual({
      id: addResult.claim.id,
      sessionId: "owner",
      pathGlob: "src/auth/*",
      reason: "refactor login flow",
      createdAt: addResult.claim.createdAt,
      active: true,
    });
  });
});
