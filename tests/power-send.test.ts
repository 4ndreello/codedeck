import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processStartTime } from "../src/utils/process.js";
import { defaultCapabilities } from "../src/core/capabilities.js";
import { Daemon } from "../src/daemon/daemon.js";
import type { Session, SessionStatus } from "../src/core/session.js";
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

interface SendCase {
  title: string;
  id: string;
  status?: SessionStatus;
  resume: boolean;
  extra?: Partial<Session>;
  message: string;
  error?: string;
  sent: number;
  then?: (daemon: Daemon, sent: SentCall[]) => void;
}

// One shared body drives every admission case; rows differ only in data.
// processStartTime(process.pid) is stable for the run, so evaluating it in
// the table equals evaluating it per test.
const livePid = { pid: process.pid, pidStartTime: processStartTime(process.pid) };

const cases: SendCase[] = [
  {
    title: "rejects without nativeSessionId as CAPABILITY_NOT_SUPPORTED",
    id: "s-nonative",
    resume: true,
    message: "continue",
    error: "CAPABILITY_NOT_SUPPORTED",
    sent: 0,
  },
  {
    title: "rejects before liveness when the driver cannot resume",
    id: "s-noresume",
    resume: false,
    extra: { nativeSessionId: "n-1", ...livePid },
    message: "continue",
    error: "CAPABILITY_NOT_SUPPORTED",
    sent: 0,
  },
  {
    title: "rejects a live identical process as SESSION_BUSY",
    id: "s-busy",
    resume: true,
    extra: { nativeSessionId: "n-2", ...livePid },
    message: "continue",
    error: "SESSION_BUSY",
    sent: 0,
  },
  {
    title: "resumes past a recycled pid into a new working turn",
    id: "s-resume",
    resume: true,
    extra: { nativeSessionId: "n-3", pid: process.pid, pidStartTime: "stale-tick" },
    message: "continue",
    sent: 1,
    then: (daemon, sent) => {
      expect(sent[0].message).toBe("continue");
      expect(sent[0].session.nativeSessionId).toBe("n-3");
      expect(seam(daemon).sessions.get("s-resume")?.status).toBe("working");
    },
  },
  {
    title: "keeps the working busy check for non-interrupted sessions",
    id: "s-working",
    status: "working",
    resume: true,
    extra: { nativeSessionId: "n-4", ...livePid },
    message: "more work",
    error: "SESSION_BUSY",
    sent: 0,
  },
];

describe("power send admission for interrupted", () => {
  it.each(cases)("$title", async (c) => {
    const daemon = new Daemon();
    const sent: SentCall[] = [];
    installSendDriver(daemon, c.resume, sent);
    seed(daemon, c.id, c.status ?? "interrupted", c.extra ?? {});

    const res = await sendMessage(daemon, c.id, c.message);

    if (c.error === undefined) expect(res.error).toBeUndefined();
    else expect(res.error?.code).toBe(c.error);
    expect(sent).toHaveLength(c.sent);
    c.then?.(daemon, sent);
  });
});
