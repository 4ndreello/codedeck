import { spawn, type ChildProcess } from "node:child_process";
import { detectBinary, createLineReader } from "../helpers.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { EventEmitter } from "node:events";
import { classifyFailure, type FailureInfo } from "../../core/errors.js";

interface OmpHandle {
  proc: ChildProcess;
  emitter: EventEmitter;
  buffer: AgentEvent[];
  done: boolean;
  exitCode: number | null;
  nativeSessionId?: string;
}

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

// Pure so the close-handler decision is testable without spawning omp. When
// omp dies it often does so WITHOUT emitting a terminal frame — the EPIPE
// class of crash. This decides what the driver reports instead. A ghost
// "completed" is the one outcome it refuses to produce: an agent that sees
// completed proceeds on missing work, while a false "failed" only costs one
// retry of a retryable session.
export function synthesizeTerminalEvent(input: {
  sessionId: string;
  exitCode: number | null;
  signal?: string | null;
  hasTerminal: boolean;
  hasMessage: boolean;
  stderr: string;
}): AgentEvent | null {
  if (input.hasTerminal) return null;
  const ts = new Date().toISOString();
  if (input.exitCode === 0) {
    // Exit 0 with produced output is completion. Exit 0 with NO output but
    // stderr content is how "exit 0 anyway" crashes look — treat as failure.
    if (!input.hasMessage && input.stderr.trim()) {
      return {
        type: "session.failed",
        sessionId: input.sessionId,
        timestamp: ts,
        error: input.stderr.slice(0, 2000),
        exitCode: 0,
        failure: classifyFailure(input.stderr, 0, input.signal ?? null),
        raw: { stderr: input.stderr.slice(0, 2000) },
      } as AgentEvent;
    }
    return {
      type: "session.completed",
      sessionId: input.sessionId,
      timestamp: ts,
      reason: "exit 0",
      exitCode: 0,
      raw: { stderr: input.stderr.slice(0, 2000) },
    } as AgentEvent;
  }
  const errorText = input.stderr.trim() ? input.stderr.slice(0, 2000) : `OMP exited with code ${input.exitCode}`;
  return {
    type: "session.failed",
    sessionId: input.sessionId,
    timestamp: ts,
    error: errorText,
    exitCode: input.exitCode ?? 1,
    failure: classifyFailure(input.stderr, input.exitCode, input.signal ?? null),
    raw: { stderr: input.stderr.slice(0, 2000) },
  } as AgentEvent;
}

export class OmpDriver implements AgentDriver {
  readonly id = "omp" as const;
  private handles = new Map<string, OmpHandle>();

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

    // stdin is ignored rather than an immediately-closed pipe. A closed pipe
    // does work (omp falls back to the positional prompt on EOF), but an OPEN
    // one does not: omp waits for EOF that never comes and hangs indefinitely.
    // `ignore` removes that failure mode instead of depending on stdin.end().
    const proc = spawn("omp", args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const emitter = new EventEmitter();
    const buffer: AgentEvent[] = [];

    // The handle is built HERE, before the handlers, and mutated in place. It
    // used to be constructed at the END of start() out of local `done` /
    // `exitCode` / `nativeId` variables — which copies them BY VALUE. The close
    // handler flipped the locals while `handle.done` stayed false forever, so
    // events() never left its wait loop (an omp session hung after the process
    // had already exited), and `handle.nativeSessionId` stayed undefined, so
    // send() could never resume.
    const handle: OmpHandle = {
      proc,
      emitter,
      buffer,
      done: false,
      exitCode: null,
      nativeSessionId: options.resumeSessionId,
    };

    const push = (ev: AgentEvent) => {
      ev.sessionId = options.sessionId;
      const native =
        (ev as any).nativeSessionId ?? (ev.raw as any)?.session_id ?? (ev.raw as any)?.sessionID;
      if (native) handle.nativeSessionId = native;
      buffer.push(ev);
      emitter.emit("event", ev);
    };

    createLineReader(proc.stdout!, (line) => {
      const evs = parseOmpLine(line, options.sessionId);
      for (const ev of evs) push(ev);
      // Try to salvage session id
      try {
        const obj = JSON.parse(line);
        if (obj.session_id && !handle.nativeSessionId) handle.nativeSessionId = obj.session_id;
        if (obj.sessionID && !handle.nativeSessionId) handle.nativeSessionId = obj.sessionID;
        // Sometimes omp rpc emits {"id":"...","result":{...}}
      } catch {
        // If not JSON, treat as text delta?
        if (line.trim()) {
          push({
            type: "text.delta",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            delta: line + "\n",
            raw: line,
          } as AgentEvent);
        }
      }
    });

    let stderrBuf = "";
    proc.stderr?.on("data", (c) => (stderrBuf += c.toString()));

    proc.on("close", (code, signal) => {
      handle.exitCode = code;
      handle.done = true;
      const terminal = synthesizeTerminalEvent({
        sessionId: options.sessionId,
        exitCode: code,
        signal,
        hasTerminal: buffer.some((e) => e.type === "session.completed" || e.type === "session.failed"),
        hasMessage: buffer.some((e) => e.type === "message" || e.type === "text.delta"),
        stderr: stderrBuf,
      });
      if (terminal) push(terminal);
      emitter.emit("done");
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn-level failure (ENOENT = binary missing): infra, not task.
      const failure: FailureInfo =
        err.code === "ENOENT"
          ? { code: "SPAWN_FAILED", blame: "infra", retryable: false, detail: err.message }
          : { code: "SPAWN_FAILED", blame: "infra", retryable: true, detail: err.message };
      push({
        type: "session.failed",
        sessionId: options.sessionId,
        timestamp: new Date().toISOString(),
        error: err.message,
        failure,
        raw: err,
      } as AgentEvent);
      handle.done = true;
      emitter.emit("done");
    });

    this.handles.set(options.sessionId, handle);

    return {
      id: options.sessionId,
      nativeSessionId: handle.nativeSessionId,
      pid: proc.pid,
      cwd: options.cwd,
      model: options.model,
      handle,
    };
  }

  async send(session: DriverSession, message: string): Promise<void> {
    const h = this.handles.get(session.id);
    let nativeId = session.nativeSessionId || h?.nativeSessionId;
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
    const h = this.handles.get(session.id) as OmpHandle | undefined;
    const proc = (h?.proc ?? (session.handle as any)?.proc) as ChildProcess | undefined;
    if (!proc || proc.killed) return;
    try {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { try { proc.kill("SIGKILL"); } catch {}; done = true; resolve(); } }, 3000);
        proc.once("close", () => { if (!done) { clearTimeout(t); done = true; resolve(); } });
      });
    } catch {}
  }

  async *events(session: DriverSession): AsyncIterable<AgentEvent> {
    const h = this.handles.get(session.id) as OmpHandle | undefined;
    if (!h) return;
    let idx = 0;
    while (true) {
      while (idx < h.buffer.length) yield h.buffer[idx++];
      if (h.done && idx >= h.buffer.length) break;
      await new Promise<void>((resolve) => {
        const onEvent = () => { h.emitter.off("event", onEvent); h.emitter.off("done", onDone); resolve(); };
        const onDone = () => { h.emitter.off("event", onEvent); h.emitter.off("done", onDone); resolve(); };
        h.emitter.once("event", onEvent);
        h.emitter.once("done", onDone);
      });
    }
  }

  getHandle(sessionId: string): OmpHandle | undefined {
    return this.handles.get(sessionId);
  }
}
