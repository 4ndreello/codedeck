import type { AgentEvent } from "../../core/events.js";
import { parseClaudeLine } from "../claude/parser.js";

// Grok's `streaming-messages-json` is the Messages stream Claude already emits.
// Error results use subtypes such as `error_during_execution`, which the Claude
// parser only treats as failure when `is_error` is set or the subtype is exactly
// `error`. Force the flag, and keep a Grok-specific fallback when the line
// carries neither `result` nor `error`.
export function parseGrokLine(line: string, sessionId: string): AgentEvent[] {
  let payload = line;
  try {
    const obj = JSON.parse(line) as Record<string, unknown> | null;
    if (obj && typeof obj === "object" && isGrokErrorResult(obj)) {
      payload = JSON.stringify({ ...obj, is_error: true, error: obj.error ?? grokErrorText(obj) });
    }
  } catch {
    return [];
  }

  return parseClaudeLine(payload, sessionId).map((event) => {
    if (event.type === "session.failed" && event.error === "Claude execution failed") {
      return { ...event, error: "Grok execution failed" };
    }
    return event;
  });
}

function isGrokErrorResult(obj: Record<string, unknown>): boolean {
  return obj.type === "result" && typeof obj.subtype === "string" && obj.subtype.startsWith("error");
}

function grokErrorText(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.result === "string" && obj.result.trim()) return obj.result;
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error;
  if (!Array.isArray(obj.errors) || obj.errors.length === 0) return undefined;
  const parts = obj.errors.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "message" in item && typeof item.message === "string") {
      return item.message;
    }
    return JSON.stringify(item);
  });
  const text = parts.filter((part) => part.trim().length > 0).join("; ");
  return text.length > 0 ? text : undefined;
}
