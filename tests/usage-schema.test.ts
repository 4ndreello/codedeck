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
          "usage_legacy",
        ]));
        const indexes = (db.getHandle().prepare(
          `PRAGMA index_list(usage_attributions)`,
        ).all() as Array<{ name: string }>).map((row) => row.name);
        expect(indexes).toContain("idx_usage_attributions_source_key");
        const legacyColumns = (db.getHandle().prepare(
          `PRAGMA table_info(usage_legacy)`,
        ).all() as Array<{ name: string }>).map((row) => row.name);
        expect(legacyColumns).toEqual(expect.arrayContaining([
          "native_id",
          "ended_at",
          "cwd",
          "repository",
          "model",
          "cost",
          "input_tokens",
          "output_tokens",
          "cached_tokens",
        ]));
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
        DROP TABLE usage_legacy;
      `);
      original.close();

      const migrated = new Database(file);
      try {
        expect(tableNames(migrated)).toEqual(expect.arrayContaining([
          "usage_sources",
          "usage_attributions",
          "session_native_links",
          "usage_legacy",
        ]));
      } finally {
        migrated.close();
      }

      const reopened = new Database(file);
      expect(tableNames(reopened)).toEqual(expect.arrayContaining([
        "usage_sources",
        "usage_attributions",
        "session_native_links",
        "usage_legacy",
      ]));
      reopened.close();
    });
  });
});
