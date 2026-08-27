import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary, safeJsonParse } from "../helpers.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession, ReattachRequest } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { parseClaudeLine } from "./parser.js";
import { SessionRuntime, nativeIdFrom, type RuntimeHooks } from "../session-runtime.js";
import { synthesizeTerminalEvent } from "../terminal.js";
import { killTree } from "../../utils/process.js";

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
  private handles = new Map<string, SessionRuntime>();

  private readonly hooks: RuntimeHooks = {
    onLine: (line, { sessionId, push, setNativeId, isStderr }) => {
      if (isStderr) return; // claude stderr is diagnostic; the runtime keeps it for classification
      for (const ev of parseClaudeLine(line, sessionId)) {
        const native =
          ev.type === "session.started" && ev.nativeSessionId
            ? ev.nativeSessionId
            : nativeIdFrom(ev.raw, ["session_id", "sessionId"]);
        if (native) setNativeId(native);
        push(ev);
      }
      const native = nativeIdFrom(safeJsonParse(line), ["session_id", "sessionId"]);
      if (native) setNativeId(native);
    },
    synthesizeTerminal: (ctx) => {
      const ev = synthesizeTerminalEvent({ ...ctx, harness: "Claude" });
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
    const res = await detectBinary("claude");
    if (!res.installed) return { installed: false, error: "claude binary not found" };
    // Lightweight auth heuristic: a credentials file or an env token counts as
    // authenticated; otherwise unknown — driving decides.
    let authenticated: boolean | undefined;
    try {
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

    // The runtime spawns claude DETACHED with stdout/stderr in the session's
    // log files (see helpers.spawnDetached): the process outlives daemon
    // restarts and its output can always be re-tailed from a persisted offset.
    const runtime = SessionRuntime.spawn({
      sessionId: options.sessionId,
      cmd: "claude",
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

  // Daemon-restart path: the detached claude process kept running (or already
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
    // For claude, send means resume: a new process with --resume, replacing
    // the runtime for this session.
    const runtime = this.handles.get(session.id);
    if (!session.nativeSessionId && runtime?.nativeSessionId) {
      session.nativeSessionId = runtime.nativeSessionId;
    }
    if (!session.nativeSessionId) {
      throw new Error("No native session id available for resume");
    }
    const newSession = await this.start({
      sessionId: session.id,
      prompt: message,
      cwd: session.cwd,
      model: session.model,
      resumeSessionId: session.nativeSessionId,
    });
    session.pid = newSession.pid;
    session.handle = newSession.handle;
    session.nativeSessionId = newSession.nativeSessionId || session.nativeSessionId;
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
