import type { AgentCapabilities } from "./capabilities.js";
import type { AgentEvent } from "./events.js";
import type { AgentId } from "./session.js";

export interface AgentInstallation {
  installed: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  details?: string;
  error?: string;
}

// The three harnesses spell reasoning effort differently (codex takes a config
// override, claude takes --effort, omp takes --thinking) but agree on this set
// of levels, so drivers forward the level verbatim and only vary the flag.
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

// Validated at the CLI boundary. An unvalidated level reaches codex as a TOML
// config override and fails at spawn time -- after the session row exists, so
// the user gets a dead session instead of a usage error.
export function parseEffort(value: string): ReasoningEffort {
  if ((REASONING_EFFORTS as readonly string[]).includes(value)) return value as ReasoningEffort;
  throw new Error(`Invalid effort "${value}". Valid levels: ${REASONING_EFFORTS.join(", ")}`);
}

// Codex sandbox modes — from `codex exec --help` (-s, --sandbox).
// workspace-write is the default (allows writes inside the workspace).
// danger-full-access removes FS restrictions; read-only blocks writes.
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export const CODEX_SANDBOXES: readonly CodexSandbox[] = ["read-only", "workspace-write", "danger-full-access"];

export function parseSandbox(value: string): CodexSandbox {
  if ((CODEX_SANDBOXES as readonly string[]).includes(value)) return value as CodexSandbox;
  throw new Error(`Invalid sandbox "${value}". Valid modes: ${CODEX_SANDBOXES.join(", ")}`);
}

export interface StartOptions {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  // OpenAI "priority" service tier (1.5x speed). Codex and omp support it;
  // Claude has no equivalent flag, so its driver ignores this.
  fast?: boolean;
  // Codex sandbox policy (-s). Only the codex driver reads this; other
  // agents ignore it. Defaults to workspace-write when omitted.
  sandbox?: CodexSandbox;
  // When true, pass --dangerously-bypass-approvals-and-sandbox to codex
  // (both exec and resume). Only the codex driver reads this.
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  worktree?: string;
  branch?: string;
  resumeSessionId?: string;
  fork?: boolean;
}

export interface DriverSession {
  id: string;
  nativeSessionId?: string;
  pid?: number;
  // Linux /proc start tick captured with the PID; prevents killing/reattaching
  // an unrelated process after PID reuse.
  pidStartTime?: string;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  fast?: boolean;
  sandbox?: CodexSandbox;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  // opaque handle for driver to store process etc
  handle?: unknown;
}

export interface AgentDriver {
  readonly id: AgentId;

  detect(): Promise<AgentInstallation>;

  capabilities(): AgentCapabilities;

  start(options: StartOptions): Promise<DriverSession>;

  send(session: DriverSession, message: string): Promise<void>;

  stop(session: DriverSession): Promise<void>;

  resume?(session: DriverSession, message?: string): Promise<void>;

  // Rebuild the event feed for a session whose detached process outlived a
  // daemon restart: resume tailing the session's log files from the
  // persisted offsets. MUST NOT spawn anything — the process is already
  // running (or already dead, in which case the driver drains and
  // classifies the death from the logs).
  attach?(session: ReattachRequest): Promise<void>;

  // Byte offsets of the last fully consumed line in the session's log
  // files, persisted by the daemon so reattach does not replay events that
  // are already in the store.
  getOffsets?(sessionId: string): { log: number; stderr: number } | undefined;

  // Internal lifecycle handle; daemon uses it to distinguish a verified
  // in-memory process from a PID-only fallback after restart.
  getHandle?(sessionId: string): unknown;

  events(session: DriverSession): AsyncIterable<AgentEvent>;

  // Optional cleanup
  dispose?(session: DriverSession): Promise<void>;
}
export interface ReattachRequest {
  sessionId: string;
  pid?: number;
  pidStartTime?: string;
  nativeSessionId?: string;
  // Persisted byte offsets into the session's log files (drivers/tailer.ts).
  logOffset?: number;
  stderrOffset?: number;
}

export interface DriverRegistry {
  get(agent: AgentId): AgentDriver;
  has(agent: AgentId): boolean;
  list(): AgentDriver[];
  detectAll(): Promise<Record<AgentId, AgentInstallation>>;
}
