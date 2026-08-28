import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPaths, ensureDirs } from "../config/paths.js";

export class Database {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath?: string) {
    const p = getPaths();
    this.dbPath = dbPath ?? p.db;
    ensureDirs();
    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        agent TEXT NOT NULL,
        native_session_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        repository TEXT,
        cwd TEXT NOT NULL,
        worktree TEXT,
        branch TEXT,
        base_commit TEXT,
        pid INTEGER,
        pid_start_time TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        usage_input_tokens INTEGER,
        usage_output_tokens INTEGER,
        usage_cached_tokens INTEGER,
        usage_cost REAL,
        last_event TEXT,
        effort TEXT,
        fast INTEGER NOT NULL DEFAULT 0,
        sandbox TEXT,
        dangerously_bypass_approvals_and_sandbox INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        normalized_payload TEXT NOT NULL,
        raw_payload TEXT,
        source_key TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
    `);

    this.addMissingColumns();
  }

  // CREATE TABLE IF NOT EXISTS is a no-op on databases that already exist, so
  // columns added after the first release have to be applied explicitly or
  // every existing ~/.run-agent/run-agent.db throws "no such column".
  private addMissingColumns(): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(sessions)`).all() as any[]).map((c) => c.name as string),
    );
    const additions: Array<[string, string]> = [
      ["effort", "TEXT"],
      ["fast", "INTEGER NOT NULL DEFAULT 0"],
      ["sandbox", "TEXT"],
      ["dangerously_bypass_approvals_and_sandbox", "INTEGER"],
      ["failure", "TEXT"],
      ["log_offset", "INTEGER"],
      ["stderr_offset", "INTEGER"],
      ["pid_start_time", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    const eventColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(events)`).all() as any[]).map((c) => c.name as string),
    );
    if (!eventColumns.has("source_key")) this.db.exec(`ALTER TABLE events ADD COLUMN source_key TEXT`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_key ON events(session_id, source_key) WHERE source_key IS NOT NULL`);
  }

  getHandle(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  getPath(): string {
    return this.dbPath;
  }
}

let singleton: Database | null = null;

export function getDatabase(dbPath?: string): Database {
  if (dbPath) return new Database(dbPath);
  if (!singleton) singleton = new Database();
  return singleton;
}

export function closeDatabase(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
