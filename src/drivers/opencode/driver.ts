import { detectBinary } from "../helpers.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { classifyFailure } from "../../core/errors.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";


function parseOpencodeLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return []; }
  const ts = new Date().toISOString();
  const raw = obj;
  const events: AgentEvent[] = [];

  // Opencode JSON format varies; observed error shape {"type":"error","sessionID":...}
  // For success, likely {"type":"text","text":"..."} or similar; we handle generically
  if (obj.type === "error") {
    const rawError = obj.error?.data?.message || obj.error?.message || obj.message || JSON.stringify(obj.error || obj);
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

  if (obj.type === "session.created" || obj.type === "session_created") {
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId: obj.sessionID || obj.sessionId || obj.session_id || obj.id,
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "message" || obj.type === "text" || obj.type === "assistant") {
    const text = obj.text || obj.content || obj.delta || "";
    if (text) {
      const content = String(text);
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content,
        raw,
      } as AgentEvent);
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: content,
        raw,
      } as AgentEvent);
    }
    return events;
  }

  if (obj.type === "tool.use" || obj.type === "tool.started") {
    events.push({
      type: "tool.started",
      sessionId,
      timestamp: ts,
      tool: { name: obj.tool || obj.name || "tool", id: obj.id, input: obj.input },
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "tool.result" || obj.type === "tool.completed") {
    events.push({
      type: "tool.completed",
      sessionId,
      timestamp: ts,
      tool: { name: obj.tool || obj.name || "tool", id: obj.id, output: obj.output || obj.result, success: !obj.isError },
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "session.completed" || obj.type === "done") {
    events.push({
      type: "session.completed",
      sessionId,
      timestamp: ts,
      reason: "completed",
      raw,
    } as AgentEvent);
    return events;
  }

  // Generic fallback: if has sessionID and text, treat as message
  if (obj.sessionID && obj.text) {
    events.push({
      type: "message",
      sessionId,
      timestamp: ts,
      role: "assistant",
      content: String(obj.text),
      raw,
    } as AgentEvent);
    return events;
  }

  // If object contains delta
  if (obj.delta) {
    events.push({
      type: "text.delta",
      sessionId,
      timestamp: ts,
      delta: obj.delta,
      raw,
    } as AgentEvent);
    return events;
  }

  return [];
}

export class OpencodeDriver extends SessionDriver {
  readonly id = "opencode" as const;

  protected readonly hooks = createRuntimeHooks({
    parse: parseOpencodeLine,
    nativeKeys: ["sessionID", "sessionId", "session_id"],
    harness: "Opencode",
  });

  protected readonly resumeError = "No native session id for Opencode resume";

  protected buildArgs(options: StartOptions): string[] {
    const args: string[] = ["run", "--format", "json"];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    // opencode run --dir <cwd> is not standard; rely on spawn cwd.
    args.push(options.prompt);
    return args;
  }

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      fork: true,
      approvals: true,
      usage: true,
      cost: true,
      modelSelection: true,
      nativeDiff: false,
      interrupt: true,
    };
  }

  async detect(): Promise<AgentInstallation> {
    const res = await detectBinary("opencode");
    if (!res.installed) return { installed: false, error: "opencode binary not found" };
    return { installed: true, path: res.path, version: res.version, details: "opencode run --format json" };
  }
}
