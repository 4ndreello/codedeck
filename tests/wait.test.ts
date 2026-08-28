import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/events.js";
import type { Session, SessionStatus } from "../src/core/session.js";
import { registerRunCommand } from "../src/cli/commands/run.js";
import { waitForSession, type SessionWaitClient } from "../src/cli/wait.js";

function createSession(status: SessionStatus): Session {
  const now = new Date();
  return {
    id: "e395",
    agent: "claude",
    status,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
  };
}

class FakeWaitClient implements SessionWaitClient {
  readonly session: Session;
  subscribeCount = 0;
  private onEvent?: (event: AgentEvent) => void;
  private onDone?: () => void;

  constructor(status: SessionStatus) {
    this.session = createSession(status);
  }

  async getSession(_id: string): Promise<Session> {
    return this.session;
  }

  subscribe(
    _id: string,
    onEvent: (event: AgentEvent) => void,
    onDone?: () => void,
  ): () => void {
    this.subscribeCount += 1;
    this.onEvent = onEvent;
    this.onDone = onDone;
    return () => {
      this.onEvent = undefined;
      this.onDone = undefined;
    };
  }

  emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  close(): void {
    this.onDone?.();
  }
}

describe("waitForSession", () => {
  it("waits through active states and resolves on a terminal event", async () => {
    const client = new FakeWaitClient("starting");
    let resolved = false;
    const resultPromise = waitForSession(client, "e395", {
      retryDelayMs: 0,
      sleep: async () => {},
    }).then((session) => {
      resolved = true;
      return session;
    });

    await Promise.resolve();
    expect(client.subscribeCount).toBe(1);

    client.session.status = "idle";
    client.emit({
      type: "message",
      sessionId: client.session.id,
      timestamp: new Date().toISOString(),
      role: "assistant",
      content: "waiting",
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    client.session.status = "needs_input";
    client.emit({
      type: "permission.requested",
      sessionId: client.session.id,
      timestamp: new Date().toISOString(),
      tool: "terminal",
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    client.session.status = "completed";
    client.emit({
      type: "session.completed",
      sessionId: client.session.id,
      timestamp: new Date().toISOString(),
      reason: "done",
    });

    await expect(resultPromise).resolves.toMatchObject({ status: "completed" });
  });

  it("returns an already terminal session without subscribing", async () => {
    const client = new FakeWaitClient("failed");
    client.session.failure = {
      code: "TASK_ERROR",
      blame: "task",
      retryable: false,
      detail: "failed",
    };

    await expect(waitForSession(client, "e395")).resolves.toMatchObject({ status: "failed" });
    expect(client.subscribeCount).toBe(0);
  });
});

describe("run background option", () => {
  it("exposes --bg as the preferred spelling for detached runs", () => {
    const program = new Command();
    registerRunCommand(program);
    const run = program.commands.find((command) => command.name() === "run");
    const backgroundOption = run?.options.find((option) => option.flags === "--bg, --detach");

    expect(backgroundOption).toBeDefined();
    expect(backgroundOption?.short).toBe("--bg");
    expect(backgroundOption?.long).toBe("--detach");
  });
});
