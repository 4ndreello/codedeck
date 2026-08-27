import type { AgentId, Session } from "../core/session.js";
import type { ReasoningEffort } from "../core/driver.js";
import type { AgentEvent } from "../core/events.js";

export type RequestMethod =
  | "session.create"
  | "session.list"
  | "session.get"
  | "session.send"
  | "session.stop"
  | "session.logs"
  | "session.diff"
  | "session.subscribe"
  | "daemon.status"
  | "daemon.stop"
  | "doctor";

export interface RunOptions {
  prompt: string;
  agent?: AgentId;
  model?: string;
  effort?: ReasoningEffort;
  fast?: boolean;
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

export interface ListSessionsRequest {
  method: "session.list";
  params: { all?: boolean; json?: boolean };
}

export interface GetSessionRequest {
  method: "session.get";
  params: { id: string };
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

export interface DaemonStatusRequest {
  method: "daemon.status";
  params: Record<string, never>;
}

export type RequestParams =
  | CreateSessionRequest
  | ListSessionsRequest
  | GetSessionRequest
  | SendSessionRequest
  | StopSessionRequest
  | LogsSessionRequest
  | DiffSessionRequest
  | SubscribeSessionRequest
  | DaemonStatusRequest;

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

export interface SessionListResult {
  sessions: Session[];
}

export interface DoctorResult {
  node: { version: string };
  git: { installed: boolean; version?: string };
  agents: Record<string, { installed: boolean; version?: string; authenticated?: boolean; details?: string; error?: string; capabilities?: unknown }>;
  daemon: { running: boolean; pid?: number; uptime?: number };
  database: { path: string; exists: boolean };
}
