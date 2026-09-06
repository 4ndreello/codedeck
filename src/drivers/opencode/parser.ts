import type { AgentEvent } from "../../core/events.js";
import { classifyFailure } from "../../core/errors.js";

// Parses one line of `opencode run --format json`. The harness wraps every
// event as { type, timestamp, sessionID, ...data } (opencode's run.ts emit()).
// The content of text/reasoning/tool events lives inside `part` (a message
// Part), not at the top level, and tool events use the type "tool_use", not
// "tool.completed". An earlier version guessed a flat/dotted schema and dropped
// every successful-run line, leaving the session log empty on exit 0.
export function parseOpencodeLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const ts = new Date().toISOString();
  const raw = obj;
  const events: AgentEvent[] = [];

  if (obj.type === "error") {
    const rawError =
      obj.error?.data?.message || obj.error?.message || obj.message || JSON.stringify(obj.error ?? obj);
    const error = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
    events.push({
      type: "session.failed",
      sessionId,
      timestamp: ts,
      error,
      failure: classifyFailure(error),
      raw,
    } as AgentEvent);
    return events;
  }

  // Assistant text: emit a message plus a streaming delta so the log shows the
  // content and the terminal synthesizer sees output (exit 0 with a message is
  // completion, exit 0 with none looks like a silent crash).
  if (obj.type === "text") {
    const content = typeof obj.part?.text === "string" ? obj.part.text : "";
    if (content) {
      events.push({ type: "message", sessionId, timestamp: ts, role: "assistant", content, raw } as AgentEvent);
      events.push({ type: "text.delta", sessionId, timestamp: ts, delta: content, raw } as AgentEvent);
    }
    return events;
  }

  // Reasoning is kept as a message only (no delta), matching the codex parser.
  if (obj.type === "reasoning") {
    const content = typeof obj.part?.text === "string" ? obj.part.text : "";
    if (content) {
      events.push({ type: "message", sessionId, timestamp: ts, role: "assistant", content, raw } as AgentEvent);
    }
    return events;
  }

  // opencode only emits tool_use once the tool has finished (state.status is
  // "completed" or "error"), so a single line carries both input and result.
  // Emit started (carries input) and completed (carries output/error) so
  // neither half is lost to the event shapes in core/events.ts.
  if (obj.type === "tool_use") {
    const part = obj.part ?? {};
    const state = part.state ?? {};
    const name = part.tool || "tool";
    const id = part.callID;
    events.push({
      type: "tool.started",
      sessionId,
      timestamp: ts,
      tool: { name, id, input: state.input },
      raw,
    } as AgentEvent);
    const failed = state.status === "error";
    events.push({
      type: "tool.completed",
      sessionId,
      timestamp: ts,
      tool: {
        name,
        id,
        output: state.output,
        success: !failed,
        error: failed ? state.error : undefined,
      },
      raw,
    } as AgentEvent);
    return events;
  }

  // step_start / step_finish are turn boundaries with no transcript content.
  return events;
}
