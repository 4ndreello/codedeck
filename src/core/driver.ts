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

export interface StartOptions {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  // OpenAI "priority" service tier (1.5x speed). Codex and omp support it;
  // Claude has no equivalent flag, so its driver ignores this.
  fast?: boolean;
  worktree?: string;
  branch?: string;
  resumeSessionId?: string;
  fork?: boolean;
}

export interface DriverSession {
  id: string;
  nativeSessionId?: string;
  pid?: number;
  cwd: string;
  model?: string;
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

  events(session: DriverSession): AsyncIterable<AgentEvent>;

  // Optional cleanup
  dispose?(session: DriverSession): Promise<void>;
}

export interface DriverRegistry {
  get(agent: AgentId): AgentDriver;
  has(agent: AgentId): boolean;
  list(): AgentDriver[];
  detectAll(): Promise<Record<AgentId, AgentInstallation>>;
}
