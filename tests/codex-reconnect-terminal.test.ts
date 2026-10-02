import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeHooks } from "../src/drivers/session-driver.js";
import { parseCodexLine } from "../src/drivers/codex/parser.js";
import { SessionRuntime } from "../src/drivers/session-runtime.js";
import { Daemon } from "../src/daemon/daemon.js";
import { makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

let codedeckDir: string;
let daemon: Daemon | undefined;
const originalCodedeckDir = process.env.CODEDECK_DIR;

beforeEach(() => {
  codedeckDir = makeTempDir("codex-terminal-daemon-");
  process.env.CODEDECK_DIR = codedeckDir;
  daemon = new Daemon();
});

afterEach(() => {
  try { if (daemon) seam(daemon).db.close(); } catch {}
  daemon = undefined;
  if (originalCodedeckDir === undefined) delete process.env.CODEDECK_DIR;
  else process.env.CODEDECK_DIR = originalCodedeckDir;
  removeTempDir(codedeckDir);
});

function spawnCodexFixture(fixtureName: string): { runtime: SessionRuntime; cwd: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-terminal-"));
  const fixturePath = path.resolve("tests/fixtures/codex", fixtureName);
  const script = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(fixturePath)}, "utf8"));`;
  const runtime = SessionRuntime.spawn({
    sessionId: fixtureName,
    cmd: process.execPath,
    args: ["-e", script],
    cwd,
    hooks: createRuntimeHooks({
      parse: parseCodexLine,
      nativeKeys: ["thread_id"],
      harness: "codex",
    }),
  });
  return { runtime, cwd };
}

async function collectFixture(fixtureName: string) {
  const { runtime, cwd } = spawnCodexFixture(fixtureName);
  try {
    const events = [];
    for await (const event of runtime.events()) events.push(event);
    return events;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function persistOutcome(sessionId: string, events: Awaited<ReturnType<typeof collectFixture>>): Promise<void> {
  seed(daemon!, sessionId, "working", { agent: "codex" });
  const driver = {
    async *events() {
      yield* events;
    },
  };
  await (daemon as any).attachDriverEvents(sessionId, driver, { id: sessionId });
}

describe("Codex reconnect terminal outcome", () => {
  it("completes after reconnect notices when the process exits 0", async () => {
    const events = await collectFixture("reconnect-completed.jsonl");
    await persistOutcome("reconnect-completed", events);

    expect(events.filter((event) => event.type === "error")).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "session.completed", exitCode: 0 });
    expect(events.some((event) => event.type === "session.failed")).toBe(false);
    expect(seam(daemon!).sessions.get("reconnect-completed")?.status).toBe("completed");
  }, 15000);

  it("fails when an error notice is followed by turn.failed", async () => {
    const events = await collectFixture("error-turn-failed.jsonl");
    await persistOutcome("error-turn-failed", events);

    expect(events.at(-1)).toMatchObject({ type: "session.failed", error: "Usage limit reached" });
    expect(seam(daemon!).sessions.get("error-turn-failed")?.status).toBe("failed");
  }, 15000);
});
