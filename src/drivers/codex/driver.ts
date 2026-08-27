import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary, safeJsonParse } from "../helpers.js";
import { parseCodexLine } from "./parser.js";
import type { AgentDriver, AgentInstallation, StartOptions, DriverSession, ReattachRequest } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import { SessionRuntime, nativeIdFrom, type RuntimeHooks } from "../session-runtime.js";
import { synthesizeTerminalEvent } from "../terminal.js";
import { killTree } from "../../utils/process.js";

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
  private handles = new Map<string, SessionRuntime>();

  private readonly hooks: RuntimeHooks = {
    onLine: (line, { sessionId, push, setNativeId, isStderr }) => {
      if (isStderr) {
        // Tool-level failures (sandbox denials, approval refusals) are logged
        // to stderr by the Rust core and NEVER appear as JSON frames on
        // stdout. Parse them as they happen — salvaging stderr only in the
        // exit handler is too late and conditional.
        const ev = parseCodexStderrLine(line, sessionId);
        if (ev) push(ev);
        return;
      }
      const evs = parseCodexLine(line, sessionId);
      if (!evs.length) {
        const native = nativeIdFrom(safeJsonParse(line), ["thread_id", "threadId"]);
        if (native) setNativeId(native);
        return;
      }
      for (const ev of evs) {
        const native = nativeIdFrom(ev.raw, ["thread_id", "threadId"]);
        if (native) setNativeId(native);
        push(ev);
      }
    },
    synthesizeTerminal: (ctx) => {
      const ev = synthesizeTerminalEvent({ ...ctx, harness: "Codex" });
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
    // The runtime spawns codex DETACHED with stdout/stderr in the session's
    // log files (see helpers.spawnDetached): the process outlives daemon
    // restarts and its output can always be re-tailed from a persisted offset.
    const runtime = SessionRuntime.spawn({
      sessionId: options.sessionId,
      cmd: "codex",
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

  // Daemon-restart path: the detached codex process kept running (or already
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
    session.nativeSessionId = newSession.nativeSessionId || nativeId;
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
