import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/events.js";
import type { DriverSession, StartOptions } from "../src/core/driver.js";
import { createRuntimeHooks, SessionDriver } from "../src/drivers/session-driver.js";

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-env-logs-"));
const previousRunAgentDir = process.env.RUN_AGENT_DIR;
const previousNoScope = process.env.CODEDECK_NO_SCOPE;
process.env.RUN_AGENT_DIR = logDir;
process.env.CODEDECK_NO_SCOPE = "1";

afterAll(() => {
  if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = previousRunAgentDir;
  if (previousNoScope === undefined) delete process.env.CODEDECK_NO_SCOPE;
  else process.env.CODEDECK_NO_SCOPE = previousNoScope;
  fs.rmSync(logDir, { recursive: true, force: true });
});

class EnvDriver extends SessionDriver {
  readonly id = "claude" as const;
  protected readonly hooks = createRuntimeHooks({
    parse: (line, sessionId) => [
      {
        type: "message",
        sessionId,
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: line,
        raw: line,
      } as AgentEvent,
    ],
    nativeKeys: [],
    harness: "stub",
  });
  protected readonly resumeError = "unused";

  protected buildArgs(_options: StartOptions): string[] {
    return [
      "-e",
      'process.stdout.write(JSON.stringify({ present: Object.hasOwn(process.env, "CODEDECK_RUN_ID"), value: process.env.CODEDECK_RUN_ID ?? null }) + "\\n");',
    ];
  }

  protected override getCommand(): string {
    return process.execPath;
  }

  capabilities() {
    return {
      streaming: true,
      resume: false,
      fork: false,
      approvals: false,
      usage: false,
      cost: false,
      modelSelection: false,
      nativeDiff: false,
      interrupt: false,
    };
  }

  async detect() {
    return { installed: true };
  }
}

async function readEnvironment(runId?: string): Promise<{ present: boolean; value: string | null }> {
  const driver = new EnvDriver();
  const session = await driver.start({
    sessionId: `env-${runId ?? "none"}-${Math.random().toString(36).slice(2)}`,
    prompt: "",
    cwd: os.tmpdir(),
    runId,
  });
  let output: { present: boolean; value: string | null } | undefined;
  for await (const event of driver.events(session)) {
    if (event.type === "message") output = JSON.parse(String(event.content)) as typeof output;
  }
  if (!output) throw new Error("stub harness did not report its environment");
  return output;
}

async function drainEnvironment(
  driver: EnvDriver,
  session: DriverSession,
): Promise<{ present: boolean; value: string | null }> {
  let output: { present: boolean; value: string | null } | undefined;
  for await (const event of driver.events(session)) {
    if (event.type === "message") output = JSON.parse(String(event.content)) as typeof output;
  }
  if (!output) throw new Error("stub harness did not report its environment");
  return output;
}

async function readResumedEnvironment(runId?: string): Promise<{ present: boolean; value: string | null }> {
  const driver = new EnvDriver();
  const session = await driver.start({
    sessionId: `env-resume-${runId ?? "none"}-${Math.random().toString(36).slice(2)}`,
    prompt: "",
    cwd: os.tmpdir(),
    runId,
    resumeSessionId: "native-thread",
  });
  await drainEnvironment(driver, session);
  await driver.send(session, "resume");
  return drainEnvironment(driver, session);
}

describe("worker run id environment", () => {
  it("sets CODEDECK_RUN_ID when a run id is present", async () => {
    await expect(readEnvironment("r1")).resolves.toEqual({ present: true, value: "r1" });
  });

  it("omits CODEDECK_RUN_ID when a run id is absent or empty", async () => {
    const previousRunId = process.env.CODEDECK_RUN_ID;
    process.env.CODEDECK_RUN_ID = "ambient-run";
    try {
      await expect(readEnvironment()).resolves.toEqual({ present: false, value: null });
      await expect(readEnvironment("")).resolves.toEqual({ present: false, value: null });
    } finally {
      if (previousRunId === undefined) delete process.env.CODEDECK_RUN_ID;
      else process.env.CODEDECK_RUN_ID = previousRunId;
    }
  });

  it("preserves CODEDECK_RUN_ID through a resumed send and omits it without a run", async () => {
    await expect(readResumedEnvironment("r1")).resolves.toEqual({ present: true, value: "r1" });

    const previousRunId = process.env.CODEDECK_RUN_ID;
    process.env.CODEDECK_RUN_ID = "ambient-run";
    try {
      await expect(readResumedEnvironment()).resolves.toEqual({ present: false, value: null });
    } finally {
      if (previousRunId === undefined) delete process.env.CODEDECK_RUN_ID;
      else process.env.CODEDECK_RUN_ID = previousRunId;
    }
  });
});
