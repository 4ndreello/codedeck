export type AgentId = "claude" | "codex" | "opencode" | "omp";

export type SessionStatus =
  | "starting"
  | "working"
  | "needs_input"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "orphaned";

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cost?: number;
}

export interface Session {
  id: string;
  name?: string;
  agent: AgentId;
  nativeSessionId?: string;
  model?: string;
  status: SessionStatus;
  repository?: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  baseCommit?: string;
  pid?: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  usage?: SessionUsage;
  lastEvent?: string;
}

export interface CreateSessionOptions {
  agent: AgentId;
  prompt: string;
  cwd: string;
  model?: string;
  name?: string;
  worktree?: boolean;
  noWorktree?: boolean;
  detach?: boolean;
}

export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "orphaned";
}

export function isActiveStatus(status: SessionStatus): boolean {
  return status === "starting" || status === "working" || status === "needs_input" || status === "idle";
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
