import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Daemon } from "../src/daemon/daemon.js";
import { fakeSocket, seed, seam } from "./helpers/daemon-seam.js";

let runAgentDir: string;
let daemon: Daemon | undefined;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
let requestNumber = 0;

beforeEach(() => {
  runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-identity-"));
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

async function request(method: "session.rename" | "session.get", params: unknown): Promise<Record<string, any>> {
  const { writes, socket } = fakeSocket();
  await seam(daemon!).handleRequest(
    { id: `session-identity-${++requestNumber}`, method, params },
    socket,
  );
  return JSON.parse(writes[0]);
}

describe("session.rename IPC", () => {
  it("creates, renames, and gets the session with its new name", async () => {
    daemon = new Daemon();
    seed(daemon, "session-a", "working", { name: "raw task" });

    expect(await request("session.rename", { id: "session-a", name: "oauth-login" }))
      .toEqual({ id: "session-identity-1", result: { ok: true } });

    const response = await request("session.get", { id: "session-a" });
    expect(response.result.session.name).toBe("oauth-login");
  });
});
