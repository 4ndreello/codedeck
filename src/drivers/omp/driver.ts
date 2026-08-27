import { spawn, type ChildProcess } from "node:child_process";
import { detectBinary, createLineReader } from "../helpers.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { EventEmitter } from "node:events";

interface OmpHandle {
  proc: ChildProcess;
  emitter: EventEmitter;
  buffer: AgentEvent[];
  done: boolean;
  exitCode: number | null;
  nativeSessionId?: string;
}

function parseOmpLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return []; }
  const ts = new Date().toISOString();
  const raw = obj;
  const events: AgentEvent[] = [];

  // OMP RPC mode emits JSON objects with type field
  // Observed rpc mode may emit {"type":"text","text":"..."} etc.
  // Handle generic
  if (obj.error) {
    events.push({
      type: "session.failed",
      sessionId,
      timestamp: ts,
      error: typeof obj.error === "string" ? obj.error : obj.error.message || JSON.stringify(obj.error),
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "session.started" || obj.type === "session_created") {
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId: obj.session_id || obj.sessionID || obj.id,
      raw,
    } as any);
    return events;
  }

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
      events.push({
        type: "session.failed",
        sessionId,
        timestamp: ts,
        error: obj.error || obj.result || "OMP failed",
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
    return { installed: true, path: res.path, version: res.version, details: "omp --mode rpc" };
  }

  async start(options: StartOptions): Promise<DriverSession> {
    // Use omp --mode rpc --print for non-interactive? But spec says prefer --mode rpc with NDJSON
    // For MVP we use: omp --mode json -p "prompt"  (print mode with json?)
    // Let's use: omp --mode rpc -p "prompt" and capture output; fallback to text mode
    // Simpler: Use omp --mode json -p "prompt" if rpc not available
    // We'll try omp --mode rpc -p "prompt" first; if fails, fallback to omp -p

    const baseArgs: string[] = [];
    // Determine args based on resume
    let args: string[];
    if (options.resumeSessionId) {
      // OMP resume: omp --resume <id> --mode rpc -p "prompt"
      args = ["--resume", options.resumeSessionId, "--mode", "rpc", "-p", options.prompt];
    } else {
      args = ["--mode", "rpc", "-p", options.prompt];
    }
    if (options.model) {
      args.unshift("--model", options.model);
      // Actually model flag should be before --mode? order doesn't matter much
    }

    const proc = spawn("omp", args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin?.end();

    const emitter = new EventEmitter();
    const buffer: AgentEvent[] = [];
    let nativeId: string | undefined = options.resumeSessionId;
    let done = false;
    let exitCode: number | null = null;

    const push = (ev: AgentEvent) => {
      ev.sessionId = options.sessionId;
      if ((ev as any).nativeSessionId) nativeId = (ev as any).nativeSessionId;
      if ((ev.raw as any)?.session_id) nativeId = (ev.raw as any).session_id;
      if ((ev.raw as any)?.sessionID) nativeId = (ev.raw as any).sessionID;
      buffer.push(ev);
      emitter.emit("event", ev);
    };

    createLineReader(proc.stdout!, (line) => {
      const evs = parseOmpLine(line, options.sessionId);
      for (const ev of evs) push(ev);
      // Try to salvage session id
      try {
        const obj = JSON.parse(line);
        if (obj.session_id && !nativeId) nativeId = obj.session_id;
        if (obj.sessionID && !nativeId) nativeId = obj.sessionID;
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

    proc.on("close", (code) => {
      exitCode = code;
      done = true;
      const hasTerminal = buffer.some((e) => e.type === "session.completed" || e.type === "session.failed");
      if (!hasTerminal) {
        // If we got text but no terminal, emit completed
        const hasMessage = buffer.some((e) => e.type === "message" || e.type === "text.delta");
        if (code === 0) {
          if (!hasMessage && stderrBuf.trim()) {
            // May have printed to stderr?
          }
          push({
            type: "session.completed",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            reason: "exit 0",
            exitCode: 0,
            raw: { stderr: stderrBuf.slice(0, 2000) },
          } as AgentEvent);
        } else {
          push({
            type: "session.failed",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            error: stderrBuf.slice(0, 2000) || `OMP exited with code ${code}`,
            exitCode: code ?? 1,
            raw: { stderr: stderrBuf.slice(0, 2000) },
          } as AgentEvent);
        }
      }
      emitter.emit("done");
    });

    proc.on("error", (err) => {
      push({
        type: "session.failed",
        sessionId: options.sessionId,
        timestamp: new Date().toISOString(),
        error: err.message,
        raw: err,
      } as AgentEvent);
      done = true;
      emitter.emit("done");
    });

    const handle: OmpHandle = { proc, emitter, buffer, done, exitCode, nativeSessionId: nativeId };
    this.handles.set(options.sessionId, handle);

    return {
      id: options.sessionId,
      nativeSessionId: nativeId,
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
