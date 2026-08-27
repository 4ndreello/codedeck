import type { AgentEvent } from "../../core/events.js";

export function parseCodexLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const ts = new Date().toISOString();
  const raw = obj;
  const events: AgentEvent[] = [];

  if (obj.type === "thread.started") {
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId: obj.thread_id,
      raw,
    } as any);
    return events;
  }

  if (obj.type === "turn.started") {
    events.push({
      type: "turn.started",
      sessionId,
      timestamp: ts,
      raw,
    } as any);
    return events;
  }

  if (obj.type === "item.started") {
    const item = obj.item;
    if (item.type === "command_execution") {
      events.push({
        type: "tool.started",
        sessionId,
        timestamp: ts,
        tool: { name: "bash", id: item.id, input: { command: item.command } },
        raw,
      } as AgentEvent);
    } else if (item.type === "file_change") {
      events.push({
        type: "file.changed",
        sessionId,
        timestamp: ts,
        path: item.path || item.file || "unknown",
        change: "modified",
        raw,
      } as AgentEvent);
    } else if (item.type === "mcp_tool_call") {
      events.push({
        type: "tool.started",
        sessionId,
        timestamp: ts,
        tool: { name: item.tool || item.server || "mcp", id: item.id, input: item.arguments },
        raw,
      } as AgentEvent);
    }
    return events;
  }

  if (obj.type === "item.completed") {
    const item = obj.item;
    if (item.type === "agent_message" && item.text) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: item.text,
        raw,
      } as AgentEvent);
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: item.text,
        raw,
      } as AgentEvent);
    } else if (item.type === "command_execution") {
      events.push({
        type: "tool.completed",
        sessionId,
        timestamp: ts,
        tool: {
          name: "bash",
          id: item.id,
          output: item.aggregated_output,
          success: item.exit_code === 0 || item.status === "completed",
          error: item.exit_code !== 0 ? `exit ${item.exit_code}` : undefined,
        },
        durationMs: undefined,
        raw,
      } as AgentEvent);
    } else if (item.type === "reasoning") {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: item.text || "",
        raw,
      } as AgentEvent);
    } else if (item.text) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: item.text,
        raw,
      } as AgentEvent);
    }
    return events;
  }

  if (obj.type === "turn.completed") {
    if (obj.usage) {
      events.push({
        type: "usage.updated",
        sessionId,
        timestamp: ts,
        usage: {
          inputTokens: obj.usage.input_tokens,
          outputTokens: obj.usage.output_tokens,
          cachedTokens: obj.usage.cached_input_tokens,
        },
        raw,
      } as AgentEvent);
    }
    if (obj.error) {
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error: typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error),
        raw,
      } as AgentEvent);
    } else if (obj.status === "failed") {
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error: obj.error || "Codex turn failed",
        raw,
      } as AgentEvent);
    }
    // Don't complete session yet; let process exit handle final
    events.push({
      type: "turn.completed",
      sessionId,
      timestamp: ts,
      reason: obj.status || "completed",
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "turn.failed" || obj.type === "error" || obj.type === "thread.failed") {
    events.push({
      type: "session.failed",
      sessionId,
      timestamp: ts,
      error: obj.error || obj.message || JSON.stringify(obj),
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "session.completed" || obj.type === "thread.completed") {
    events.push({
      type: "session.completed",
      sessionId,
      timestamp: ts,
      reason: "completed",
      raw,
    } as AgentEvent);
    return events;
  }

  return events;
}
