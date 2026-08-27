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
