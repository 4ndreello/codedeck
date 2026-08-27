import { detectBinary, safeJsonParse } from "../helpers.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession, ReattachRequest } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { classifyFailure } from "../../core/errors.js";
import { SessionRuntime, nativeIdFrom, type RuntimeHooks } from "../session-runtime.js";
import { synthesizeTerminalEvent } from "../terminal.js";
import { killTree } from "../../utils/process.js";
export function parseOmpLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return []; }
  const ts = new Date().toISOString();
  const raw = obj;
  const events: AgentEvent[] = [];

  // OMP RPC mode emits JSON objects with type field
  // Observed rpc mode may emit {"type":"text","text":"..."} etc.
  // Handle generic
  if (obj.error) {
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

  // `--mode json` opens with {"type":"session","version":3,"id":"<uuid>",...};
  // `id` is the native session id `--resume` needs, so send/resume depends on
  // this frame being recognised.
  if (obj.type === "session.started" || obj.type === "session_created" || obj.type === "session") {
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId: obj.session_id || obj.sessionID || obj.id,
      raw,
    } as any);
    return events;
  }

  // ---- omp `--mode json` frames -------------------------------------------
  // Streamed assistant text arrives nested, not as a top-level frame:
  //   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"OK"}}
  if (obj.type === "message_update" && obj.assistantMessageEvent) {
    const inner = obj.assistantMessageEvent;
    if (inner.type === "text_delta" && inner.delta) {
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: String(inner.delta),
        raw,
      } as AgentEvent);
    }
    return events;
  }

  // Completed assistant message. `content` is an array of parts and only the
  // `text` ones are the answer — `thinking` parts carry an encrypted blob that
  // must never be surfaced as message content.
  if (obj.type === "message_end" && obj.message?.role === "assistant") {
    const text = (Array.isArray(obj.message.content) ? obj.message.content : [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (text) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: text,
        raw,
      } as AgentEvent);
    }
    return events;
  }

  if (obj.type === "tool_execution_start") {
    events.push({
      type: "tool.started",
      sessionId,
      timestamp: ts,
      tool: { name: obj.toolName || "tool", id: obj.toolCallId, input: obj.args },
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "tool_execution_end") {
    events.push({
      type: "tool.completed",
      sessionId,
      timestamp: ts,
      tool: {
        name: obj.toolName || "tool",
        id: obj.toolCallId,
        output: obj.result,
        success: !obj.isError,
      },
      raw,
    } as AgentEvent);
    return events;
  }

  // Terminal frame of a print-mode run. Without this the driver only ever got a
  // synthesised completion from the process `close` handler.
  if (obj.type === "agent_end") {
    events.push({
      type: "session.completed",
      sessionId,
      timestamp: ts,
      reason: "agent_end",
      raw,
    } as AgentEvent);
    return events;
  }
  // -------------------------------------------------------------------------

  if (obj.type === "assistant" || obj.type === "message") {
    const content = obj.content || obj.text || obj.delta || "";
    if (content) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: String(content),
        raw,
      } as AgentEvent);
    }
    return events;
  }

  if (obj.type === "text_delta" || obj.type === "text.delta") {
    events.push({
      type: "text.delta",
      sessionId,
      timestamp: ts,
      delta: String(obj.delta || obj.text || ""),
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "tool.started" || obj.type === "tool_use") {
    events.push({
      type: "tool.started",
      sessionId,
      timestamp: ts,
      tool: { name: obj.name || obj.tool || "tool", id: obj.id, input: obj.input },
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "tool.completed" || obj.type === "tool_result") {
    events.push({
      type: "tool.completed",
      sessionId,
      timestamp: ts,
      tool: { name: obj.name || "tool", id: obj.id, output: obj.output, success: !obj.is_error },
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "usage" || obj.type === "usage.updated") {
    events.push({
      type: "usage.updated",
      sessionId,
      timestamp: ts,
      usage: {
        inputTokens: obj.input_tokens || obj.inputTokens,
        outputTokens: obj.output_tokens || obj.outputTokens,
        cost: obj.cost,
      },
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "session.completed" || obj.type === "done" || obj.type === "result") {
    const isError = obj.is_error || obj.error;
    if (isError) {
      const rawErr = obj.error || obj.result || "OMP failed";
      const errText = typeof rawErr === "string" ? rawErr : JSON.stringify(rawErr);
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error: errText,
        failure: classifyFailure(errText),
        raw,
      } as AgentEvent);
    } else {
      if (obj.result && typeof obj.result === "string") {
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
        reason: "completed",
        raw,
      } as AgentEvent);
    }
    return events;
  }

  // If raw contains text field and session
  if (obj.text && typeof obj.text === "string") {
    events.push({
      type: "message",
      sessionId,
      timestamp: ts,
      role: "assistant",
      content: obj.text,
      raw,
    } as AgentEvent);
    return events;
  }

  // Unknown: try to treat method field for JSON-RPC
  if (obj.method) {
    // JSON-RPC notification? Example: {"jsonrpc":"2.0","method":"display","params":{...}}
    if (obj.params?.text) {
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: String(obj.params.text),
        raw,
      } as AgentEvent);
    }
    return events;
  }

  return [];
}

// Pure so the flag spellings are testable without spawning omp.
export function buildOmpArgs(options: StartOptions): string[] {
  const args: string[] = [];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  args.push("-p", "--mode", "json");
  if (options.model) args.push("--model", options.model);
  // omp calls reasoning "thinking" and accepts a wider set of levels than the
  // shared type (off/minimal/auto), but the shared levels map straight through.
  if (options.effort) args.push("--thinking", options.effort);
  if (options.fast) args.push("--service-tier", "priority");
  args.push(options.prompt);
  return args;
}


export class OmpDriver implements AgentDriver {
  readonly id = "omp" as const;
  private handles = new Map<string, SessionRuntime>();

  private readonly hooks: RuntimeHooks = {
    onLine: (line, { sessionId, push, setNativeId, isStderr }) => {
      if (isStderr) return; // omp stderr is diagnostic; the runtime keeps it for classification
      const obj = safeJsonParse(line);
      const parsedEvents = parseOmpLine(line, sessionId);
      for (const ev of parsedEvents) {
        const native =
          ev.type === "session.started" && ev.nativeSessionId
            ? ev.nativeSessionId
            : nativeIdFrom(ev.raw, ["session_id", "sessionID"]);
        if (native) setNativeId(native);
        push(ev);
      }
      // Preserve the driver's old behavior for diagnostics/plain output that
      // is not JSON; only the parser itself intentionally returns no event.
      if (parsedEvents.length === 0 && line.trim() && obj === null && line.trim() !== "null") {
        push({
          type: "text.delta",
          sessionId,
          timestamp: new Date().toISOString(),
          delta: `${line}\n`,
          raw: line,
        });
      }
      const native = nativeIdFrom(obj, ["session_id", "sessionID"]);
      if (native) setNativeId(native);
    },
    synthesizeTerminal: (ctx) => {
      const ev = synthesizeTerminalEvent({ ...ctx, harness: "OMP" });
      return ev ? [ev] : [];
    },
  };

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      fork: false,
      approvals: true,
      usage: true,
      cost: true,
      modelSelection: true,
      nativeDiff: false,
      interrupt: true,
    };
  }

  async detect(): Promise<AgentInstallation> {
    const res = await detectBinary("omp");
    if (!res.installed) {
      // Also try pi binary? OMP may be installed as pi?
      const res2 = await detectBinary("pi");
      if (!res2.installed) return { installed: false, error: "omp/pi binary not found" };
      return { installed: true, path: res2.path, version: res2.version, details: "omp via pi binary" };
    }
    return { installed: true, path: res.path, version: res.version, details: "omp -p --mode json" };
  }

  async start(options: StartOptions): Promise<DriverSession> {
    // `--mode` picks the OUTPUT format: text (default), json, rpc, rpc-ui.
    // `rpc` is the interactive protocol SERVER — it prints a handshake and then
    // waits for request frames on stdin. Driving it with `-p <prompt>` never
    // runs a turn: measured against omp 18.0.7, `omp --mode rpc -p "..."` emits
    // only `ready` / `available_commands_update` and exits 0 in under a second,
    // with zero assistant frames. That is what made every OMP session here
    // complete instantly and empty.
    //
    // `-p/--print` is a BOOLEAN flag ("process prompt and exit") and the prompt
    // is POSITIONAL (`MESSAGES` in `omp --help`), so it must not be passed as
    // `-p <prompt>`. The non-interactive NDJSON stream this driver parses is
    // `--mode json`.
    const args = buildOmpArgs(options);

    // The runtime spawns omp DETACHED with stdout/stderr in the session's log
    // files (see helpers.spawnDetached): the process outlives daemon restarts
    // and its output can always be re-tailed from a persisted offset.
    const runtime = SessionRuntime.spawn({
      sessionId: options.sessionId,
      cmd: "omp",
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

  // Daemon-restart path: the detached omp process kept running (or already
  // died) while no daemon existed. Resume tailing its log files — spawn nothing.
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
    if (!nativeId) throw new Error("No native session id for OMP resume");
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
