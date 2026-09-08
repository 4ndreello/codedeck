import type { CodexSandbox, ReasoningEffort } from "./driver.js";
import type { FailureInfo } from "./errors.js";
export const AGENT_IDS = ["claude", "codex", "opencode", "omp", "antigravity"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function normalizeAgentId(value: unknown): AgentId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "agy") return "antigravity";
  return isAgentId(normalized) ? normalized : undefined;
}

/** Narrows a string read off disk or off a flag to a harness CodeDeck drives. */
export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export type SessionStatus =
  | "starting"
  | "working"
  | "needs_input"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "orphaned"
  | "interrupted";

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cost?: number;
}

export interface Session {
  id: string;
  runId?: string | null;
  origin?: "open" | "run" | string | null;
  name?: string;
  agent: AgentId;
  nativeSessionId?: string;
  model?: string;
  // Reasoning level and OpenAI priority tier the session was started with.
  // Persisted so send() rebuilds the next turn with the same settings.
  effort?: ReasoningEffort;
  fast?: boolean;
  // Codex sandbox selected at creation time. Persisted so the session
  // row records how the harness was launched; resume keeps the original
  // thread's policy (codex exec resume has no -s flag).
  sandbox?: CodexSandbox;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  status: SessionStatus;
  repository?: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  pid?: number;
  // Monotonic process start identity paired with pid; used to reject PID reuse.
  pidStartTime?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  usage?: SessionUsage;
  lastEvent?: string;
  failure?: FailureInfo;
  // One-slot send queue: message waiting for the next turn, set by
  // session.send while busy (last-wins), cleared on dispatch/stop/release.
  pendingMessage?: string | null;
  pendingAt?: string | null;
  // Byte offsets into the session's log files (see drivers/tailer.ts) after
  // the last fully persisted line, so a reattaching daemon does not replay
  // events already in the store.
  logOffset?: number;
  stderrOffset?: number;
}

export interface CreateSessionOptions {
  agent: AgentId;
  prompt: string;
  cwd: string;
  runId?: string | null;
  model?: string;
  name?: string;
  worktree?: boolean;
  noWorktree?: boolean;
  detach?: boolean;
}

export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "orphaned" || status === "interrupted";
}

export function isActiveStatus(status: SessionStatus): boolean {
  return status === "starting" || status === "working" || status === "needs_input" || status === "idle";
}

// Display-level liveness shared by `ps` and the daemon read boundary: an
// active session whose recorded process is gone is a corpse ("dead"), never
// "working". Pure (liveness injected) so it is unit-testable; the stored
// row is never mutated, only the served view.
export type LiveSessionStatus = SessionStatus | "dead";
export function liveStatus(
  status: SessionStatus,
  pid: number | null | undefined,
  alive: boolean,
): LiveSessionStatus {
  if (isActiveStatus(status) && pid != null && !alive) return "dead";
  return status;
}

export function generateSessionId(): string {
  // 4-char hex like spec (a83f) but ensure uniqueness with 8 chars if needed
  // Use 8 hex chars, display first 4 but store full
  const bytes = new Uint8Array(4);
  // Node crypto
  // Use simple random for now; crypto available globally
  try {
    // @ts-ignore
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) throw new Error("zero");
  } catch {
    for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 4);
}

export function generateBranchName(slug: string, sessionId: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "task";
  return `ra/${clean}-${sessionId}`;
}
