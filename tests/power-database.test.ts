import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";

function openTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-db-"));
  const db = new Database(path.join(dir, "test.db"));
  return { dir, db };
}

describe("power sqlite wal handling", () => {
  it("applies busy_timeout, synchronous, and wal_autocheckpoint pragmas on open", () => {
    const { db } = openTempDb();
    try {
      const handle = db.getHandle();
      const busy = handle.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
      expect(Object.values(busy)[0]).toBe(5000);
      const sync = handle.prepare("PRAGMA synchronous").get() as Record<string, number>;
      expect(Object.values(sync)[0]).toBe(1);
      const checkpoint = handle.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>;
      expect(Object.values(checkpoint)[0]).toBe(1000);
    } finally {
      db.close();
    }
  });

  it("checkpoints best-effort on close without throwing", () => {
    const { dir, db } = openTempDb();
    expect(() => db.close()).not.toThrow();
    // Reopen proves the close (and checkpoint) left a usable database.
    const reopened = new Database(path.join(dir, "test.db"));
    expect(() => reopened.close()).not.toThrow();
  });
});
