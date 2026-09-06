import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Minimatch, minimatch } from "minimatch";
import { isTerminalStatus, type SessionStatus } from "../core/session.js";
import { RunAgentError, SessionNotFoundError } from "../core/errors.js";

export interface Claim {
  id: number;
  sessionId: string;
  pathGlob: string;
  reason: string;
  createdAt: string;
  active: boolean;
}

export interface ClaimRow {
  id: number;
  session_id: string;
  path_glob: string;
  reason: string;
  created_at: string;
  active: number;
}

export class ClaimNotFoundError extends RunAgentError {
  constructor(claimId: number) {
    super(`Claim "${claimId}" not found`, "CLAIM_NOT_FOUND", { claimId });
  }
}

export class ClaimNotOwnedError extends RunAgentError {
  constructor(claimId: number) {
    super(`Claim "${claimId}" is owned by another session`, "CLAIM_NOT_OWNED", { claimId });
  }
}

interface SessionContextRow {
  id: string;
  status: string;
  cwd: string;
  repository: string | null;
  worktree: string | null;
}

interface StaleClaimRow {
  id: number;
  status: string | null;
}

const MATCH_OPTIONS = {
  dot: true,
  nocase: false,
  nobrace: true,
  noext: true,
} as const;

function rowToClaim(row: ClaimRow): Claim {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    pathGlob: row.path_glob,
    reason: row.reason,
    createdAt: row.created_at,
    active: row.active === 1,
  };
}

function sessionRoot(session: SessionContextRow): string {
  return session.worktree ?? session.repository ?? session.cwd;
}

function normalizeRepoPath(value: string, root: string): string {
  const rootPath = path.resolve(root.replaceAll("\\", "/"));
  const candidate = path.resolve(rootPath, value.replaceAll("\\", "/"));
  const relative = path.relative(rootPath, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RunAgentError(
      `Claim path "${value}" escapes the session root`,
      "INVALID_PATH",
      { path: value, root },
    );
  }
  return relative ? relative.replaceAll("\\", "/") : ".";
}

function hasGlobMagic(value: string): boolean {
  return new Minimatch(value, MATCH_OPTIONS).hasMagic();
}

export class ClaimsStore {
  constructor(private db: DatabaseSync) {}

  add(sessionId: string, pathGlob: string, reason: string): Claim {
    return this.withOperation(() => {
      const session = this.getSession(sessionId);
      const normalizedGlob = normalizeRepoPath(pathGlob, sessionRoot(session));
      const existing = this.db.prepare(
        `SELECT * FROM claims WHERE session_id = ? AND path_glob = ? AND active = 1 LIMIT 1`,
      ).get(sessionId, normalizedGlob) as ClaimRow | undefined;

      if (existing) {
        this.db.prepare(`UPDATE claims SET reason = ? WHERE id = ?`).run(reason, existing.id);
        const updated = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(existing.id) as unknown as ClaimRow;
        return rowToClaim(updated);
      }

      const result = this.db.prepare(`
        INSERT INTO claims (session_id, path_glob, reason, created_at, active)
        VALUES (?, ?, ?, ?, 1)
      `).run(sessionId, normalizedGlob, reason, new Date().toISOString());
      const inserted = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(Number(result.lastInsertRowid)) as ClaimRow | undefined;
      if (!inserted) throw new Error("Inserted claim could not be read back");
      return rowToClaim(inserted);
    });
  }

  query(sessionId: string, path?: string): Claim[] {
    return this.withOperation(() => {
      let normalizedPath: string | undefined;
      if (path !== undefined) {
        const session = this.getSession(sessionId);
        normalizedPath = normalizeRepoPath(path, sessionRoot(session));
      }

      const rows = this.db.prepare(`
        SELECT c.*
        FROM claims c
        INNER JOIN sessions s ON s.id = c.session_id
        WHERE c.active = 1
        ORDER BY c.id ASC
      `).all() as unknown as ClaimRow[];

      if (normalizedPath === undefined) return rows.map(rowToClaim);
      const queryIsGlob = hasGlobMagic(normalizedPath);
      return rows
        .filter((row) => {
          if (!queryIsGlob) return minimatch(normalizedPath, row.path_glob, MATCH_OPTIONS);
          return minimatch(row.path_glob, normalizedPath, MATCH_OPTIONS) || minimatch(normalizedPath, row.path_glob, MATCH_OPTIONS);
        })
        .map(rowToClaim);
    });
  }

  release(sessionId: string, claimId: number): Claim {
    return this.withOperation(() => {
      const row = this.db.prepare(`SELECT * FROM claims WHERE id = ? LIMIT 1`).get(claimId) as ClaimRow | undefined;
      if (!row || row.active !== 1) throw new ClaimNotFoundError(claimId);
      if (row.session_id !== sessionId) throw new ClaimNotOwnedError(claimId);

      this.db.prepare(`UPDATE claims SET active = 0 WHERE id = ? AND session_id = ? AND active = 1`).run(claimId, sessionId);
      return { ...rowToClaim(row), active: false };
    });
  }

  private getSession(sessionId: string): SessionContextRow {
    const row = this.db.prepare(`
      SELECT id, status, cwd, repository, worktree
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) as SessionContextRow | undefined;
    if (!row) throw new SessionNotFoundError(sessionId);
    return row;
  }

  private releaseStaleClaims(): void {
    const staleRows = this.db.prepare(`
      SELECT c.id, s.status
      FROM claims c
      LEFT JOIN sessions s ON s.id = c.session_id
      WHERE c.active = 1
    `).all() as unknown as StaleClaimRow[];
    const release = this.db.prepare(`UPDATE claims SET active = 0 WHERE id = ? AND active = 1`);
    for (const row of staleRows) {
      if (row.status === null || isTerminalStatus(row.status as SessionStatus)) release.run(row.id);
    }
  }

  private withOperation<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.releaseStaleClaims();
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}
