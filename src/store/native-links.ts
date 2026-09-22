import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../core/session.js";
import { SessionStore } from "./sessions.js";

export type ReconcileState = "cost-state" | "tokens" | "no-price" | "missing";

export interface NativeLink {
  sessionId: string;
  nativeId: string;
  linkedAt: string;
  reconciledAt: string | null;
  state: ReconcileState | null;
}

interface NativeLinkRow {
  session_id: string;
  native_id: string;
  linked_at: string;
  reconciled_at: string | null;
  state: ReconcileState | null;
}

interface StaleCandidate {
  id: string;
  status: Session["status"];
}

function toNativeLink(row: NativeLinkRow): NativeLink {
  return {
    sessionId: row.session_id,
    nativeId: row.native_id,
    linkedAt: row.linked_at,
    reconciledAt: row.reconciled_at,
    state: row.state,
  };
}

export class NativeLinkStore {
  constructor(private db: DatabaseSync) {}

  link(sessionId: string, nativeId: string): { created: boolean; previous: string[] } {
    const previous = (this.db.prepare(`
      SELECT native_id FROM session_native_links
      WHERE session_id = ? AND native_id <> ? AND reconciled_at IS NULL
      ORDER BY linked_at, native_id
    `).all(sessionId, nativeId) as Array<{ native_id: string }>).map((row) => row.native_id);

    const result = this.db.prepare(`
      INSERT INTO session_native_links (session_id, native_id, linked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, native_id) DO NOTHING
    `).run(sessionId, nativeId, new Date().toISOString());

    return { created: Number(result.changes) > 0, previous };
  }

  unreconciled(sessionId: string): NativeLink[] {
    const rows = this.db.prepare(`
      SELECT session_id, native_id, linked_at, reconciled_at, state
      FROM session_native_links
      WHERE session_id = ? AND reconciled_at IS NULL
      ORDER BY linked_at, native_id
    `).all(sessionId) as unknown as NativeLinkRow[];
    return rows.map(toNativeLink);
  }

  linksFor(sessionIds: readonly string[]): NativeLink[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT session_id, native_id, linked_at, reconciled_at, state
      FROM session_native_links
      WHERE session_id IN (${placeholders})
      ORDER BY session_id, linked_at, native_id
    `).all(...sessionIds) as unknown as NativeLinkRow[];
    return rows.map(toNativeLink);
  }

  markReconciled(sessionId: string, nativeId: string, state: ReconcileState): void {
    this.db.prepare(`
      UPDATE session_native_links SET reconciled_at = ?, state = ?
      WHERE session_id = ? AND native_id = ?
    `).run(new Date().toISOString(), state, sessionId, nativeId);
  }

  staleOpenRows(isDead: (session: Session) => boolean): Session[] {
    const candidates = this.db.prepare(`
      SELECT DISTINCT sessions.id, sessions.status
      FROM sessions
      INNER JOIN session_native_links
        ON session_native_links.session_id = sessions.id
      WHERE sessions.origin = 'open'
        AND session_native_links.reconciled_at IS NULL
        AND sessions.status IN ('interrupted', 'working')
      ORDER BY sessions.created_at, sessions.id
    `).all() as unknown as StaleCandidate[];
    const sessions = new SessionStore(this.db);
    const stale: Session[] = [];

    for (const candidate of candidates) {
      const session = sessions.get(candidate.id);
      if (!session) continue;
      if (candidate.status === "interrupted" || (candidate.status === "working" && isDead(session))) {
        stale.push(session);
      }
    }

    return stale;
  }
}
