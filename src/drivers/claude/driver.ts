import { spawn, type ChildProcess } from "node:child_process";
import { createLineReader, detectBinary } from "../helpers.js";
import { parseClaudeLine } from "./parser.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { EventEmitter } from "node:events";

interface ClaudeHandle {
  proc: ChildProcess;
  emitter: EventEmitter;
  buffer: AgentEvent[];
  done: boolean;
  exitCode: number | null;
  nativeSessionId?: string;
}

// Pure so the flag spellings are testable without spawning claude.
export function buildClaudeArgs(options: StartOptions): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  // Bypass permissions for automation (as spec allows).
  args.push("--dangerously-skip-permissions");
  if (options.model) args.push("--model", options.model);
  // Claude spells effort as a first-class flag and accepts the same levels as
  // the others. It has NO service-tier equivalent, so `options.fast` is
  // deliberately dropped here rather than translated into an invalid flag.
  if (options.effort) args.push("--effort", options.effort);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  args.push(options.prompt);
  return args;
}

export class ClaudeDriver implements AgentDriver {
  readonly id = "claude" as const;
  private handles = new Map<string, ClaudeHandle>();

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
    const res = await detectBinary("claude");
    if (!res.installed) return { installed: false, error: "claude binary not found" };
    // Try to check auth via claude --version? Or check config
    // Do a lightweight check: try to run claude --help quickly
    // For auth, we can check if ANTHROPIC_API_KEY or OAuth token exists
    // Simplify: if binary exists, authenticated = true if we can run a dummy print? Too heavy
    // Check for ~/.claude/.credentials.json or ANTHROPIC_API_KEY
    let authenticated: boolean | undefined;
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
      if (fs.existsSync(credPath)) authenticated = true;
      else if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) authenticated = true;
      else authenticated = undefined; // unknown, assume yes for driving
    } catch {
      authenticated = undefined;
    }
    return {
      installed: true,
      path: res.path,
      version: res.version,
      authenticated,
      details: "stream-json via claude -p",
    };
  }

  async start(options: StartOptions): Promise<DriverSession> {
    const args = buildClaudeArgs(options);

    const proc = spawn("claude", args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin?.end();

    const emitter = new EventEmitter();
    const buffer: AgentEvent[] = [];
    let nativeSessionId: string | undefined = options.resumeSessionId;
    let done = false;
    let exitCode: number | null = null;

    const push = (ev: AgentEvent) => {
      // Enrich sessionId
      ev.sessionId = options.sessionId;
      if ((ev as any).nativeSessionId) nativeSessionId = (ev as any).nativeSessionId;
      // Also try to extract session_id from raw
      if (!nativeSessionId && (ev.raw as any)?.session_id) nativeSessionId = (ev.raw as any).session_id;
      if (!nativeSessionId && (ev.raw as any)?.sessionId) nativeSessionId = (ev.raw as any).sessionId;
      buffer.push(ev);
      emitter.emit("event", ev);
    };

    // Handle stdout lines
    createLineReader(proc.stdout!, (line) => {
      const evs = parseClaudeLine(line, options.sessionId);
      for (const ev of evs) push(ev);
      // Fallback: try to extract session_id even if no event
      try {
        const obj = JSON.parse(line);
        if (obj.session_id && !nativeSessionId) nativeSessionId = obj.session_id;
        if (obj.sessionId && !nativeSessionId) nativeSessionId = obj.sessionId;
      } catch {}
    });

    let stderrBuf = "";
    proc.stderr?.on("data", (c) => (stderrBuf += c.toString()));

    proc.on("close", (code) => {
      exitCode = code;
      done = true;
      if (buffer.length === 0 || !buffer.some((e) => e.type === "session.completed" || e.type === "session.failed")) {
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
          push({
            type: "session.failed",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            error: stderrBuf.slice(0, 2000) || `Claude exited with code ${code}`,
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

    const handle: ClaudeHandle = { proc, emitter, buffer, done, exitCode, nativeSessionId };
    this.handles.set(options.sessionId, handle);

    // Wait a tick to capture initial events? Return immediately
    // Native session id will be discovered asynchronously; daemon can poll handle.nativeSessionId
    return {
      id: options.sessionId,
      nativeSessionId,
      pid: proc.pid,
      cwd: options.cwd,
      model: options.model,
      handle,
    };
  }

  async send(session: DriverSession, message: string): Promise<void> {
    const h = this.handles.get(session.id) as ClaudeHandle | undefined;
    // For claude, send means resume with new message as new process
    // We don't have persistent stdin; we start a new process with --resume
    if (!session.nativeSessionId && h?.nativeSessionId) {
      session.nativeSessionId = h.nativeSessionId;
    }
    // If no nativeSessionId, we can't resume; throw
    if (!session.nativeSessionId) {
      throw new Error("No native session id available for resume");
    }
    // Spawn a new process for the follow-up turn, replace handle
    const newSession = await this.start({
      sessionId: session.id,
      prompt: message,
      cwd: session.cwd,
      model: session.model,
      resumeSessionId: session.nativeSessionId,
    });
    // Update session handle reference
    session.pid = newSession.pid;
    session.handle = newSession.handle;
    session.nativeSessionId = newSession.nativeSessionId || session.nativeSessionId;
  }

  async stop(session: DriverSession): Promise<void> {
    const h = this.handles.get(session.id) as ClaudeHandle | undefined;
    const proc = (h?.proc ?? (session.handle as ClaudeHandle)?.proc) as ChildProcess | undefined;
    if (!proc || proc.killed) return;
    try {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        let done = false;
        const t = setTimeout(() => {
          if (!done) {
            try { proc.kill("SIGKILL"); } catch {}
            done = true;
            resolve();
          }
        }, 3000);
        proc.once("close", () => {
          if (!done) {
            clearTimeout(t);
            done = true;
            resolve();
          }
        });
      });
    } catch {}
  }

  async *events(session: DriverSession): AsyncIterable<AgentEvent> {
    const h = this.handles.get(session.id) as ClaudeHandle | undefined;
    if (!h) return;
    let idx = 0;
    while (true) {
      while (idx < h.buffer.length) {
        yield h.buffer[idx++];
      }
      if (h.done && idx >= h.buffer.length) break;
      await new Promise<void>((resolve) => {
        const onEvent = () => {
          h.emitter.off("event", onEvent);
          h.emitter.off("done", onDone);
          resolve();
        };
        const onDone = () => {
          h.emitter.off("event", onEvent);
          h.emitter.off("done", onDone);
          resolve();
        };
        h.emitter.once("event", onEvent);
        h.emitter.once("done", onDone);
      });
    }
  }

  // Helper for daemon to poll native id
  getNativeId(sessionId: string): string | undefined {
    return this.handles.get(sessionId)?.nativeSessionId;
  }

  getHandle(sessionId: string): ClaudeHandle | undefined {
    return this.handles.get(sessionId);
  }
}
