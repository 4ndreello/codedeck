export class RunAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AgentNotInstalledError extends RunAgentError {
  constructor(agent: string) {
    super(`Agent "${agent}" is not installed`, "AGENT_NOT_INSTALLED", { agent });
  }
}

export class AgentAuthenticationRequiredError extends RunAgentError {
  constructor(agent: string) {
    super(`Agent "${agent}" requires authentication`, "AGENT_AUTH_REQUIRED", { agent });
  }
}

export class AgentStartFailedError extends RunAgentError {
  constructor(agent: string, cause?: unknown) {
    super(`Failed to start agent "${agent}"`, "AGENT_START_FAILED", { agent, cause });
  }
}

export class SessionNotFoundError extends RunAgentError {
  constructor(id: string) {
    super(`Session "${id}" not found`, "SESSION_NOT_FOUND", { id });
  }
}

export class SessionNotRunningError extends RunAgentError {
  constructor(id: string) {
    super(`Session "${id}" is not running`, "SESSION_NOT_RUNNING", { id });
  }
}

export class CapabilityNotSupportedError extends RunAgentError {
  constructor(agent: string, capability: string) {
    super(`Agent "${agent}" does not support "${capability}"`, "CAPABILITY_NOT_SUPPORTED", { agent, capability });
  }
}

export class RepositoryNotFoundError extends RunAgentError {
  constructor(cwd: string) {
    super(`No git repository found at "${cwd}"`, "REPOSITORY_NOT_FOUND", { cwd });
  }
}

export class WorktreeCreationFailedError extends RunAgentError {
  constructor(cause?: unknown) {
    super("Failed to create git worktree", "WORKTREE_CREATION_FAILED", { cause });
  }
}

export class DaemonUnavailableError extends RunAgentError {
  constructor(cause?: unknown) {
    super("CodeDeck daemon is unavailable", "DAEMON_UNAVAILABLE", { cause });
  }
}

export class ProtocolError extends RunAgentError {
  constructor(message: string, cause?: unknown) {
    super(message, "PROTOCOL_ERROR", { cause });
  }
}

// ---- Failure taxonomy -----------------------------------------------------
// Agents consume codedeck as a subprocess and decide what to do next from
// machine-readable facts, not from string-matching error text. `blame`
// separates "the harness crashed" (retry the session) from "the task's work
// failed" (fix the code) from "setup/infra broke" (fix the environment) —
// the distinction a human draws in seconds from a screenshot, serialized.

export type FailureBlame = "harness" | "task" | "infra";

export type FailureCode =
  | "HARNESS_CRASH" // harness process died (EPIPE, unhandled rejection, fatal signal)
  | "TASK_ERROR" // the agent's work failed; retrying unchanged is unlikely to help
  | "SPAWN_FAILED" // could not start the harness binary
  | "TIMEOUT"
  | "UNKNOWN";

export interface FailureInfo {
  code: FailureCode;
  blame: FailureBlame;
  retryable: boolean;
  // e.g. "unhandled_rejection", "EPIPE", "segfault"
  reason?: string;
  detail?: string;
  // e.g. "Task5Reviewer sub-agent" — where inside the harness it blew up
  where?: string;
  signal?: string;
}

// Order matters: more specific signatures first.
const HARNESS_CRASH_PATTERNS: Array<[RegExp, string]> = [
  [/epipe/i, "EPIPE"],
  [/unhandled\s+(rejection|promise)/i, "unhandled_rejection"],
  [/unhandled\s+exception/i, "unhandled_exception"],
  [/err_stream_/i, "stream_error"],
  [/segmentation fault/i, "segfault"],
  [/heap\s+out\s+of\s+memory|fatal error:/i, "v8_fatal"],
];

const FATAL_SIGNALS: Record<string, true> = { SIGSEGV: true, SIGBUS: true, SIGABRT: true, SIGILL: true, SIGKILL: true };

// Exit code 128+N is the shell convention for "died by signal N".
const SIGNAL_EXIT_CODES: Record<number, string> = {
  134: "SIGABRT",
  137: "SIGKILL",
  139: "SIGSEGV",
};

export function classifyFailure(
  text: string,
  exitCode?: number | null,
  signal?: string | null,
): FailureInfo {
  const clean = (text || "").trim();
  const detail = clean.slice(0, 300) || undefined;
  for (const [pattern, reason] of HARNESS_CRASH_PATTERNS) {
    if (pattern.test(clean)) {
      return { code: "HARNESS_CRASH", blame: "harness", retryable: true, reason, detail };
    }
  }
  if (signal && FATAL_SIGNALS[signal]) {
    return { code: "HARNESS_CRASH", blame: "harness", retryable: true, signal };
  }
  if (exitCode != null && SIGNAL_EXIT_CODES[exitCode]) {
    return { code: "HARNESS_CRASH", blame: "harness", retryable: true, signal: SIGNAL_EXIT_CODES[exitCode] };
  }
  if (exitCode != null && exitCode !== 0) {
    // Non-zero without a harness-crash signature: the honest default is
    // "the work failed" — a blind retry of the same prompt rarely differs.
    return { code: "TASK_ERROR", blame: "task", retryable: false, detail: detail || `exit code ${exitCode}` };
  }
  // No signature at all. Callers reaching this lost the stream mid-flight
  // (driver exception, socket death), which is a harness-side failure.
  return { code: "UNKNOWN", blame: "harness", retryable: true, detail };
}

// CLI exit codes for `codedeck run` (non-detach), documented in README:
// 0 completed/stopped · 1 task failed · 2 harness crashed (retryable) · 3 infra
export function exitCodeForOutcome(outcome: {
  status?: string | null;
  failure?: FailureInfo | null;
}): number {
  const status = outcome.status || "";
  if (status === "failed" || status === "orphaned") {
    const blame = outcome.failure?.blame;
    if (blame === "harness") return 2;
    if (blame === "infra") return 3;
    return 1;
  }
  return 0;
}
