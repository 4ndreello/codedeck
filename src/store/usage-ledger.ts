import type { DatabaseSync } from "node:sqlite";
import { SessionStore } from "./sessions.js";

export interface UsageObservation {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  model?: string;
}

export interface UsageAttribution {
  sessionId: string;
  sourceKey: string;
  cost: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface UsageSourceRow {
  source_key: string;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
}

interface UsageAttributionRow {
  session_id: string;
  source_key: string;
  cost: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

interface SessionUsageRow {
  model: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cached_tokens: number | null;
  usage_cost: number | null;
}

const fields = [
  { observation: "cost", source: "cost", attribution: "cost" },
  { observation: "inputTokens", source: "input_tokens", attribution: "input_tokens" },
  { observation: "outputTokens", source: "output_tokens", attribution: "output_tokens" },
  { observation: "cachedTokens", source: "cached_tokens", attribution: "cached_tokens" },
] as const;

export class UsageLedger {
  constructor(private db: DatabaseSync) {}

  observe(
    sessionId: string,
    sourceKey: string,
    obs: UsageObservation,
    seedIntoIncoming = true,
  ): boolean {
    const session = this.db.prepare(`
      SELECT model, usage_input_tokens, usage_output_tokens,
        usage_cached_tokens, usage_cost
      FROM sessions WHERE id = ?
    `).get(sessionId) as SessionUsageRow | undefined;
    if (!session) throw new Error(`Session ${sessionId} not found`);

    this.seedSessionUsage(sessionId, sourceKey, session, seedIntoIncoming);

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO usage_sources (source_key, cost, input_tokens, output_tokens, cached_tokens, updated_at)
      VALUES (?, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(source_key) DO NOTHING
    `).run(sourceKey, now);

    const source = this.db.prepare(
      `SELECT * FROM usage_sources WHERE source_key = ?`,
    ).get(sourceKey) as unknown as UsageSourceRow;
    const deltas: Record<string, number> = {};
    const sourceUpdates: string[] = [];
    const sourceValues: Array<string | number | null> = [];

    for (const field of fields) {
      const observed = obs[field.observation];
      if (observed === undefined) continue;
      const storedMark = source[field.source];
      const mark = storedMark ?? 0;
      const delta = observed - mark;
      if (delta < 0 || (delta === 0 && storedMark !== null)) continue;
      deltas[field.attribution] = delta;
      sourceUpdates.push(`${field.source} = ?`);
      sourceValues.push(observed);
    }

    if (sourceUpdates.length > 0) {
      sourceValues.push(now, sourceKey);
      this.db.prepare(`
        UPDATE usage_sources SET ${sourceUpdates.join(", ")}, updated_at = ?
        WHERE source_key = ?
      `).run(...sourceValues);
      this.addAttribution(sessionId, sourceKey, deltas);
      this.materialize(sessionId);
    }

    if (obs.model !== undefined && session.model === null) {
      this.db.prepare(`UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL`)
        .run(obs.model, sessionId);
    }

    return sourceUpdates.length > 0;
  }

  attributionsFor(sessionIds: readonly string[]): UsageAttribution[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT session_id, source_key, cost, input_tokens, output_tokens, cached_tokens
      FROM usage_attributions
      WHERE session_id IN (${placeholders})
      ORDER BY session_id, source_key
    `).all(...sessionIds) as unknown as UsageAttributionRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      sourceKey: row.source_key,
      cost: row.cost,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
    }));
  }

  hasSource(sourceKey: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM usage_sources WHERE source_key = ?`,
    ).get(sourceKey) !== undefined;
  }

  private seedSessionUsage(
    sessionId: string,
    sourceKey: string,
    session: SessionUsageRow,
    seedIntoIncoming: boolean,
  ): void {
    const hasUsage = session.usage_input_tokens !== null ||
      session.usage_output_tokens !== null ||
      session.usage_cached_tokens !== null ||
      session.usage_cost !== null;
    if (!hasUsage) return;

    const attribution = this.db.prepare(
      `SELECT 1 FROM usage_attributions WHERE session_id = ? LIMIT 1`,
    ).get(sessionId);
    if (attribution) return;

    const existingSource = this.db.prepare(
      `SELECT * FROM usage_sources WHERE source_key = ?`,
    ).get(sourceKey) as unknown as UsageSourceRow | undefined;
    const sourceHasMark = existingSource !== undefined && fields.some(
      (field) => existingSource[field.source] !== null,
    );
    const attributionSourceKey = seedIntoIncoming && !sourceHasMark
      ? sourceKey
      : `seed:${sessionId}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO usage_sources (source_key, cost, input_tokens, output_tokens, cached_tokens, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        cost = excluded.cost,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_tokens = excluded.cached_tokens,
        updated_at = excluded.updated_at
    `).run(
      attributionSourceKey,
      session.usage_cost,
      session.usage_input_tokens,
      session.usage_output_tokens,
      session.usage_cached_tokens,
      now,
    );
    this.db.prepare(`
      INSERT INTO usage_attributions (
        session_id, source_key, cost, input_tokens, output_tokens, cached_tokens
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      attributionSourceKey,
      session.usage_cost,
      session.usage_input_tokens ?? 0,
      session.usage_output_tokens ?? 0,
      session.usage_cached_tokens ?? 0,
    );
  }

  private addAttribution(
    sessionId: string,
    sourceKey: string,
    deltas: Record<string, number>,
  ): void {
    const current = this.db.prepare(`
      SELECT * FROM usage_attributions WHERE session_id = ? AND source_key = ?
    `).get(sessionId, sourceKey) as UsageAttributionRow | undefined;
    const cost = deltas.cost === undefined
      ? current?.cost ?? null
      : (current?.cost ?? 0) + deltas.cost;
    const inputTokens = (current?.input_tokens ?? 0) + (deltas.input_tokens ?? 0);
    const outputTokens = (current?.output_tokens ?? 0) + (deltas.output_tokens ?? 0);
    const cachedTokens = (current?.cached_tokens ?? 0) + (deltas.cached_tokens ?? 0);

    this.db.prepare(`
      INSERT INTO usage_attributions (
        session_id, source_key, cost, input_tokens, output_tokens, cached_tokens
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, source_key) DO UPDATE SET
        cost = excluded.cost,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_tokens = excluded.cached_tokens
    `).run(sessionId, sourceKey, cost, inputTokens, outputTokens, cachedTokens);
  }

  private materialize(sessionId: string): void {
    const usage = this.db.prepare(`
      SELECT SUM(cost) AS cost, SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens, SUM(cached_tokens) AS cached_tokens
      FROM usage_attributions WHERE session_id = ?
    `).get(sessionId) as {
      cost: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
    };
    new SessionStore(this.db).update(sessionId, {
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cachedTokens: usage.cached_tokens ?? 0,
        ...(usage.cost === null ? {} : { cost: usage.cost }),
      },
    });
    this.db.prepare(`UPDATE sessions SET usage_cost = ? WHERE id = ?`)
      .run(usage.cost, sessionId);
  }
}
