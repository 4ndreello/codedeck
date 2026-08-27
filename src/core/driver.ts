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

export interface StartOptions {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
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
