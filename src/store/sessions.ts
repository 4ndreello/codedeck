import type { DatabaseSync } from "node:sqlite";
import { type Session, type SessionStatus, type AgentId, isActiveStatus } from "../core/session.js";
import type { FailureInfo } from "../core/errors.js";
import { computeSessionCost } from "../core/pricing.js";
import type { UsageQueryParams, UsageQueryResult, UsageMetricBucket, UsageTotals } from "../daemon/protocol.js";

export interface SessionRow {
  id: string;
  run_id: string | null;
  name: string | null;
  agent: string;
  native_session_id: string | null;
  model: string | null;
  status: string;
  repository: string | null;
  cwd: string;
  worktree: string | null;
  branch: string | null;
  base_commit: string | null;
  pid: number | null;
  pid_start_time: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cached_tokens: number | null;
  usage_cost: number | null;
  last_event: string | null;
  effort: string | null;
  fast: number | null;
  sandbox: string | null;
  dangerously_bypass_approvals_and_sandbox: number | null;
  failure: string | null;
  log_offset: number | null;
  stderr_offset: number | null;
  origin: string | null;
}


function rowToSession(row: SessionRow): Session {
  // `failure` is stored as JSON text; tolerate a corrupt blob rather than
  // losing the whole session row over it.
  let failure: FailureInfo | undefined;
  if (row.failure) {
    try {
      failure = JSON.parse(row.failure) as FailureInfo;
    } catch {}
  }

  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    origin: (row.origin as Session["origin"]) ?? undefined,
    name: row.name ?? undefined,
    agent: row.agent as AgentId,
    nativeSessionId: row.native_session_id ?? undefined,
    model: row.model ?? undefined,
    effort: (row.effort as Session["effort"]) ?? undefined,
    // Stored as INTEGER; normalise to a real boolean so `ps --json` and the
    // resume path never see 0/1/null.
    fast: !!row.fast,
    sandbox: (row.sandbox as Session["sandbox"]) ?? undefined,
    dangerouslyBypassApprovalsAndSandbox: !!row.dangerously_bypass_approvals_and_sandbox,
    status: row.status as SessionStatus,
    repository: row.repository ?? undefined,
    cwd: row.cwd,
    worktree: row.worktree ?? undefined,
    branch: row.branch ?? undefined,
    baseCommit: row.base_commit ?? undefined,
    pid: row.pid ?? undefined,
    pidStartTime: row.pid_start_time ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    usage:
      row.usage_input_tokens != null ||
      row.usage_output_tokens != null ||
      row.usage_cached_tokens != null ||
      row.usage_cost != null
        ? {
            inputTokens: row.usage_input_tokens ?? undefined,
            outputTokens: row.usage_output_tokens ?? undefined,
            cachedTokens: row.usage_cached_tokens ?? undefined,
            cost: row.usage_cost ?? undefined,
          }
        : undefined,
    lastEvent: row.last_event ?? undefined,
    failure,
    logOffset: row.log_offset ?? undefined,
    stderrOffset: row.stderr_offset ?? undefined,
  };
}

/** Window for the default `ps` view: sessions updated within this are "recent". */
export const PS_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class SessionStore {
  constructor(private db: DatabaseSync) {}

  create(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, name, agent, native_session_id, model, status,
        repository, cwd, worktree, branch, base_commit, pid,
        pid_start_time, created_at, updated_at, completed_at,
        usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_cost,
        last_event, effort, fast, sandbox, dangerously_bypass_approvals_and_sandbox, failure, log_offset, stderr_offset,
        run_id, origin
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    stmt.run(
      session.id,
      session.name ?? null,
      session.agent,
      session.nativeSessionId ?? null,
      session.model ?? null,
      session.status,
      session.repository ?? null,
      session.cwd,
      session.worktree ?? null,
      session.branch ?? null,
      session.baseCommit ?? null,
      session.pid ?? null,
      session.pidStartTime ?? null,
      session.createdAt.toISOString(),
      session.updatedAt.toISOString(),
      session.completedAt ? session.completedAt.toISOString() : null,
      session.usage?.inputTokens ?? null,
      session.usage?.outputTokens ?? null,
      session.usage?.cachedTokens ?? null,
      session.usage?.cost ?? null,
      session.lastEvent ?? null,
      session.effort ?? null,
      session.fast ? 1 : 0,
      session.sandbox ?? null,
      session.dangerouslyBypassApprovalsAndSandbox ? 1 : 0,
      session.failure ? JSON.stringify(session.failure) : null,
      session.logOffset ?? null,
      session.stderrOffset ?? null,
      session.runId ?? null,
      session.origin ?? null,
    );
  }

  get(id: string): Session | null {
    // Support prefix matching like git short hash: if exact not found, try prefix
    let row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    if (!row && id.length >= 2) {
      row = this.db.prepare(`SELECT * FROM sessions WHERE id LIKE ? LIMIT 1`).get(`${id}%`) as SessionRow | undefined;
    }
    if (!row) return null;
    return rowToSession(row);
  }

  list(limit = 50, includeAll = false): Session[] {
    if (includeAll) {
      const rows = this.db.prepare(
        `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`,
      ).all(limit) as unknown as SessionRow[];
      return rows.map(rowToSession);
    }
    const cutoff = new Date(Date.now() - PS_RECENT_WINDOW_MS).toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM sessions WHERE status IN ('starting','working','needs_input','idle') OR updated_at >= ? ORDER BY updated_at DESC LIMIT ?`,
    ).all(cutoff, limit) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Rows excluded from the default `ps` view by the 24h window (LIMIT truncation excluded). */
  countHiddenByWindow(): number {
    const cutoff = new Date(Date.now() - PS_RECENT_WINDOW_MS).toISOString();
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM sessions WHERE status NOT IN ('starting','working','needs_input','idle') AND updated_at < ?`,
    ).get(cutoff) as unknown as { count: number };
    return row.count;
  }

  listActive(): Session[] {
    const rows = this.db.prepare(
      `SELECT * FROM sessions WHERE status IN ('starting','working','needs_input','idle') ORDER BY updated_at DESC`,
    ).all() as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  getByRunId(runId: string): Session[] {
    const rows = this.db.prepare(
      `SELECT * FROM sessions WHERE run_id = ? ORDER BY updated_at DESC`,
    ).all(runId) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  listByRunId(runId: string): Session[] {
    return this.getByRunId(runId);
  }

  update(id: string, patch: Partial<Session> & { status?: SessionStatus }): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`Session ${id} not found`);
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const map: Record<string, unknown> = {
      name: patch.name,
      agent: patch.agent,
      native_session_id: patch.nativeSessionId,
      model: patch.model,
      status: patch.status,
      repository: patch.repository,
      cwd: patch.cwd,
      worktree: patch.worktree,
      branch: patch.branch,
      base_commit: patch.baseCommit,
      pid: patch.pid,
      completed_at: patch.completedAt ? (patch.completedAt as Date).toISOString() : undefined,
      usage_input_tokens: patch.usage?.inputTokens,
      usage_output_tokens: patch.usage?.outputTokens,
      usage_cached_tokens: patch.usage?.cachedTokens,
      usage_cost: patch.usage?.cost,
      last_event: patch.lastEvent,
      effort: patch.effort,
      fast: patch.fast === undefined ? undefined : patch.fast ? 1 : 0,
      sandbox: patch.sandbox,
      dangerously_bypass_approvals_and_sandbox: patch.dangerouslyBypassApprovalsAndSandbox === undefined ? undefined : patch.dangerouslyBypassApprovalsAndSandbox ? 1 : 0,
      pid_start_time: patch.pidStartTime,
      log_offset: patch.logOffset,
      stderr_offset: patch.stderrOffset,
      failure: patch.failure === undefined ? undefined : JSON.stringify(patch.failure),
      origin: patch.origin,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = ?`);
        values.push(val);
      }
    }
    // Always update updated_at unless explicitly set
    if (!fields.includes("updated_at = ?")) {
      fields.push("updated_at = ?");
      values.push(patch.updatedAt ? (patch.updatedAt as Date).toISOString() : now);
    }
    if (fields.length === 0) return;
    values.push(id);
    (this.db.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`) as any).run(...(values as any));
  }

  setStatus(id: string, status: SessionStatus, extra?: Partial<Session>): void {
    const patch: Partial<Session> & { status: SessionStatus } = { status, updatedAt: new Date(), ...extra };
    if (status === "completed" || status === "failed" || status === "stopped" || status === "orphaned" || status === "interrupted") {
      patch.completedAt = new Date();
    }
    this.update(id, patch);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  findByNativeId(nativeId: string): Session | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE native_session_id = ? LIMIT 1`).get(nativeId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  queryUsage(params: UsageQueryParams = {}): UsageQueryResult {
    const { since, until } = resolveUsageDateRange(params);

    const rows = this.db.prepare(`
      SELECT 
        id, run_id, name, agent, model, status,
        repository, cwd, worktree,
        created_at, updated_at, completed_at,
        usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_cost
      FROM sessions
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at ASC
    `).all(since, until) as Array<{
      id: string;
      run_id: string | null;
      name: string | null;
      agent: string;
      model: string | null;
      status: string;
      repository: string | null;
      cwd: string;
      worktree: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
      usage_input_tokens: number | null;
      usage_output_tokens: number | null;
      usage_cached_tokens: number | null;
      usage_cost: number | null;
    }>;

    const totals: UsageTotals = {
      sessionCount: 0,
      activeSessionCount: 0,
      completedSessionCount: 0,
      failedSessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
    };

    const byDayMap = new Map<string, UsageMetricBucket>();
    const byRepoMap = new Map<string, UsageMetricBucket>();
    const byModelMap = new Map<string, UsageMetricBucket>();
    const byAgentMap = new Map<string, UsageMetricBucket>();
    const byRunMap = new Map<string, UsageMetricBucket>();

    const repoFilter = params.repository?.toLowerCase();
    const modelFilter = params.model?.toLowerCase();
    const agentFilter = params.agent;
    const runIdFilter = params.runId;

    for (const row of rows) {
      if (runIdFilter && row.run_id !== runIdFilter) continue;
      if (agentFilter && row.agent !== agentFilter) continue;
      if (modelFilter && (!row.model || !row.model.toLowerCase().includes(modelFilter))) continue;

      if (repoFilter) {
        const repoStr = [row.repository, row.cwd, row.worktree].filter(Boolean).join(" ").toLowerCase();
        if (!repoStr.includes(repoFilter)) continue;
      }

      const inputTokens = row.usage_input_tokens ?? 0;
      const outputTokens = row.usage_output_tokens ?? 0;
      const cachedTokens = row.usage_cached_tokens ?? 0;
      const totalTokens = inputTokens + outputTokens + cachedTokens;

      const cost = computeSessionCost({
        model: row.model,
        reportedCost: row.usage_cost,
        usage: { inputTokens, outputTokens, cachedTokens },
      });

      totals.sessionCount++;
      if (isActiveStatus(row.status as SessionStatus)) totals.activeSessionCount++;
      if (row.status === "completed") totals.completedSessionCount++;
      if (row.status === "failed") totals.failedSessionCount++;

      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.cachedTokens += cachedTokens;
      totals.totalTokens += totalTokens;

      if (cost === null) {
        totals.costComplete = false;
        totals.sessionsWithoutCost++;
      } else {
        totals.costUsd += cost;
      }

      const accumulate = (map: Map<string, UsageMetricBucket>, key: string, label?: string) => {
        let bucket = map.get(key);
        if (!bucket) {
          bucket = {
            key,
            label: label ?? key,
            sessionCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            costComplete: true,
          };
          map.set(key, bucket);
        }
        bucket.sessionCount++;
        bucket.inputTokens += inputTokens;
        bucket.outputTokens += outputTokens;
        bucket.cachedTokens += cachedTokens;
        bucket.totalTokens += totalTokens;
        if (cost === null) {
          bucket.costComplete = false;
        } else {
          bucket.costUsd += cost;
        }
      };

      // Day (local date string YYYY-MM-DD)
      const d = new Date(row.created_at);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      accumulate(byDayMap, dayKey);

      // Repo
      const repoKey = row.repository || row.cwd;
      accumulate(byRepoMap, repoKey);

      // Model
      accumulate(byModelMap, row.model || "unknown");

      // Agent
      accumulate(byAgentMap, row.agent);

      // Run
      if (row.run_id) {
        accumulate(byRunMap, row.run_id, row.name ? `${row.name} (${row.run_id.slice(0, 8)})` : row.run_id.slice(0, 8));
      }
    }

    const sortDescending = (a: UsageMetricBucket, b: UsageMetricBucket) => {
      if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
      return b.totalTokens - a.totalTokens;
    };

    const byDay = [...byDayMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const byRepository = [...byRepoMap.values()].sort(sortDescending);
    const byModel = [...byModelMap.values()].sort(sortDescending);
    const byAgent = [...byAgentMap.values()].sort(sortDescending);
    const byRun = [...byRunMap.values()].sort(sortDescending);

    return {
      range: {
        period: params.period,
        since,
        until,
      },
      totals,
      byDay,
      byRepository,
      byModel,
      byAgent,
      byRun,
    };
  }
}

export function resolveUsageDateRange(params: UsageQueryParams = {}): { since: string; until: string } {
  const now = new Date();
  let sinceDate: Date;
  const untilDate: Date = params.until ? new Date(params.until) : now;

  if (params.since) {
    sinceDate = new Date(params.since);
  } else if (params.period === "today") {
    sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  } else if (params.period === "3d") {
    sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 0, 0, 0, 0);
  } else if (params.period === "7d") {
    sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
  } else if (params.period === "30d") {
    sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0);
  } else if (params.period === "all") {
    sinceDate = new Date(0);
  } else {
    // Default to today
    sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }

  return {
    since: sinceDate.toISOString(),
    until: untilDate.toISOString(),
  };
}

