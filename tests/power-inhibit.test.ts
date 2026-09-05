import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { processAlive } from "../src/utils/process.js";
import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import type { Session, SessionStatus } from "../src/core/session.js";
import { Daemon } from "../src/daemon/daemon.js";

let dir: string;
let savedPath: string | undefined;
let strayPids: number[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-inhibit-"));
  process.env.RUN_AGENT_DIR = dir;
  savedPath = process.env.PATH;
  strayPids = [];
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  delete process.env.RUN_AGENT_DIR;
  delete process.env.CODEDECK_INHIBIT_ARGS;
  for (const pid of strayPids) {
    try { if (processAlive(pid)) process.kill(pid, "SIGKILL"); } catch {}
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface DaemonTestSeam {
  db: Database;
  sessions: SessionStore;
  inhibitChild: ChildProcess | null;
  maybeSpawnInhibit(): void;
  handleShutdown(reason: string): Promise<void>;
}

function seam(daemon: Daemon): DaemonTestSeam {
  // Tests drive inhibit + shutdown directly (start() would bind a socket).
  return daemon as unknown as DaemonTestSeam;
}

function seed(daemon: Daemon, id: string, status: SessionStatus, extra: Partial<Session> = {}): void {
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

function reopenSessions(): SessionStore {
  return new SessionStore(new Database(path.join(dir, "run-agent.db")).getHandle());
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function writeFakeInhibit(binDir: string, argsFile: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "systemd-inhibit");
  fs.writeFileSync(script, `#!/bin/sh\necho "$@" > "$CODEDECK_INHIBIT_ARGS"\nexec sleep 30\n`);
  fs.chmodSync(script, 0o755);
}

describe("power systemd-inhibit child", () => {
  it("spawns with the exact argv and dies after TRUNCATE", async () => {
    const fakeBin = path.join(dir, "fakebin");
    const argsFile = path.join(dir, "inhibit-args.txt");
    process.env.CODEDECK_INHIBIT_ARGS = argsFile;
    writeFakeInhibit(fakeBin, argsFile);
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;

    const daemon = new Daemon();
    seam(daemon).maybeSpawnInhibit();

    expect(await waitFor(() => fs.existsSync(argsFile), 3000)).toBe(true);
    expect(fs.readFileSync(argsFile, "utf8").trim()).toBe(
      "--what=shutdown:sleep --who=CodeDeck --why=flush sessions --mode=delay sleep infinity",
    );
    const childPid = seam(daemon).inhibitChild?.pid;
    expect(childPid).toBeDefined();
    if (childPid !== undefined) {
      expect(processAlive(childPid)).toBe(true);
      strayPids.push(childPid);
    }

    const dbHandle = seam(daemon).db.getHandle();
    let truncateAt = 0;
    const execOrig = dbHandle.exec.bind(dbHandle);
    const execSpy = vi.spyOn(dbHandle, "exec").mockImplementation((sql: string) => {
      if (sql.includes("wal_checkpoint(TRUNCATE)")) truncateAt = Date.now();
      execOrig(sql);
    });
    seed(daemon, "s-inhibit", "working");
    try {
      await seam(daemon).handleShutdown("SIGTERM");
    } finally {
      execSpy.mockRestore();
    }

    expect(seam(daemon).inhibitChild).toBeNull();
    expect(truncateAt).toBeGreaterThan(0);
    let deathAt = 0;
    if (childPid !== undefined) {
      const died = await waitFor(() => !processAlive(childPid), 5000);
      expect(died).toBe(true);
      deathAt = Date.now();
    }
    expect(deathAt).toBeGreaterThanOrEqual(truncateAt);
    expect(reopenSessions().get("s-inhibit")?.status).toBe("interrupted");
  });

  it("is a silent no-op when systemd-inhibit is absent", async () => {
    const emptyBin = path.join(dir, "emptybin");
    fs.mkdirSync(emptyBin, { recursive: true });
    // PATH without the binary (and without `which` itself): silent absence.
    process.env.PATH = emptyBin;

    const daemon = new Daemon();
    seam(daemon).maybeSpawnInhibit();
    expect(seam(daemon).inhibitChild).toBeNull();

    seed(daemon, "s-noinhibit", "working");
    await seam(daemon).handleShutdown("SIGTERM");

    expect(reopenSessions().get("s-noinhibit")?.status).toBe("interrupted");
  });
});
