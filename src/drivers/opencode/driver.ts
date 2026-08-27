import { spawn, type ChildProcess } from "node:child_process";
import { detectBinary, createLineReader } from "../helpers.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { EventEmitter } from "node:events";

interface OpencodeHandle {
  proc: ChildProcess;
  emitter: EventEmitter;
  buffer: AgentEvent[];
  done: boolean;
  exitCode: number | null;
  nativeSessionId?: string;
}

function parseOpencodeLine(line: string, sessionId: string): AgentEvent[] {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return []; }
  const ts = new Date().toISOString();
  const raw = obj;
  const events: AgentEvent[] = [];

  // Opencode JSON format varies; observed error shape {"type":"error","sessionID":...}
  // For success, likely {"type":"text","text":"..."} or similar; we handle generically
  if (obj.type === "error") {
    events.push({
      type: "session.failed",
      sessionId,
      timestamp: ts,
      error: obj.error?.data?.message || obj.error?.message || obj.message || JSON.stringify(obj.error || obj),
      raw,
    } as AgentEvent);
    return events;
  }

  if (obj.type === "session.created" || obj.type === "session_created") {
    events.push({
      type: "session.started",
      sessionId,
      timestamp: ts,
      nativeSessionId: obj.sessionID || obj.sessionId || obj.id,
      raw,
    } as any);
    return events;
  }

  if (obj.type === "message" || obj.type === "text" || obj.type === "assistant") {
    const text = obj.text || obj.content || obj.delta || "";
    if (text) {
      events.push({
        type: "message",
        sessionId,
        timestamp: ts,
        role: "assistant",
        content: String(text),
        raw,
      } as AgentEvent);
      events.push({
        type: "text.delta",
        sessionId,
        timestamp: ts,
        delta: String(text),
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
      tool: { name: obj.tool || obj.name || "tool", id: obj.id, output: obj.output, success: !obj.isError },
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
      delta: String(obj.delta),
      raw,
    } as AgentEvent);
    return events;
  }

  return [];
}

export class OpencodeDriver implements AgentDriver {
  readonly id = "opencode" as const;
  private handles = new Map<string, OpencodeHandle>();

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
    if (options.resumeSessionId) {
      args.push("--session", options.resumeSessionId);
    }
    // Auto-approve? For automation we may need --auto? But risk
    // Use --dir to set cwd if supported; otherwise rely on cwd spawn
    // opencode run --dir <cwd> is not standard; we use spawn cwd
    args.push(options.prompt);

    const proc = spawn("opencode", args, {
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
      if ((ev.raw as any)?.sessionID) nativeId = (ev.raw as any).sessionID;
      buffer.push(ev);
      emitter.emit("event", ev);
    };

    createLineReader(proc.stdout!, (line) => {
      const evs = parseOpencodeLine(line, options.sessionId);
      for (const ev of evs) push(ev);
      // Also capture sessionID from raw json even if not parsed
      try {
        const obj = JSON.parse(line);
        if (obj.sessionID && !nativeId) nativeId = obj.sessionID;
        if (obj.sessionId && !nativeId) nativeId = obj.sessionId;
        if (obj.session_id && !nativeId) nativeId = obj.session_id;
      } catch {}
      // If no known event but line is JSON, treat as generic message?
      if (evs.length === 0) {
        try {
          const obj = JSON.parse(line);
          // If stdout contains plain text fallback, we could ignore
        } catch {}
      }
    });

    let stderrBuf = "";
    proc.stderr?.on("data", (c) => (stderrBuf += c.toString()));

    proc.on("close", (code) => {
      exitCode = code;
      done = true;
      const hasTerminal = buffer.some((e) => e.type === "session.completed" || e.type === "session.failed");
      if (!hasTerminal) {
        if (code === 0) {
          push({
            type: "session.completed",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            reason: "exit 0",
            exitCode: 0,
            raw: { stderr: stderrBuf.slice(0, 2000) },
          } as AgentEvent);
        } else {
          // For opencode, many failures are due to model config; provide stderr
          push({
            type: "session.failed",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            error: stderrBuf.slice(0, 2000) || `Opencode exited with code ${code}`,
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

    const handle: OpencodeHandle = { proc, emitter, buffer, done, exitCode, nativeSessionId: nativeId };
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
    const h = this.handles.get(session.id) as OpencodeHandle | undefined;
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
    const h = this.handles.get(session.id) as OpencodeHandle | undefined;
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

  getHandle(sessionId: string): OpencodeHandle | undefined {
    return this.handles.get(sessionId);
  }
}
