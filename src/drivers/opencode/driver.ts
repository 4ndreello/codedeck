import { detectBinary, safeJsonParse } from "../helpers.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession, ReattachRequest } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { SessionRuntime, nativeIdFrom, type RuntimeHooks } from "../session-runtime.js";
import { synthesizeTerminalEvent } from "../terminal.js";
import { killTree } from "../../utils/process.js";
import { classifyFailure } from "../../core/errors.js";

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

export class OpencodeDriver implements AgentDriver {
  readonly id = "opencode" as const;
  private handles = new Map<string, SessionRuntime>();

  private readonly hooks: RuntimeHooks = {
    onLine: (line, { sessionId, push, setNativeId, isStderr }) => {
      if (isStderr) return; // opencode stderr is diagnostic; the runtime keeps it for classification
      for (const ev of parseOpencodeLine(line, sessionId)) {
        const native =
          ev.type === "session.started" && ev.nativeSessionId
            ? ev.nativeSessionId
            : nativeIdFrom(ev.raw, ["sessionID", "sessionId", "session_id"]);
        if (native) setNativeId(native);
        push(ev);
      }
      const native = nativeIdFrom(safeJsonParse(line), ["sessionID", "sessionId", "session_id"]);
      if (native) setNativeId(native);
    },
    synthesizeTerminal: (ctx) => {
      const ev = synthesizeTerminalEvent({ ...ctx, harness: "Opencode" });
      return ev ? [ev] : [];
    },
  };

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

  async start(options: StartOptions): Promise<DriverSession> {
    const args: string[] = ["run", "--format", "json"];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    // opencode run --dir <cwd> is not standard; rely on spawn cwd.
    args.push(options.prompt);

    // The runtime spawns opencode DETACHED with stdout/stderr in the session's
    // log files (see helpers.spawnDetached): the process outlives daemon
    // restarts and its output can always be re-tailed from a persisted offset.
    const runtime = SessionRuntime.spawn({
      sessionId: options.sessionId,
      cmd: "opencode",
      args,
      cwd: options.cwd,
      nativeSessionId: options.resumeSessionId,
      hooks: this.hooks,
    });
    this.handles.set(options.sessionId, runtime);

    return {
      id: options.sessionId,
      nativeSessionId: runtime.nativeSessionId,
      pid: runtime.pid,
      cwd: options.cwd,
      model: options.model,
      handle: runtime,
    };
  }

  // Daemon-restart path: the detached opencode process kept running (or
  // already died) while no daemon existed. Resume tailing its log files —
  // spawn nothing.
  async attach(req: ReattachRequest): Promise<void> {
    if (!req.pid) return;
    const runtime = SessionRuntime.reattach({
      sessionId: req.sessionId,
      pid: req.pid,
      pidStartTime: req.pidStartTime,
      nativeSessionId: req.nativeSessionId,
      logOffset: req.logOffset,
      stderrOffset: req.stderrOffset,
      hooks: this.hooks,
    });
    this.handles.set(req.sessionId, runtime);
  }

  async send(session: DriverSession, message: string): Promise<void> {
    const runtime = this.handles.get(session.id);
    const nativeId = session.nativeSessionId || runtime?.nativeSessionId;
    if (!nativeId) throw new Error("No native session id for Opencode resume");
    const newSession = await this.start({
      sessionId: session.id,
      prompt: message,
      cwd: session.cwd,
      model: session.model,
      resumeSessionId: nativeId,
    });
    session.pid = newSession.pid;
    session.handle = newSession.handle;
  }

  async stop(session: DriverSession): Promise<void> {
    // Works across daemon restarts: falls back to the pid persisted in the
    const runtime = this.handles.get(session.id);
    if (runtime) {
      await runtime.stop();
      return;
    }
    if (!session.pid) return;
    if (!session.pidStartTime) throw new Error(`Cannot safely stop session ${session.id}: PID identity is unavailable`);
    await killTree(session.pid, 3000, session.pidStartTime);
  }

  async *events(session: DriverSession): AsyncIterable<AgentEvent> {
    const runtime = this.handles.get(session.id);
    if (!runtime) return;
    yield* runtime.events();
  }

  getHandle(sessionId: string): SessionRuntime | undefined {
    return this.handles.get(sessionId);
  }

  getOffsets(sessionId: string): { log: number; stderr: number } | undefined {
    return this.handles.get(sessionId)?.offsets;
  }
}
