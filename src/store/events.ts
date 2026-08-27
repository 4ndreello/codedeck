import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "../core/events.js";

export interface EventRow {
  id: number;
  session_id: string;
  sequence: number;
  type: string;
  timestamp: string;
  normalized_payload: string;
  raw_payload: string | null;
  source_key: string | null;
}

export class EventStore {
  constructor(private db: DatabaseSync) {}

  append(sessionId: string, event: AgentEvent, raw?: unknown): number {
    if (event.sourceKey) {
      const existing = this.db.prepare(
        `SELECT sequence FROM events WHERE session_id = ? AND source_key = ? LIMIT 1`,
      ).get(sessionId, event.sourceKey) as { sequence: number } | undefined;
      if (existing) return 0;
    }
    // Get next sequence
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) as maxSeq FROM events WHERE session_id = ?`).get(sessionId) as { maxSeq: number };
    const nextSeq = (row?.maxSeq ?? 0) + 1;
    const normalized = JSON.stringify(event);
    const rawStr = raw !== undefined ? JSON.stringify(raw) : event.raw !== undefined ? JSON.stringify(event.raw) : null;

    const stmt = this.db.prepare(`
      INSERT INTO events (session_id, sequence, type, timestamp, normalized_payload, raw_payload, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(sessionId, nextSeq, event.type, event.timestamp, normalized, rawStr, event.sourceKey ?? null);
    // Update session last_event and updatedAt?
    // Let daemon do it
    return nextSeq;
  }

  list(sessionId: string, limit = 200, offset = 0): AgentEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?`,
    ).all(sessionId, limit, offset) as unknown as EventRow[];
    return rows.map((r) => JSON.parse(r.normalized_payload) as AgentEvent);
  }

  listRaw(sessionId: string): EventRow[] {
    return this.db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY sequence ASC`).all(sessionId) as unknown as EventRow[];
  }

  count(sessionId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ?`).get(sessionId) as { c: number };
    return row.c;
  }

  last(sessionId: string): AgentEvent | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1`).get(sessionId) as EventRow | undefined;
    if (!row) return null;
    return JSON.parse(row.normalized_payload) as AgentEvent;
  }
}
