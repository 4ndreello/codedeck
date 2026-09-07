// Shared scaffolding for daemon tests: one seam, one seeder, one
// socket stub. Extracted so the per-feature files don't repeat the same
// block (Sonar duplication gate); assertions live in the test files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import type net from "node:net";
import type { ChildProcess } from "node:child_process";
import type { Daemon } from "../src/daemon/daemon.js";
import type { Session, SessionStatus } from "../src/core/session.js";
import type { SessionStore } from "../src/store/sessions.js";
import type { EventStore } from "../src/store/events.js";
import type { Database } from "../src/store/database.js";

export interface DaemonTestSeam {
  sessions: SessionStore;
  events: EventStore;
  registry: { register(driver: unknown): void };
  db: Database;
  inhibitChild: ChildProcess | null;
  handleRequest(req: { id: string; method: string; params: unknown }, socket: net.Socket): Promise<void>;
  handleShutdown(reason: string): Promise<void>;
  maybeSpawnInhibit(bin?: string): void;
  recover(): Promise<void>;
}

export function seam(daemon: Daemon): DaemonTestSeam {
  // Tests drive private lifecycle methods directly (no socket/server started).
  return daemon as unknown as DaemonTestSeam;
}

export function seed(daemon: Daemon, id: string, status: SessionStatus = "working", extra: Partial<Session> = {}): void {
  const now = new Date();
  seam(daemon).sessions.create({
    id,
    agent: "claude",
    status,
    cwd: "/tmp",
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

export function fakeSocket(): { writes: string[]; socket: net.Socket } {
  const writes: string[] = [];
  // Minimal writable surface handleRequest uses (write only, plus on() for
  // subscribe flows that some tests drive through the same stub).
  const socket = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    on: () => {},
  };
  return { writes, socket: socket as unknown as net.Socket };
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

export interface DaemonTestContext {
  readonly runAgentDir: string;
  start(): void;
  cleanup(daemon: Daemon | undefined): void;
  nextRequestId(prefix: string): string;
}

export function makeDaemonTestContext(prefix: string): DaemonTestContext {
  const originalRunAgentDir = process.env.RUN_AGENT_DIR;
  let runAgentDir: string | undefined;
  let requestNumber = 0;

  return {
    get runAgentDir(): string {
      if (runAgentDir === undefined) throw new Error("daemon test context is not active");
      return runAgentDir;
    },
    start(): void {
      runAgentDir = makeTempDir(prefix);
      process.env.RUN_AGENT_DIR = runAgentDir;
      requestNumber = 0;
    },
    cleanup(daemon: Daemon | undefined): void {
      try { if (daemon) seam(daemon).db.close(); } catch {}
      if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = originalRunAgentDir;
      removeTempDir(runAgentDir);
      runAgentDir = undefined;
    },
    nextRequestId(requestPrefix: string): string {
      return `${requestPrefix}-${++requestNumber}`;
    },
  };
}

export function registerDaemonTestHooks(
  context: DaemonTestContext,
  getDaemon: () => Daemon | undefined,
  clearDaemon: () => void,
): void {
  beforeEach(() => context.start());
  afterEach(() => {
    context.cleanup(getDaemon());
    clearDaemon();
  });
}
