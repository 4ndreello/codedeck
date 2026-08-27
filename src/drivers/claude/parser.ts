import type { AgentEvent } from "../../core/events.js";

export function parseClaudeLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const events: AgentEvent[] = [];
  const ts = obj.timestamp ? new Date(obj.timestamp).toISOString() : new Date().toISOString();
  const raw = obj;

  // system.init
  if (obj.type === "system" && obj.subtype === "init") {
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId: obj.session_id,
      raw,
    } as any);
    if (obj.model) {
      events.push({
        type: "usage.updated",
        sessionId,
        timestamp: ts,
        usage: { model: obj.model },
        raw,
      } as any);
    }
    return events;
  }

  // assistant message
  if (obj.type === "assistant" && obj.message) {
    const msg = obj.message;
    const content = msg.content;
    let text = "";
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) text += block.text;
        if (block.type === "tool_use") {
          events.push({
            type: "tool.started",
            sessionId,
            timestamp: ts,
            tool: { name: block.name, id: block.id, input: block.input },
            raw,
          } as AgentEvent);
        }
      }
    }
    if (text) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: text,
        raw,
      } as AgentEvent);
      // also emit text.delta for compatibility
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: text,
        raw,
      } as AgentEvent);
    }
    // tool results may be in separate message? but handle
    return events;
  }

  // tool result (user message with tool_result)
  if (obj.type === "user" && obj.message?.content) {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool.completed",
            sessionId,
            timestamp: ts,
            tool: { name: block.tool_use_id || "tool", id: block.tool_use_id, output: block.content, success: !block.is_error, error: block.is_error ? String(block.content) : undefined },
            raw,
          } as AgentEvent);
        }
      }
    }
    return events;
  }

  // result - final
  if (obj.type === "result") {
    const isError = obj.is_error || obj.subtype === "error" || obj.subtype === "failure";
    if (isError) {
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error: obj.result || obj.error || "Claude execution failed",
        exitCode: obj.exit_code,
        raw,
      } as AgentEvent);
    } else {
      // usage
      if (obj.usage) {
        events.push({
          type: "usage.updated",
          sessionId,
          timestamp: ts,
          usage: {
            inputTokens: obj.usage.input_tokens,
            outputTokens: obj.usage.output_tokens,
            cachedTokens: obj.usage.cache_read_input_tokens ?? obj.usage.cache_creation_input_tokens,
            cost: obj.total_cost_usd,
            model: obj.modelUsage ? Object.keys(obj.modelUsage)[0] : undefined,
          },
          raw,
        } as AgentEvent);
      } else if (obj.total_cost_usd != null) {
        events.push({
          type: "usage.updated",
          sessionId,
          timestamp: ts,
          usage: { cost: obj.total_cost_usd },
          raw,
        } as AgentEvent);
      }
      // final message if result text exists
      if (obj.result && typeof obj.result === "string" && obj.result.trim()) {
        events.push({
          type: "message",
          sessionId,
          timestamp: ts,
          role: "assistant",
          content: obj.result,
          raw,
        } as AgentEvent);
      }
      events.push({
        type: "session.completed",
        sessionId,
        timestamp: ts,
        reason: obj.subtype || "completed",
        exitCode: 0,
        raw,
      } as AgentEvent);
    }
    return events;
  }

  // stream events for errors?
  if (obj.type === "error") {
    events.push({
      type: "error",
      sessionId,
      timestamp: ts,
      error: obj.error || obj.message || JSON.stringify(obj),
      raw,
    } as AgentEvent);
    return events;
  }

  // system hook etc - ignore but keep raw? we can emit generic
  // Don't emit for hook_started etc to reduce noise
  if (obj.type === "system" && obj.subtype?.startsWith("hook_")) {
    return [];
  }

  // For unhandled, try to extract text if exists
  if (obj.type === "stream_event" && obj.event) {
    // e.g., stream_event with delta
    const ev = obj.event;
    if (ev.type === "content_block_delta" && ev.delta?.text) {
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: ev.delta.text,
        raw,
      } as AgentEvent);
    }
  }

  return events;
}
