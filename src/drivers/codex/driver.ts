import { spawn, type ChildProcess } from "node:child_process";
import { detectBinary, createLineReader } from "../helpers.js";
import { parseCodexLine } from "./parser.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { EventEmitter } from "node:events";

interface CodexHandle {
  proc: ChildProcess;
  emitter: EventEmitter;
  buffer: AgentEvent[];
  done: boolean;
  exitCode: number | null;
  nativeSessionId?: string;
}

// Arg building is a pure function so the flag spellings can be tested without
// spawning codex. Measured against codex-cli 0.150.1.
export function buildCodexArgs(options: StartOptions): string[] {
  // resume is a SUBCOMMAND with its own arg list; every flag below has to be
  // mirrored onto it or `send()` silently runs with different settings than
  // `start()` did.
  const args: string[] = options.resumeSessionId
    ? ["exec", "resume", options.resumeSessionId, "--json"]
    : ["exec", "--json"];

  if (options.model) args.push("-m", options.model);

  // Without this codex uses its read-only default and rejects every patch with
  // "writing is blocked by read-only sandbox" -- while still exiting 0, so the
  // session is recorded as completed despite having written nothing.
  args.push("-s", "workspace-write");

  // codex has no dedicated flags for these; both are config overrides whose
  // values are parsed as TOML, hence the embedded quotes.
  if (options.effort) args.push("-c", `model_reasoning_effort="${options.effort}"`);
  if (options.fast) args.push("-c", 'service_tier="priority"');

  args.push("--skip-git-repo-check");
  args.push("-C", options.cwd);
  args.push(options.prompt);
  return args;
}

// Tool-level failures (sandbox denials, approval refusals) are logged to stderr
// by the Rust core and NEVER appear as JSON frames on stdout. Without this the
// only trace is an agent message saying it could not do the work, followed by a
// clean turn.completed.
export function parseCodexStderrLine(line: string, sessionId: string): AgentEvent | null {
  const match = /\bERROR\b\s+(.+)$/.exec(line);
  if (!match) return null;

  let message = match[1].trim();
  // Drop the `<rust::module::path>: error=` prefix; keep the human part.
  const marker = message.indexOf("error=");
  if (marker !== -1) message = message.slice(marker + "error=".length).trim();
  if (!message) return null;

  return {
    type: "error",
    sessionId,
    timestamp: new Date().toISOString(),
    error: message,
    raw: { stderr: line },
  } as AgentEvent;
}

export class CodexDriver implements AgentDriver {
  readonly id = "codex" as const;
  private handles = new Map<string, CodexHandle>();

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      fork: true,
      approvals: true,
      usage: true,
      cost: false,
      modelSelection: true,
      nativeDiff: false,
      interrupt: true,
    };
  }

  async detect(): Promise<AgentInstallation> {
    const res = await detectBinary("codex");
    if (!res.installed) return { installed: false, error: "codex binary not found" };
    // Check auth maybe via codex login status?
    // Simplify: check CODEX env or config
    let authenticated: boolean | undefined;
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      if (fs.existsSync(path.join(home, "auth.json")) || fs.existsSync(path.join(home, "config.toml"))) {
        // not definitive but assume authenticated if file exists
        authenticated = true;
      } else if (process.env.OPENAI_API_KEY) authenticated = true;
    } catch {}
    return { installed: true, path: res.path, version: res.version, authenticated, details: "codex exec --json" };
  }

  async start(options: StartOptions): Promise<DriverSession> {
    return this.spawnWithArgs(buildCodexArgs(options), options);
  }

  private async spawnWithArgs(args: string[], options: StartOptions): Promise<DriverSession> {
    const proc = spawn("codex", args, {
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
      if (!nativeId && (ev.raw as any)?.thread_id) nativeId = (ev.raw as any).thread_id;
      if (!nativeId && (ev.raw as any)?.threadId) nativeId = (ev.raw as any).threadId;
      buffer.push(ev);
      emitter.emit("event", ev);
    };

    createLineReader(proc.stdout!, (line) => {
      // Codex may emit empty or prefix "Reading additional input" on stderr, not stdout
      // Assume JSON lines
      const evs = parseCodexLine(line, options.sessionId);
      if (evs.length) {
        for (const ev of evs) push(ev);
      } else {
        // Try to extract thread_id anyway
        try {
          const obj = JSON.parse(line);
          if (obj.thread_id && !nativeId) nativeId = obj.thread_id;
          if (obj.threadId && !nativeId) nativeId = obj.threadId;
        } catch {}
      }
    });

    let stderrBuf = "";
    let stderrPending = "";
    proc.stderr?.on("data", (c) => {
      const chunk = c.toString();
      stderrBuf += chunk;
      // Emit as the failure happens. Salvaging stderr in the close handler is
      // too late and conditional: a rejected tool call still ends with
      // turn.completed, so the terminal-event check there skips it entirely.
      stderrPending += chunk;
      const lines = stderrPending.split("\n");
      stderrPending = lines.pop() ?? "";
      for (const line of lines) {
        const ev = parseCodexStderrLine(line, options.sessionId);
        if (ev) push(ev);
      }
    });

    proc.on("close", (code) => {
      exitCode = code;
      done = true;
      // Flush trailing fragment that never got a newline — e.g. process
      // killed mid-line or truncated write. Without this the only ERROR
      // signal for a sandbox denial can be lost while exit is 0.
      if (stderrPending.trim()) {
        const ev = parseCodexStderrLine(stderrPending, options.sessionId);
        if (ev) push(ev);
      }
      stderrPending = "";
      // If not already completed/failed, emit final
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
          push({
            type: "session.failed",
            sessionId: options.sessionId,
            timestamp: new Date().toISOString(),
            error: stderrBuf.slice(0, 2000) || `Codex exited with code ${code}`,
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

    const handle: CodexHandle = { proc, emitter, buffer, done, exitCode, nativeSessionId: nativeId };
    this.handles.set(options.sessionId, handle);

    // Also watch for nativeId extracted lazily; update handle reference
    const pollNative = setInterval(() => {
      if (nativeId) handle.nativeSessionId = nativeId;
      if (done) clearInterval(pollNative);
    }, 100);
    setTimeout(() => clearInterval(pollNative), 5000);

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
    if (!nativeId) throw new Error("No native session id for Codex resume");
    const newSession = await this.start({
      sessionId: session.id,
      prompt: message,
      cwd: session.cwd,
      model: session.model,
      resumeSessionId: nativeId,
    });
    session.pid = newSession.pid;
    session.handle = newSession.handle;
    session.nativeSessionId = (newSession.handle as CodexHandle)?.nativeSessionId || nativeId;
  }

  async stop(session: DriverSession): Promise<void> {
    const h = this.handles.get(session.id) as CodexHandle | undefined;
    const proc = (h?.proc ?? (session.handle as any)?.proc) as ChildProcess | undefined;
    if (!proc || proc.killed) return;
    try {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        let done = false;
        const t = setTimeout(() => {
          if (!done) { try { proc.kill("SIGKILL"); } catch {}; done = true; resolve(); }
        }, 3000);
        proc.once("close", () => { if (!done) { clearTimeout(t); done = true; resolve(); } });
      });
    } catch {}
  }

  async *events(session: DriverSession): AsyncIterable<AgentEvent> {
    const h = this.handles.get(session.id) as CodexHandle | undefined;
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

  getHandle(sessionId: string): CodexHandle | undefined {
    return this.handles.get(sessionId);
  }
}
