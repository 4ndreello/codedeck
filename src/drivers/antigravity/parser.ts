import type { AgentEvent } from "../../core/events.js";
import { classifyFailure } from "../../core/errors.js";

// Keep fallback reconstruction bounded while retaining ordinary long answers.
const MAX_ACCUMULATED_RESPONSE_CHARS = 8 * 1024 * 1024;

interface ResponseAccumulator {
  chunks: string[];
  firstChunk: number;
  length: number;
  truncatedChars: number;
  nextCompactionAt: number;
}

export type AntigravityParser = ((line: string, sessionId: string) => AgentEvent[]) & {
  reset: (sessionId: string) => void;
};

export function parseAntigravityLine(line: string, sessionId: string): AgentEvent[] {
  return parseAntigravityLineWithState(line, sessionId);
}

// A result line can omit response text after streaming it through step_update
// lines. Keep this state per parser instance so separate runtimes cannot mix
// their transcripts while the stateless export remains useful in tests.
export function createAntigravityParser(): AntigravityParser {
  const responseBySession = new Map<string, ResponseAccumulator>();
  const parse: AntigravityParser = (line, sessionId) =>
    parseAntigravityLineWithState(line, sessionId, responseBySession);
  parse.reset = (sessionId) => responseBySession.delete(sessionId);
  return parse;
}

function parseAntigravityLineWithState(
  line: string,
  sessionId: string,
  responseBySession?: Map<string, ResponseAccumulator>,
): AgentEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    if (responseBySession && line.trim()) {
      const delta = `${line}\n`;
      appendResponseText(responseBySession, sessionId, delta);
      return [{
        type: "text.delta",
        sessionId,
        timestamp: new Date().toISOString(),
        delta,
        raw: line,
      } as AgentEvent];
    }
    return [];
  }

  if (!obj || typeof obj !== "object") return [];

  const events: AgentEvent[] = [];
  const ts = new Date().toISOString();
  const raw = obj;

  // Handle generic error object
  if (obj.error && !obj.event) {
    responseBySession?.delete(sessionId);
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
    responseBySession?.delete(sessionId);
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
      if (responseBySession) {
        appendResponseText(responseBySession, sessionId, update.text_delta);
      }
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
      responseBySession?.delete(sessionId);
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

    const response = typeof result.response === "string" ? result.response : "";
    const accumulator = responseBySession?.get(sessionId);
    const accumulatedContent = !response.trim() && accumulator ? accumulatedResponseContent(accumulator) : "";
    const content = response.trim()
      ? response
      : accumulatedContent.trim() && accumulator
        ? accumulatedResponseText(accumulator, accumulatedContent)
        : "";

    if (content.trim()) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content,
        nativeSessionId,
        raw,
      } as AgentEvent);
    } else {
      const error = accumulator
        ? "Antigravity returned an empty or whitespace-only response with no usable text deltas"
        : "Antigravity returned an empty or whitespace-only response with no text deltas";
      responseBySession?.delete(sessionId);
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error,
        failure: classifyFailure(error),
        nativeSessionId,
        raw,
      } as AgentEvent);
      return events;
    }

    responseBySession?.delete(sessionId);
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

function appendResponseText(
  responseBySession: Map<string, ResponseAccumulator>,
  sessionId: string,
  delta: string,
): void {
  const accumulator = responseBySession.get(sessionId) ?? {
    chunks: [],
    firstChunk: 0,
    length: 0,
    truncatedChars: 0,
    nextCompactionAt: 1024,
  };
  accumulator.chunks.push(delta);
  accumulator.length += delta.length;

  while (accumulator.length > MAX_ACCUMULATED_RESPONSE_CHARS) {
    const first = accumulator.chunks[accumulator.firstChunk]!;
    let remove = Math.min(first.length, accumulator.length - MAX_ACCUMULATED_RESPONSE_CHARS);
    if (remove === first.length) {
      accumulator.firstChunk += 1;
    } else {
      accumulator.chunks[accumulator.firstChunk] = first.slice(remove);
    }
    accumulator.length -= remove;
    accumulator.truncatedChars += remove;
  }

  const first = accumulator.chunks[accumulator.firstChunk];
  if (first && first.charCodeAt(0) >= 0xdc00 && first.charCodeAt(0) <= 0xdfff) {
    accumulator.chunks[accumulator.firstChunk] = first.slice(1);
    accumulator.length -= 1;
    accumulator.truncatedChars += 1;
  }

  // Avoid retaining references to every discarded delta. Compaction is
  // amortized so append remains linear even after the cap is reached.
  if (accumulator.firstChunk > 1024 && accumulator.firstChunk * 2 >= accumulator.chunks.length) {
    accumulator.chunks = accumulator.chunks.slice(accumulator.firstChunk);
    accumulator.firstChunk = 0;
  }
  const liveChunks = accumulator.chunks.length - accumulator.firstChunk;
  if (liveChunks >= accumulator.nextCompactionAt) {
    accumulator.chunks = [accumulator.chunks.slice(accumulator.firstChunk).join("")];
    accumulator.firstChunk = 0;
    accumulator.nextCompactionAt = Math.max(accumulator.nextCompactionAt * 2, liveChunks * 2);
  }
  responseBySession.set(sessionId, accumulator);
}

function accumulatedResponseText(accumulator: ResponseAccumulator, text: string): string {
  return accumulator.truncatedChars > 0
    ? `[truncated ${accumulator.truncatedChars} characters]\n${text}`
    : text;
}

function accumulatedResponseContent(accumulator: ResponseAccumulator): string {
  return accumulator.chunks.slice(accumulator.firstChunk).join("");
}
