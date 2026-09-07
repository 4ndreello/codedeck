import type { AgentEvent } from "../../core/events.js";
import { classifyFailure } from "../../core/errors.js";

export function parseAntigravityLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }

  if (!obj || typeof obj !== "object") return [];

  const events: AgentEvent[] = [];
  const ts = new Date().toISOString();
  const raw = obj;

  // Handle generic error object
  if (obj.error && !obj.event) {
    const errText = typeof obj.error === "string" ? obj.error : obj.error.message || JSON.stringify(obj.error);
    events.push({
      type: "session.failed",
      sessionId,
      timestamp: ts,
      error: errText,
      failure: classifyFailure(errText),
      raw,
    } as AgentEvent);
    return events;
  }

  // 1. "init" event -> session.started
  if (obj.event === "init") {
    const nativeSessionId = obj.conversation_id || obj.init?.conversation_id;
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId,
      raw,
    } as any);
    return events;
  }

  // 2. "step_update" event
  if (obj.event === "step_update" && obj.step_update) {
    const update = obj.step_update;
    const nativeSessionId = update.conversation_id || obj.conversation_id;

    // Streamed assistant text delta
    if (update.step_type === "agent_response" && typeof update.text_delta === "string" && update.text_delta) {
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: update.text_delta,
        nativeSessionId,
        raw,
      } as AgentEvent);
    }

    // Tool execution: started
    if (update.step_type === "tool" && update.state === "ACTIVE") {
      events.push({
        type: "tool.started",
        sessionId,
        timestamp: ts,
        tool: {
          name: update.tool_name || update.tool_info?.name || "tool",
          id: update.tool_id || String(update.step_index ?? "tool"),
          input: update.tool_info?.parameters ?? update.parameters,
        },
        nativeSessionId,
        raw,
      } as AgentEvent);
    }

    // Tool execution: completed / error
    if (update.step_type === "tool" && (update.state === "DONE" || update.state === "ERROR")) {
      const isError = update.state === "ERROR" || Boolean(update.tool_info?.error);
      const output = update.tool_info?.output ?? update.output;
      const rawError = update.tool_info?.error || output || "Tool execution failed";
      const errorMsg = isError
        ? typeof rawError === "string"
          ? rawError
          : JSON.stringify(rawError)
        : undefined;

      events.push({
        type: "tool.completed",
        sessionId,
        timestamp: ts,
        tool: {
          name: update.tool_name || update.tool_info?.name || "tool",
          id: update.tool_id || String(update.step_index ?? "tool"),
          output,
          success: !isError,
          error: errorMsg,
        },
        nativeSessionId,
        raw,
      } as AgentEvent);
    }

    // Token usage update during step
    if (update.usage) {
      events.push({
        type: "usage.updated",
        sessionId,
        timestamp: ts,
        usage: {
          inputTokens: update.usage.input_tokens,
          outputTokens: update.usage.output_tokens,
          cachedTokens: update.usage.cache_read_tokens,
        },
        nativeSessionId,
        raw,
      } as AgentEvent);
    }

    return events;
  }

  // 3. "result" event -> message, usage.updated, session.completed / session.failed
  if (obj.event === "result" && obj.result) {
    const result = obj.result;
    const nativeSessionId = result.conversation_id || obj.conversation_id;
    const isError = result.status === "ERROR" || Boolean(result.error);

    if (isError) {
      const errText = result.error || result.response || "Antigravity execution failed";
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error: typeof errText === "string" ? errText : JSON.stringify(errText),
        failure: classifyFailure(errText),
        nativeSessionId,
        raw,
      } as AgentEvent);
      return events;
    }

    if (result.usage) {
      events.push({
        type: "usage.updated",
        sessionId,
        timestamp: ts,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cachedTokens: result.usage.cache_read_tokens,
        },
        nativeSessionId,
        raw,
      } as AgentEvent);
    }

    if (result.response && typeof result.response === "string" && result.response.trim()) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: result.response,
        nativeSessionId,
        raw,
      } as AgentEvent);
    }

    events.push({
      type: "session.completed",
      sessionId,
      timestamp: ts,
      reason: "completed",
      exitCode: 0,
      nativeSessionId,
      raw,
    } as AgentEvent);

    return events;
  }

  return [];
}
