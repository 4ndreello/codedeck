import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPaths, ensureDirs } from "../config/paths.js";

export interface DatabaseOptions {
  readOnly?: boolean;
}

export class Database {
  private db: DatabaseSync;
  private dbPath: string;
  private readOnly: boolean;

  constructor(dbPath?: string, options?: DatabaseOptions) {
    const p = getPaths();
    this.dbPath = dbPath ?? p.db;
    this.readOnly = options?.readOnly ?? false;
    if (!this.readOnly) {
      ensureDirs();
      // Ensure parent dir exists
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath, { readOnly: this.readOnly });
    if (!this.readOnly) {
      this.migrate();
    } else {
      try {
        this.db.exec(`PRAGMA busy_timeout = 5000;`);
      } catch {
        // Best-effort in read-only mode
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 1000;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT,
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
        dangerously_bypass_approvals_and_sandbox INTEGER,
        origin TEXT
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

      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        path_glob TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_active_session_path
        ON claims(session_id, path_glob) WHERE active = 1;
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
      ["run_id", "TEXT"],
      ["origin", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    const eventColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(events)`).all() as any[]).map((c) => c.name as string),
    );
    if (!eventColumns.has("source_key")) this.db.exec(`ALTER TABLE events ADD COLUMN source_key TEXT`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_key ON events(session_id, source_key) WHERE source_key IS NOT NULL`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_run_id ON sessions(run_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_usage_created ON sessions(created_at DESC, repository, agent, model)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_repo_created ON sessions(repository, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_model_created ON sessions(model, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent_created ON sessions(agent, created_at DESC)`);
  }

  getHandle(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (!this.readOnly) {
      try {
        this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
      } catch {
        // Best-effort: checkpoint must never block closing.
      }
    }
    this.db.close();
  }

  getPath(): string {
    return this.dbPath;
  }
}

let singleton: Database | null = null;

export function getDatabase(dbPath?: string, options?: DatabaseOptions): Database {
  if (options?.readOnly) return new Database(dbPath, options);
  if (dbPath) return new Database(dbPath, options);
  if (!singleton) singleton = new Database(undefined, options);
  return singleton;
}

export function closeDatabase(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

