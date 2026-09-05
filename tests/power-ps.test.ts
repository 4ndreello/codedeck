import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/core/session.js";
import { exitCodeForOutcome } from "../src/core/errors.js";
import { renderPsTable } from "../src/cli/commands/ps.js";
import { formatShowJson } from "../src/cli/commands/show.js";
import { formatWaitResult } from "../src/cli/commands/wait.js";
import { registerRunCommand } from "../src/cli/commands/run.js";
import { waitForSession, type SessionWaitClient } from "../src/cli/wait.js";

function psRow(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "a83f",
    name: "power",
    agent: "claude",
    status: "interrupted",
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function interruptedSession(): Session {
  const now = new Date();
  return {
    id: "a83f",
    agent: "claude",
    status: "interrupted",
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
    failure: { code: "SHUTDOWN", blame: "infra", retryable: true },
  };
}

class FakeWaitClient implements SessionWaitClient {
  readonly session: Session;
  subscribeCount = 0;

  constructor(session: Session) {
    this.session = session;
  }

  async getSession(_id: string): Promise<Session> {
    return this.session;
  }

  subscribe(): () => void {
    this.subscribeCount += 1;
    return () => {};
  }
}

describe("power ps presentation", () => {
  it("lists interrupted sessions with the ⏻ symbol", () => {
    const table = renderPsTable([psRow()]);
    expect(table).toContain("⏻");
    expect(table).toContain("interrupted");
  });

  it("keeps the ⏻ mark when the recorded pid is long gone", () => {
    const table = renderPsTable([psRow({ pid: 1_000_000 })]);
    expect(table).toContain("⏻");
    expect(table).not.toContain("dead");
  });
});

describe("power wait presentation", () => {
  it("resolves an interrupted session without subscribing and maps to exit 3", async () => {
    const client = new FakeWaitClient(interruptedSession());
    const session = await waitForSession(client, "a83f");
    expect(session.status).toBe("interrupted");
    expect(client.subscribeCount).toBe(0);
    expect(exitCodeForOutcome(session)).toBe(3);
  });

  it("renders interrupted as a failed-styled result with the infra blame", () => {
    expect(formatWaitResult(interruptedSession())).toBe(
      "✗ Session a83f interrupted [infra, retryable]",
    );
  });
});

describe("power show presentation", () => {
  it("keeps failure.code SHUTDOWN in show --json output", () => {
    const json = formatShowJson({
      session: { id: "a83f", status: "interrupted", failure: { code: "SHUTDOWN", blame: "infra", retryable: true } },
      events: [],
      eventCount: 1,
    });
    expect(JSON.parse(json).session.failure.code).toBe("SHUTDOWN");
  });
});

describe("power run help", () => {
  it("documents poweroff → interrupted → send resume", () => {
    const program = new Command();
    registerRunCommand(program);
    const run = program.commands.find((command) => command.name() === "run");
    let help = "";
    run?.outputHelp({ write: (chunk: string) => { help += chunk; } });
    expect(help).toContain("interrupted");
    expect(help).toContain("codedeck send");
  });
});
