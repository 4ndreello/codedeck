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
  runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-daemon-"));
  process.env.RUN_AGENT_DIR = runAgentDir;
  requestNumber = 0;
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
    { id: `claims-${++requestNumber}`, method, params },
    socket,
  );
  return JSON.parse(writes[0]);
}

function seedSession(id: string): void {
  seed(daemon!, id, "working", { cwd: runAgentDir, repository: runAgentDir });
}

describe("claims daemon methods", () => {
  it("adds and queries overlapping claims across sessions", async () => {
    daemon = new Daemon();
    seedSession("owner");
    seedSession("reader");

    const authResponse = await request("claims.add", {
      sessionId: "owner",
      pathGlob: "src/auth/*",
      reason: "refactor login flow",
    });
    const authClaim = authResponse.result.claim;
    expect(authClaim).toMatchObject({
      id: 1,
      sessionId: "owner",
      pathGlob: "src/auth/*",
      reason: "refactor login flow",
      active: true,
    });
    expect(authClaim.createdAt).toBe(new Date(authClaim.createdAt).toISOString());

    await request("claims.add", {
      sessionId: "owner",
      pathGlob: "docs/*",
      reason: "update documentation",
    });

    const queryResponse = await request("claims.query", {
      sessionId: "reader",
      path: "src/auth/login.ts",
    });
    expect(queryResponse.result.claims).toEqual([authClaim]);
  });

  it("releases claims and maps ownership and not-found errors", async () => {
    daemon = new Daemon();
    seedSession("owner");
    seedSession("other");

    const missingSessionError = await request("claims.add", {
      sessionId: "missing",
      pathGlob: "src/auth/*",
      reason: "missing session",
    });
    expect(missingSessionError.error).toMatchObject({
      code: "SESSION_NOT_FOUND",
      message: 'Session "missing" not found',
      details: { id: "missing" },
    });

    const invalidPathError = await request("claims.query", {
      sessionId: "owner",
      path: "../outside/*",
    });
    expect(invalidPathError.error).toMatchObject({
      code: "INVALID_PATH",
      message: 'Claim path "../outside/*" escapes the session root',
      details: { path: "../outside/*", root: runAgentDir },
    });

    const addResponse = await request("claims.add", {
      sessionId: "owner",
      pathGlob: "src/auth/*",
      reason: "refactor login flow",
    });
    const claim = addResponse.result.claim;

    const ownershipError = await request("claims.release", {
      sessionId: "other",
      claimId: claim.id,
    });
    expect(ownershipError.error).toMatchObject({
      code: "CLAIM_NOT_OWNED",
      message: `Claim "${claim.id}" is owned by another session`,
      details: { claimId: claim.id },
    });

    const missingError = await request("claims.release", {
      sessionId: "owner",
      claimId: 999,
    });
    expect(missingError.error).toMatchObject({
      code: "CLAIM_NOT_FOUND",
      message: 'Claim "999" not found',
      details: { claimId: 999 },
    });

    const releaseResponse = await request("claims.release", {
      sessionId: "owner",
      claimId: claim.id,
    });
    expect(releaseResponse.result).toEqual({ claim: { ...claim, active: false } });
  });
});
