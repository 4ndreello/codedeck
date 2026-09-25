import type { DatabaseSync } from "node:sqlite";
import { type Session, type SessionStatus, type AgentId, isActiveStatus } from "../core/session.js";
import type { FailureInfo } from "../core/errors.js";
import { cachedInInputFor, computeSessionCost, totalTokensFor } from "../core/pricing.js";
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
  parent_id: string | null;
  role: string | null;
  pending_message: string | null;
  pending_at: string | null;
}

interface UsageLegacyRow {
  native_id: string;
  ended_at: string;
  cwd: string | null;
  repository: string | null;
  model: string | null;
  cost: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
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
    parentId: row.parent_id ?? undefined,
    role: row.role ?? undefined,
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
    pendingMessage: row.pending_message ?? undefined,
    pendingAt: row.pending_at ?? undefined,
    logOffset: row.log_offset ?? undefined,
    stderrOffset: row.stderr_offset ?? undefined,
  };
}

/** Window for the default `ps` view: sessions updated within this are "recent". */
export const PS_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

type SessionUpdate = Omit<
  Partial<Session>,
  "completedAt" | "failure" | "lastEvent" | "pid" | "pidStartTime"
> & {
  completedAt?: Date | null;
  failure?: FailureInfo | null;
  lastEvent?: string | null;
  pid?: number | null;
  pidStartTime?: string | null;
};

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
        run_id, origin, pending_message, pending_at, parent_id, role
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
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
      session.pendingMessage ?? null,
      session.pendingAt ?? null,
      session.parentId ?? null,
      session.role ?? null,
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

  update(id: string, patch: SessionUpdate): void {
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
      pid: patch.pid === undefined ? undefined : patch.pid ?? null,
      completed_at: patch.completedAt === undefined
        ? undefined
        : patch.completedAt === null
          ? null
          : patch.completedAt.toISOString(),
      usage_input_tokens: patch.usage?.inputTokens,
      usage_output_tokens: patch.usage?.outputTokens,
      usage_cached_tokens: patch.usage?.cachedTokens,
      usage_cost: patch.usage?.cost,
      last_event: patch.lastEvent === undefined ? undefined : patch.lastEvent ?? null,
      effort: patch.effort,
      fast: patch.fast === undefined ? undefined : patch.fast ? 1 : 0,
      sandbox: patch.sandbox,
      dangerously_bypass_approvals_and_sandbox: patch.dangerouslyBypassApprovalsAndSandbox === undefined ? undefined : patch.dangerouslyBypassApprovalsAndSandbox ? 1 : 0,
      pid_start_time: patch.pidStartTime === undefined ? undefined : patch.pidStartTime ?? null,
      log_offset: patch.logOffset,
      stderr_offset: patch.stderrOffset,
      failure: patch.failure === undefined
        ? undefined
        : patch.failure === null
          ? null
          : JSON.stringify(patch.failure),
      origin: patch.origin,
      pending_message: patch.pendingMessage === undefined ? undefined : (patch.pendingMessage ?? null),
      pending_at: patch.pendingAt === undefined ? undefined : (patch.pendingAt ?? null),
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

  setStatus(id: string, status: SessionStatus, extra?: SessionUpdate): void {
    const patch: SessionUpdate & { status: SessionStatus } = { status, updatedAt: new Date(), ...extra };
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

  listOpenByNativeId(nativeId: string): Session[] {
    const rows = this.db.prepare(
      `SELECT * FROM sessions WHERE origin = 'open' AND native_session_id = ? ORDER BY updated_at DESC, id ASC`,
    ).all(nativeId) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  queryUsage(params: UsageQueryParams = {}): UsageQueryResult {
    const { since, until } = resolveUsageDateRange(params);

    const rows = this.db.prepare(`
      SELECT 
        id, run_id, name, agent, model, status,
        repository, cwd, worktree,
        created_at, updated_at, completed_at,
        usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_cost, origin
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
      origin: string | null;
    }>;
    const hasLegacyTable = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_legacy'`,
    ).get() !== undefined;
    const legacyRows: UsageLegacyRow[] = hasLegacyTable
      ? this.db.prepare(`
          SELECT native_id, ended_at, cwd, repository, model, cost,
            input_tokens, output_tokens, cached_tokens
          FROM usage_legacy
          WHERE ended_at >= ? AND ended_at <= ?
          ORDER BY ended_at ASC
        `).all(since, until) as unknown as UsageLegacyRow[]
      : [];
    const unknownOpenCostSessionIds = new Set(
      (this.db.prepare(`
        SELECT DISTINCT session_native_links.session_id
        FROM session_native_links
        INNER JOIN sessions ON sessions.id = session_native_links.session_id
        WHERE sessions.origin = 'open'
          AND session_native_links.state IN ('missing', 'no-price')
      `).all() as Array<{ session_id: string }>).map((row) => row.session_id),
    );

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
    const byOriginMap = new Map<string, UsageMetricBucket>();

    const repoFilter = params.repository?.toLowerCase();
    const modelFilter = params.model?.toLowerCase();
    const agentFilter = params.agent;
    const runIdFilter = params.runId;

    const accumulate = (
      map: Map<string, UsageMetricBucket>,
      key: string,
      inputTokens: number,
      outputTokens: number,
      cachedTokens: number,
      totalTokens: number,
      cost: number | null,
      label?: string,
    ) => {
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
      const totalTokens = totalTokensFor(row.agent, { inputTokens, outputTokens, cachedTokens });

      const calculatedCost = computeSessionCost({
        model: row.model,
        cachedInInput: cachedInInputFor(row.agent),
        reportedCost: row.usage_cost,
        usage: { inputTokens, outputTokens, cachedTokens },
      });
      const cost = unknownOpenCostSessionIds.has(row.id) ? null : calculatedCost;

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

      // Day (local date string YYYY-MM-DD)
      const d = new Date(row.created_at);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      accumulate(byDayMap, dayKey, inputTokens, outputTokens, cachedTokens, totalTokens, cost);

      // Repo (normalized project name across worktrees)
      const repoKey = normalizeProjectName(row);
      accumulate(byRepoMap, repoKey, inputTokens, outputTokens, cachedTokens, totalTokens, cost);

      // Model
      accumulate(byModelMap, row.model || "unknown", inputTokens, outputTokens, cachedTokens, totalTokens, cost);

      // Agent
      accumulate(byAgentMap, row.agent, inputTokens, outputTokens, cachedTokens, totalTokens, cost);

      // Run
      if (row.run_id) {
        accumulate(
          byRunMap,
          row.run_id,
          inputTokens,
          outputTokens,
          cachedTokens,
          totalTokens,
          cost,
          row.name ? `${row.name} (${row.run_id.slice(0, 8)})` : row.run_id.slice(0, 8),
        );
      }

      accumulate(
        byOriginMap,
        row.origin === "open" ? "orchestrator" : "worker",
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens,
        cost,
      );
    }

    for (const row of legacyRows) {
      if (runIdFilter) continue;
      if (agentFilter && agentFilter !== "claude") continue;
      if (modelFilter && (!row.model || !row.model.toLowerCase().includes(modelFilter))) continue;
      if (repoFilter) {
        const repoStr = [row.repository, row.cwd].filter(Boolean).join(" ").toLowerCase();
        if (!repoStr.includes(repoFilter)) continue;
      }

      const inputTokens = row.input_tokens;
      const outputTokens = row.output_tokens;
      const cachedTokens = row.cached_tokens;
      const totalTokens = totalTokensFor("claude", { inputTokens, outputTokens, cachedTokens });
      const cost = row.cost;

      totals.sessionCount++;
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

      const d = new Date(row.ended_at);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      accumulate(byDayMap, dayKey, inputTokens, outputTokens, cachedTokens, totalTokens, cost);
      accumulate(
        byRepoMap,
        normalizeProjectName({ repository: row.repository, cwd: row.cwd }),
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens,
        cost,
      );
      accumulate(byModelMap, row.model || "unknown", inputTokens, outputTokens, cachedTokens, totalTokens, cost);
      accumulate(byAgentMap, "claude", inputTokens, outputTokens, cachedTokens, totalTokens, cost);
      accumulate(byOriginMap, "orchestrator", inputTokens, outputTokens, cachedTokens, totalTokens, cost);
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
    const byOrigin = [...byOriginMap.values()].sort(sortDescending);

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
      byOrigin,
    };
  }
}

export function resolveUsageDateRange(params: UsageQueryParams = {}): { since: string; until: string } {
  const now = new Date();
  let sinceDate: Date;
  let untilDate: Date;
  if (params.until) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(params.until)) {
      untilDate = new Date(`${params.until}T23:59:59.999Z`);
    } else {
      untilDate = new Date(params.until);
    }
  } else {
    untilDate = now;
  }

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

export function normalizeProjectName(row: { repository?: string | null; cwd?: string | null; worktree?: string | null }): string {
  const all = [row.repository, row.cwd, row.worktree].filter(Boolean).join(" ");
  if (all.includes("codedeck") || all.includes("3189bd7a") || all.includes("orchestrator-presets")) {
    return "codedeck";
  }
  if (all.includes("thoth-analytics") || all.includes("b56732e7")) {
    return "thoth-analytics";
  }
  if (all.includes("bank-classifier")) {
    return "bank-classifier-mvp";
  }
  if (all.includes("toupeira")) {
    return "toupeira";
  }

  // If explicit repository exists and is not a worktree folder
  if (row.repository && !row.repository.includes(".run-agent/worktrees")) {
    const clean = row.repository.replace(/\/+$/, "");
    const parts = clean.split("/");
    return parts[parts.length - 1] || clean;
  }

  const cwd = row.cwd || "";
  const wtMatch = cwd.match(/(.*?)(?:\.worktrees|-wt)(?:\/.*)?$/);
  if (wtMatch && wtMatch[1]) {
    const parts = wtMatch[1].replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || wtMatch[1];
  }

  const cleanCwd = cwd.replace(/\/+$/, "");
  const parts = cleanCwd.split("/");
  return parts[parts.length - 1] || "other";
}


