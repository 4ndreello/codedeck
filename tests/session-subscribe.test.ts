import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import type { AgentEvent } from "../src/core/events.js";
import type { Session } from "../src/core/session.js";

const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-subscribe-"));
process.env.RUN_AGENT_DIR = testDir;

afterEach(() => {
  process.env.RUN_AGENT_DIR = testDir;
});

afterEach(() => {
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  fs.rmSync(testDir, { recursive: true, force: true });
});

type FakeSocket = {
  writes: string[];
  write: (chunk: string) => boolean;
  on: (event: string, handler: () => void) => FakeSocket;
};

function createSocket(): FakeSocket {
  return {
    writes: [],
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
    on() {
      return this;
    },
  };
}

function createSession(): Session {
  const now = new Date();
  return {
    id: "e395",
    agent: "claude",
    status: "completed",
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
}

describe("session.subscribe", () => {
  it("immediately closes with the terminal event for an already completed session", async () => {
    const daemon = new Daemon();
    const stores = daemon as unknown as {
      sessions: { create: (session: Session) => void };
      events: { append: (sessionId: string, event: AgentEvent) => number };
      db: { close: () => void };
    };
    const session = createSession();
    const terminal: AgentEvent = {
      type: "session.completed",
      sessionId: session.id,
      timestamp: session.completedAt!.toISOString(),
      reason: "done",
    };
    stores.sessions.create(session);
    stores.events.append(session.id, terminal);

    const socket = createSocket();
    await (daemon as unknown as {
      handleRequest: (request: unknown, socket: FakeSocket) => Promise<void>;
    }).handleRequest(
      { id: "request-1", method: "session.subscribe", params: { id: session.id } },
      socket,
    );
    stores.db.close();

    const messages = socket.writes.map((line) => JSON.parse(line));
    expect(messages.map((message) => message.type)).toEqual(["event", "done"]);
    expect(messages[0].event.type).toBe("session.completed");
    expect(messages[1]).toMatchObject({ type: "done", id: session.id });
  });
});
