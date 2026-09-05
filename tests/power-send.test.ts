import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processStartTime } from "../src/utils/process.js";
import { defaultCapabilities } from "../src/core/capabilities.js";
import { Daemon } from "../src/daemon/daemon.js";
import { fakeSocket, makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("power-send-");
  process.env.RUN_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  removeTempDir(dir);
});


interface SentCall {
  session: { id: string; nativeSessionId?: string };
  message: string;
}

function installSendDriver(daemon: Daemon, resume: boolean, sent: SentCall[]): void {
  seam(daemon).registry.register({
    id: "claude",
    capabilities: () => ({ ...defaultCapabilities(), resume }),
    send: async (session: SentCall["session"], message: string) => {
      sent.push({ session, message });
    },
    getHandle: () => undefined,
    events: async function* () {
      yield { type: "message", sessionId: "boot", timestamp: new Date().toISOString(), content: "boot" };
      await new Promise<void>(() => {});
    },
  });
}


async function sendMessage(daemon: Daemon, id: string, message: string): Promise<{ result?: unknown; error?: { code: string } }> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest({ id: "r1", method: "session.send", params: { id, message } }, socket);
  return JSON.parse(writes[0]) as { result?: unknown; error?: { code: string } };
}

describe("power send admission for interrupted", () => {
  it("rejects without nativeSessionId as CAPABILITY_NOT_SUPPORTED", async () => {
    const daemon = new Daemon();
    const sent: SentCall[] = [];
    installSendDriver(daemon, true, sent);
    seed(daemon, "s-nonative", "interrupted");

    const res = await sendMessage(daemon, "s-nonative", "continue");

    expect(res.error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(sent).toHaveLength(0);
  });

  it("rejects before liveness when the driver cannot resume", async () => {
    const daemon = new Daemon();
    const sent: SentCall[] = [];
    installSendDriver(daemon, false, sent);
    // Live matching pid: capability must still win over SESSION_BUSY.
    seed(daemon, "s-noresume", "interrupted", {
      nativeSessionId: "n-1",
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
    });

    const res = await sendMessage(daemon, "s-noresume", "continue");

    expect(res.error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(sent).toHaveLength(0);
  });

  it("rejects a live identical process as SESSION_BUSY", async () => {
    const daemon = new Daemon();
    const sent: SentCall[] = [];
    installSendDriver(daemon, true, sent);
    seed(daemon, "s-busy", "interrupted", {
      nativeSessionId: "n-2",
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
    });

    const res = await sendMessage(daemon, "s-busy", "continue");

    expect(res.error?.code).toBe("SESSION_BUSY");
    expect(sent).toHaveLength(0);
  });

  it("resumes past a recycled pid into a new working turn", async () => {
    const daemon = new Daemon();
    const sent: SentCall[] = [];
    installSendDriver(daemon, true, sent);
    seed(daemon, "s-resume", "interrupted", {
      nativeSessionId: "n-3",
      pid: process.pid,
      pidStartTime: "stale-tick",
    });

    const res = await sendMessage(daemon, "s-resume", "continue");

    expect(res.error).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe("continue");
    expect(sent[0].session.nativeSessionId).toBe("n-3");
    expect(seam(daemon).sessions.get("s-resume")?.status).toBe("working");
  });

  it("keeps the working busy check for non-interrupted sessions", async () => {
    const daemon = new Daemon();
    const sent: SentCall[] = [];
    installSendDriver(daemon, true, sent);
    seed(daemon, "s-working", "working", {
      nativeSessionId: "n-4",
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
    });

    const res = await sendMessage(daemon, "s-working", "more work");

    expect(res.error?.code).toBe("SESSION_BUSY");
    expect(sent).toHaveLength(0);
  });
});
