import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// One daemon per RUN_AGENT_DIR. Without this, a CLI whose 1s socket probe
// times out against a busy daemon spawns another one, which unlinks the
// live socket and reattaches the same sessions: N daemons then tail the
// same logs and race each other in SQLite ("database is locked").
//
// The lock is a tiny SQLite file held in EXCLUSIVE locking mode. SQLite
// takes an fcntl lock that the kernel drops when the process dies, even on
// SIGKILL, so there is no stale pid file to judge. It is a separate file
// because an exclusive lock on run-agent.db would block read-only CLIs.
//
// Kept free of TypeScript-only syntax and relative imports: the test loads
// this file in a child process with --experimental-strip-types.

export interface InstanceLock {
  release(): void;
}

export function acquireInstanceLock(lockPath: string): InstanceLock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const db = new DatabaseSync(lockPath);
  try {
    // busy_timeout 0: a held lock must refuse now, not after a wait.
    db.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA journal_mode = DELETE;
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, acquired_at TEXT NOT NULL);
      DELETE FROM owner;
    `);
    db.prepare(`INSERT INTO owner (pid, acquired_at) VALUES (?, ?)`).run(process.pid, new Date().toISOString());
    // In EXCLUSIVE locking mode the lock outlives the COMMIT until close.
    db.exec(`COMMIT;`);
  } catch {
    try { db.close(); } catch {}
    return null;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try { db.close(); } catch {}
    },
  };
}
