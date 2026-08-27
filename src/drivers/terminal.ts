import type { AgentEvent } from "../core/events.js";
import { classifyFailure } from "../core/errors.js";

// Pure so the exit-handler decision is testable without spawning a harness.
// When a harness dies it often does so WITHOUT emitting a terminal frame —
// the EPIPE/signal class of crash. This decides what the driver reports
// instead. A ghost "completed" is the one outcome it refuses to produce: an
// agent that sees completed proceeds on missing work, while a false "failed"
// only costs one retry of a retryable session.
export function synthesizeTerminalEvent(input: {
  sessionId: string;
  harness: string;
  exitCode: number | null;
  signal?: string | null;
  hasTerminal: boolean;
  hasMessage: boolean;
  stderr: string;
}): AgentEvent | null {
  if (input.hasTerminal) return null;
  const ts = new Date().toISOString();
  if (input.exitCode === 0) {
    // Exit 0 with produced output is completion. Exit 0 with NO output but
    // stderr content is how "exit 0 anyway" crashes look — treat as failure.
    if (!input.hasMessage && input.stderr.trim()) {
      return {
        type: "session.failed",
        sessionId: input.sessionId,
        timestamp: ts,
        error: input.stderr.slice(0, 2000),
        exitCode: 0,
        failure: classifyFailure(input.stderr, 0, input.signal ?? null),
        raw: { stderr: input.stderr.slice(0, 2000) },
      } as AgentEvent;
    }
    return {
      type: "session.completed",
      sessionId: input.sessionId,
      timestamp: ts,
      reason: "exit 0",
      exitCode: 0,
      raw: { stderr: input.stderr.slice(0, 2000) },
    } as AgentEvent;
  }
  // exitCode null (signal death, or daemon was restarted and only learned of
  // the death by polling the pid): there is no exit code to report — say so
  // instead of inventing one.
  const errorText = input.stderr.trim()
    ? input.stderr.slice(0, 2000)
    : input.exitCode != null
      ? `${input.harness} exited with code ${input.exitCode}`
      : `${input.harness} exited without reporting a terminal event`;
  return {
    type: "session.failed",
    sessionId: input.sessionId,
    timestamp: ts,
    error: errorText,
    exitCode: input.exitCode ?? 1,
    failure: classifyFailure(input.stderr, input.exitCode, input.signal ?? null),
    raw: { stderr: input.stderr.slice(0, 2000) },
  } as AgentEvent;
}
