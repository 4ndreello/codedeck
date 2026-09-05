// Shared scaffolding for the power daemon tests: one seam, one seeder, one
// socket stub. Extracted so the per-feature files don't repeat the same
// block (Sonar duplication gate); assertions live in the test files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
