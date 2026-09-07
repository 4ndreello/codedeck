import type { AgentId, Session } from "../core/session.js";
import type { CodexSandbox, ReasoningEffort } from "../core/driver.js";
import type { AgentEvent } from "../core/events.js";
import type { HarnessModels } from "../core/models.js";
import type { Claim } from "../store/claims.js";
import type { RunUsageSummary } from "../core/run-usage.js";

export type RequestMethod =
  | "session.create"
  | "session.adopt"
  | "session.patch"
  | "session.release"
  | "session.list"
  | "session.get"
  | "session.rename"
  | "session.send"
  | "session.stop"
  | "session.logs"
  | "session.diff"
  | "session.subscribe"
  | "claims.add"
  | "claims.query"
  | "claims.release"
  | "daemon.status"
  | "daemon.stop"
  | "doctor"
  | "models.list"
  | "usage.get"
  | "usage.query";

export interface RunOptions {
  prompt: string;
  runId?: string | null;
  agent?: AgentId;
  model?: string;
  effort?: ReasoningEffort;
  fast?: boolean;
  sandbox?: CodexSandbox;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  name?: string;
  cwd?: string;
  worktree?: boolean;
  noWorktree?: boolean;
  detach?: boolean;
}

export interface CreateSessionRequest {
  method: "session.create";
  params: RunOptions;
}

export interface AdoptSessionRequest {
  method: "session.adopt";
  params: {
    agent: AgentId;
    model?: string;
    cwd: string;
    name?: string;
    worktree?: string;
    branch?: string;
    baseCommit?: string;
  };
}

export interface PatchSessionRequest {
  method: "session.patch";
  params: {
    id: string;
    pid?: number;
    pidStartTime?: string;
    worktree?: string;
    branch?: string;
    baseCommit?: string;
    cwd?: string;
  };
}

export interface ReleaseSessionRequest {
  method: "session.release";
  params: {
    id: string;
    status?: "completed" | "failed";
    nativeSessionId?: string;
    error?: string;
  };
}

export interface ListSessionsRequest {
  method: "session.list";
  params: { all?: boolean; json?: boolean };
}

export interface GetSessionRequest {
  method: "session.get";
  params: { id: string };
}

export interface RenameSessionRequest {
  method: "session.rename";
  params: { id: string; name: string };
}

export interface SendSessionRequest {
  method: "session.send";
  params: { id: string; message: string };
}

export interface StopSessionRequest {
  method: "session.stop";
  params: { id: string };
}

export interface LogsSessionRequest {
  method: "session.logs";
  params: { id: string; follow?: boolean; raw?: boolean; json?: boolean };
}

export interface DiffSessionRequest {
  method: "session.diff";
  params: { id: string };
}

export interface SubscribeSessionRequest {
  method: "session.subscribe";
  params: { id: string };
}

export interface AddClaimRequest {
  method: "claims.add";
  params: { sessionId: string; pathGlob: string; reason: string };
}

export interface QueryClaimsRequest {
  method: "claims.query";
  params: { sessionId: string; path?: string };
}

export interface ReleaseClaimRequest {
  method: "claims.release";
  params: { sessionId: string; claimId: number };
}

export interface DaemonStatusRequest {
  method: "daemon.status";
  params: Record<string, never>;
}

export interface ListModelsRequest {
  method: "models.list";
  params: { agent?: AgentId; refresh?: boolean };
}

export interface GetUsageRequest {
  method: "usage.get";
  params: { runId: string };
}

export type UsagePeriod = "today" | "3d" | "7d" | "30d" | "all";

export interface UsageQueryParams {
  period?: UsagePeriod;
  since?: string;
  until?: string;
  repository?: string;
  model?: string;
  agent?: AgentId;
  runId?: string;
}

export interface UsageMetricBucket {
  key: string;
  label?: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  costComplete: boolean;
  trend?: number[];
}

export interface UsageTotals {
  sessionCount: number;
  activeSessionCount: number;
  completedSessionCount: number;
  failedSessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  costComplete: boolean;
  sessionsWithoutCost: number;
}

export interface UsageQueryResult {
  range: {
    period?: UsagePeriod;
    since: string;
    until: string;
  };
  totals: UsageTotals;
  byDay: UsageMetricBucket[];
  byRepository: UsageMetricBucket[];
  byModel: UsageMetricBucket[];
  byAgent: UsageMetricBucket[];
  byRun: UsageMetricBucket[];
}

export interface QueryUsageRequest {
  method: "usage.query";
  params?: UsageQueryParams;
}

export interface ListModelsResult {
  agents: HarnessModels[];
}

export type RequestParams =
  | CreateSessionRequest
  | AdoptSessionRequest
  | PatchSessionRequest
  | ReleaseSessionRequest
  | ListSessionsRequest
  | GetSessionRequest
  | RenameSessionRequest
  | SendSessionRequest
  | StopSessionRequest
  | LogsSessionRequest
  | DiffSessionRequest
  | SubscribeSessionRequest
  | AddClaimRequest
  | QueryClaimsRequest
  | ReleaseClaimRequest
  | DaemonStatusRequest
  | ListModelsRequest
  | GetUsageRequest
  | QueryUsageRequest;

export type UsageGetResult = RunUsageSummary;


export interface IpcRequest {
  id: string;
  method: RequestMethod;
  params: unknown;
}

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
  // For streaming, events are sent as separate messages with same id? Use type field
  type?: string;
  event?: AgentEvent;
  session?: Session;
}

export interface SessionCreateResult {
  session: Session;
}

export interface SessionAdoptResult {
  session: Session;
}

export interface SessionPatchResult {
  session: Session;
}

export interface SessionReleaseResult {
  session: Session;
}

export interface SessionListResult {
  sessions: Session[];
}

export interface ClaimAddResult {
  claim: Claim;
}

export interface ClaimQueryResult {
  claims: Claim[];
}

export interface ClaimReleaseResult {
  claim: Claim;
}

export interface DoctorResult {
  node: { version: string };
  git: { installed: boolean; version?: string };
  agents: Record<string, { installed: boolean; version?: string; authenticated?: boolean; details?: string; error?: string; capabilities?: unknown }>;
  daemon: { running: boolean; pid?: number; uptime?: number };
  database: { path: string; exists: boolean };
}
