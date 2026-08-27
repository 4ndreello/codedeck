import type { AgentId } from "./session.js";
import type { FailureInfo } from "./errors.js";

export type AgentEventType =
  | "session.started"
  | "turn.started"
  | "text.delta"
  | "message"
  | "tool.started"
  | "tool.completed"
  | "file.changed"
  | "permission.requested"
  | "permission.resolved"
  | "usage.updated"
  | "turn.completed"
  | "session.completed"
  | "session.failed"
  | "error";

export interface BaseAgentEvent {
  type: AgentEventType;
  sessionId: string;
  agent?: AgentId;
  timestamp: string; // ISO
  sequence?: number;
  raw?: unknown;
  // Stable origin for deduplication when a reattached runtime replays a raw
  // line whose events were already committed before a daemon restart.
  sourceKey?: string;
}

export interface SessionStartedEvent extends BaseAgentEvent {
  type: "session.started";
  nativeSessionId?: string;
}

export interface TurnStartedEvent extends BaseAgentEvent {
  type: "turn.started";
  turnId?: string;
  prompt?: string;
}

export interface TextDeltaEvent extends BaseAgentEvent {
  type: "text.delta";
  delta: string;
  turnId?: string;
}

export interface MessageEvent extends BaseAgentEvent {
  type: "message";
  role: "assistant" | "user" | "system";
  content: string;
  turnId?: string;
}

export interface ToolStartedEvent extends BaseAgentEvent {
  type: "tool.started";
  tool: {
    name: string;
    id?: string;
    input?: unknown;
  };
}

export interface ToolCompletedEvent extends BaseAgentEvent {
  type: "tool.completed";
  tool: {
    name: string;
    id?: string;
    output?: unknown;
    success?: boolean;
    error?: string;
  };
  durationMs?: number;
}

export interface FileChangedEvent extends BaseAgentEvent {
  type: "file.changed";
  path: string;
  change: "created" | "modified" | "deleted" | "renamed";
  from?: string;
}

export interface PermissionRequestedEvent extends BaseAgentEvent {
  type: "permission.requested";
  tool?: string;
  requestId?: string;
  description?: string;
}

export interface PermissionResolvedEvent extends BaseAgentEvent {
  type: "permission.resolved";
  requestId?: string;
  approved: boolean;
}

export interface UsageUpdatedEvent extends BaseAgentEvent {
  type: "usage.updated";
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    cost?: number;
    model?: string;
  };
}

export interface TurnCompletedEvent extends BaseAgentEvent {
  type: "turn.completed";
  turnId?: string;
  reason?: string;
}

export interface SessionCompletedEvent extends BaseAgentEvent {
  type: "session.completed";
  reason?: string;
  exitCode?: number;
}

export interface SessionFailedEvent extends BaseAgentEvent {
  type: "session.failed";
  error: string;
  // Structured classification — see core/errors.ts FailureInfo. Agents branch
  // on `failure.blame` (harness crash → retry; task → fix code) instead of
  // string-matching `error`.
  failure?: FailureInfo;
  exitCode?: number;
}

export interface ErrorEvent extends BaseAgentEvent {
  type: "error";
  error: string;
}

export type AgentEvent =
  | SessionStartedEvent
  | TurnStartedEvent
  | TextDeltaEvent
  | MessageEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | FileChangedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | UsageUpdatedEvent
  | TurnCompletedEvent
  | SessionCompletedEvent
  | SessionFailedEvent
  | ErrorEvent;

export function createEvent<T extends AgentEvent>(
  base: Omit<T, "timestamp"> & { timestamp?: string },
): T {
  return {
    timestamp: new Date().toISOString(),
    ...base,
  } as T;
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "session.completed" || event.type === "session.failed";
}
