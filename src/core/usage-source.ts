import type { Session } from "./session.js";

export function workerSourceKey(
  session: Pick<Session, "id" | "agent" | "nativeSessionId">,
  processOrdinal: number,
): string | undefined {
  switch (session.agent) {
    case "claude":
      return `claude:${session.nativeSessionId ?? session.id}#${processOrdinal}`;
    case "codex":
      return `codex:${session.nativeSessionId ?? session.id}`;
    case "antigravity":
    case "omp":
      return `session:${session.id}`;
    case "opencode":
      break;
  }
}

export function openSourceKey(nativeId: string): string {
  return `claude-open:${nativeId}`;
}
