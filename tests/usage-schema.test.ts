import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";

function withTempDb(fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-schema-"));
  const file = path.join(dir, "test.db");
  try {
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tableNames(db: Database): string[] {
  return (db.getHandle().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

describe("usage database schema", () => {
  it("creates the usage tables and source index on a fresh database", () => {
    withTempDb((file) => {
      const db = new Database(file);
      try {
        expect(tableNames(db)).toEqual(expect.arrayContaining([
          "usage_sources",
          "usage_attributions",
          "session_native_links",
        ]));
        const indexes = (db.getHandle().prepare(
          `PRAGMA index_list(usage_attributions)`,
        ).all() as Array<{ name: string }>).map((row) => row.name);
        expect(indexes).toContain("idx_usage_attributions_source_key");
      } finally {
        db.close();
      }
    });
  });

  it("migrates a database without usage tables and remains idempotent", () => {
    withTempDb((file) => {
      const original = new Database(file);
      original.getHandle().exec(`
        DROP TABLE session_native_links;
        DROP TABLE usage_attributions;
        DROP TABLE usage_sources;
      `);
      original.close();

      const migrated = new Database(file);
      try {
        expect(tableNames(migrated)).toEqual(expect.arrayContaining([
          "usage_sources",
          "usage_attributions",
          "session_native_links",
        ]));
      } finally {
        migrated.close();
      }

      const reopened = new Database(file);
      expect(tableNames(reopened)).toEqual(expect.arrayContaining([
        "usage_sources",
        "usage_attributions",
        "session_native_links",
      ]));
      reopened.close();
    });
  });
});
