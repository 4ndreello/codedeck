import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../core/events.js";
import { getPaths } from "../config/paths.js";
import path from "node:path";
import { FileTailer } from "./tailer.js";
import { spawnDetached } from "./helpers.js";
import { killTree, processAlive, processGroupAlive, processStartTime, sleep } from "../utils/process.js";
import type { FailureInfo } from "../core/errors.js";

export interface LineContext {
  sessionId: string;
  push: (ev: AgentEvent) => void;
  // Record a harness-native session id discovered on a line (or inside an
  // event's raw payload) so `send`/resume keeps working across restarts.
  setNativeId: (id: string) => void;
  isStderr: boolean;
}

export interface RuntimeHooks {
  // Driver-specific parse of one log line. Stderr lines are also delivered
  // here (isStderr=true) — codex parses ERROR frames out of them; other
  // drivers just ignore them (the runtime keeps the text for classification).
  onLine: (line: string, ctx: LineContext) => void;
  // Terminal synthesis when the process exits without emitting a terminal
  // frame. exitCode is null when death was learned by polling (signal death
  // or daemon restarted and only the pid is known).
  synthesizeTerminal: (ctx: {
    sessionId: string;
    exitCode: number | null;
    signal: string | null;
    hasTerminal: boolean;
    hasMessage: boolean;
    stderr: string;
  }) => AgentEvent[];
}

// One log-file pair per codedeck session; resume turns (send) APPEND to the
// same files so a session's raw history stays in one place.
export interface SessionLogPaths {
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
}

export function sessionLogPaths(sessionId: string): SessionLogPaths {
  const { logsDir } = getPaths();
  return {
    stdoutPath: path.join(logsDir, `${sessionId}.ndjson`),
    stderrPath: path.join(logsDir, `${sessionId}.stderr.log`),
    metadataPath: path.join(logsDir, `${sessionId}.process.json`),
  };
}

export function readSessionProcessMetadata(sessionId: string): { pid: number; pidStartTime?: string } | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(sessionLogPaths(sessionId).metadataPath, "utf8")) as {
      pid?: unknown;
      pidStartTime?: unknown;
    };
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
    return {
      pid: value.pid,
      pidStartTime: typeof value.pidStartTime === "string" ? value.pidStartTime : undefined,
    };
  } catch {
    return undefined;
  }
}

type StreamName = "log" | "stderr";
interface EventBoundary {
  stream: StreamName;
  offset: number;
  last: boolean;
}
interface PendingNoEvent {
  beforeEventCount: number;
  offset: number;
}

// Shared session wire-up for all drivers: detached spawn with file output
// (or reattach to files of a process that outlived the daemon), incremental
// parse into normalized events, terminal synthesis on silent death, and the
// buffer+emitter event loop drivers expose through `events()`.
export class SessionRuntime {
  pid!: number;
  readonly emitter = new EventEmitter();
  readonly buffer: AgentEvent[] = [];
  done = false;
  exitCode: number | null = null;
  nativeSessionId?: string;
  proc?: ChildProcess;

  private tailer!: FileTailer;
  private stderrTailer!: FileTailer;
  private stderrBuf = "";
  private exitWatch: NodeJS.Timeout | null = null;
  private expectedStartTime?: string;
  private stopRequested = false;
  private safeLogOffset = 0;
  private safeStderrOffset = 0;
  private yieldedEvents = 0;
  // A raw line can normalize to several events (e.g. opencode message emits
  // message + text.delta). Keep the safe offset behind the line until the
  // final event from that line has been yielded to the daemon. A line that
  // normalizes to no event gets the same treatment: read-ahead must never
  // move the cursor past an earlier buffered event.
  private readonly eventBoundaries = new WeakMap<AgentEvent, EventBoundary>();
  private pendingNoEvent: Record<StreamName, PendingNoEvent | null> = { log: null, stderr: null };

  private constructor(
    readonly sessionId: string,
    private readonly hooks: RuntimeHooks,
  ) {}

  static spawn(opts: {
    sessionId: string;
    cmd: string;
    args: string[];
    cwd: string;
    // The harness-native session id a resume turn continues (from the
    // sessions table); discovered ids refine it as lines are parsed.
    nativeSessionId?: string;
    hooks: RuntimeHooks;
  }): SessionRuntime {
    const rt = new SessionRuntime(opts.sessionId, opts.hooks);
    if (opts.nativeSessionId) rt.nativeSessionId = opts.nativeSessionId;
    const paths = sessionLogPaths(opts.sessionId);
    const { proc, stdoutOffset, stderrOffset } = spawnDetached({
      cmd: opts.cmd,
      args: opts.args,
      cwd: opts.cwd,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
    });
    rt.proc = proc;
    rt.pid = proc.pid!;
    rt.expectedStartTime = processStartTime(rt.pid);
    try {
      // Sidecar closes the tiny spawn→SQLite-update window. Rename makes the
      // record all-or-nothing if the daemon dies during serialization.
      const tempPath = `${paths.metadataPath}.tmp-${process.pid}`;
      fs.writeFileSync(tempPath, JSON.stringify({ pid: rt.pid, pidStartTime: rt.expectedStartTime }) + "\n", "utf8");
      fs.renameSync(tempPath, paths.metadataPath);
    } catch {}
    rt.wire(paths, stdoutOffset, stderrOffset);

    // Spawn-level failure (ENOENT = binary missing): infra, not task.
    proc.on("error", (err: NodeJS.ErrnoException) => {
      const failure: FailureInfo = {
        code: "SPAWN_FAILED",
        blame: "infra",
        retryable: err.code !== "ENOENT",
        detail: err.message,
      };
      rt.push({
        type: "session.failed",
        sessionId: opts.sessionId,
        timestamp: new Date().toISOString(),
        error: err.message,
        failure,
        raw: err,
      } as AgentEvent);
      rt.finish(null, null);
    });
    return rt;
  }

  // Rebuild the event feed for a session whose detached process outlived a
  // daemon restart: tail the log files from the persisted offsets. Nothing
  // is spawned; if the pid is already dead, the runtime drains the files and
  // classifies the death like any other exit.
  static reattach(opts: {
    sessionId: string;
    pid: number;
    pidStartTime?: string;
    nativeSessionId?: string;
    logOffset?: number;
    stderrOffset?: number;
    hooks: RuntimeHooks;
  }): SessionRuntime {
    const rt = new SessionRuntime(opts.sessionId, opts.hooks);
    rt.pid = opts.pid;
    rt.expectedStartTime = opts.pidStartTime;
    if (opts.nativeSessionId) rt.nativeSessionId = opts.nativeSessionId;
    const paths = sessionLogPaths(opts.sessionId);
    rt.wire(paths, opts.logOffset ?? 0, opts.stderrOffset ?? 0);
    return rt;
  }

  private wire(paths: { stdoutPath: string; stderrPath: string }, stdoutOffset: number, stderrOffset: number): void {
    this.safeLogOffset = stdoutOffset;
    this.safeStderrOffset = stderrOffset;
    this.stderrTailer = new FileTailer(paths.stderrPath, {
      startOffset: stderrOffset,
      onLine: (line, offset) => {
        this.stderrBuf = (this.stderrBuf + line + "\n").slice(-65536);
        this.handleLine("stderr", line, offset);
      },
    });
    this.tailer = new FileTailer(paths.stdoutPath, {
      startOffset: stdoutOffset,
      onLine: (line, offset) => this.handleLine("log", line, offset),
    });

    if (this.proc) {
      // Same-lifetime case: the ChildProcess observes the pid directly.
      this.proc.on("exit", (code, signal) => this.finish(code, signal));
    } else {
      // Cross-restart case: no ChildProcess — poll the pid until it is gone,
      // or until its start identity changes (PID reuse), then drain the files.
      this.exitWatch = setInterval(() => {
        if (this.done) {
          if (this.exitWatch) clearInterval(this.exitWatch);
          this.exitWatch = null;
          return;
        }
        if (this.processMatches()) return;
        if (this.exitWatch) clearInterval(this.exitWatch);
        this.exitWatch = null;
        // Grace so the harness finishes its final write before we drain.
        void sleep(300).then(() => this.finish(null, null));
      }, 500);
    }
    this.tailer.start();
    this.stderrTailer.start();
  }

  private processMatches(): boolean {
    if (!processAlive(this.pid)) return processGroupAlive(this.pid);
    if (this.expectedStartTime === undefined) return true;
    const current = processStartTime(this.pid);
    return current !== undefined && current === this.expectedStartTime;
  }

  private handleLine(stream: StreamName, line: string, offset: number): void {
    const before = this.buffer.length;
    try {
      this.hooks.onLine(line, this.lineCtx(stream === "stderr"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A malformed/unexpected frame must not crash the daemon or strand the
      // detached harness. Surface it as a normal event and keep tailing.
      this.push({
        type: "error",
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        error: `failed to parse ${stream} line: ${message}`,
        raw: line,
      } as AgentEvent);
    }
    const added = this.buffer.length - before;
    if (added === 0) {
      // Do not advance immediately if earlier events are still buffered: this
      // line may have been read ahead before the daemon persisted them.
      this.pendingNoEvent[stream] = { beforeEventCount: this.buffer.length, offset };
      this.flushPendingOffsets();
      return;
    }
    for (let index = before; index < this.buffer.length; index += 1) {
      const event = this.buffer[index]!;
      event.sourceKey = `${stream}:${offset}:${index - before}`;
      this.eventBoundaries.set(event, { stream, offset, last: index === this.buffer.length - 1 });
    }
  }

  private lineCtx(isStderr: boolean): LineContext {
    return {
      sessionId: this.sessionId,
      push: this.push,
      setNativeId: this.setNativeId,
      isStderr,
    };
  }

  private push = (ev: AgentEvent): void => {
    ev.sessionId = this.sessionId;
    this.buffer.push(ev);
    this.emitter.emit("event", ev);
  };

  private setNativeId = (id: string): void => {
    if (id && !this.nativeSessionId) this.nativeSessionId = id;
  };

  private markSafeOffset(stream: StreamName, offset: number): void {
    if (stream === "log") this.safeLogOffset = Math.max(this.safeLogOffset, offset);
    else this.safeStderrOffset = Math.max(this.safeStderrOffset, offset);
  }

  private flushPendingOffsets(): void {
    for (const stream of ["log", "stderr"] as const) {
      const pending = this.pendingNoEvent[stream];
      if (pending && pending.beforeEventCount <= this.yieldedEvents) {
        this.markSafeOffset(stream, pending.offset);
        this.pendingNoEvent[stream] = null;
      }
    }
  }

  private markEventYielded(event: AgentEvent): void {
    const boundary = this.eventBoundaries.get(event);
    if (boundary?.last) this.markSafeOffset(boundary.stream, boundary.offset);
    this.flushPendingOffsets();
  }

  private finish(exitCode: number | null, signal: string | null): void {
    if (this.done) return;
    // Final drain so lines written just before exit are parsed before any
    // terminal synthesis looks at the buffer.
    this.tailer.flush();
    this.stderrTailer.flush();
    this.exitCode = exitCode;
    this.done = true;
    const hasTerminal = this.buffer.some((e) => e.type === "session.completed" || e.type === "session.failed");
    if (!hasTerminal && !this.stopRequested) {
      const hasMessage = this.buffer.some((e) => e.type === "message" || e.type === "text.delta");
      for (const ev of this.hooks.synthesizeTerminal({
        sessionId: this.sessionId,
        exitCode,
        signal,
        hasTerminal,
        hasMessage,
        stderr: this.stderrBuf,
      })) {
        this.push(ev);
      }
    }
    this.emitter.emit("done");
    this.tailer.stop();
    this.stderrTailer.stop();
  }

  // Byte offsets of the last fully yielded line in each file — persisted by
  // the daemon so a reattaching runtime does not replay stored events.
  get offsets(): { log: number; stderr: number } {
    return { log: this.safeLogOffset, stderr: this.safeStderrOffset };
  }
  get drained(): boolean {
    return this.done && this.yieldedEvents >= this.buffer.length;
  }
  async stop(graceMs = 3000): Promise<void> {
    if (!this.processMatches()) {
      // The process raced us to exit (or changed identity). Close this runtime
      // without synthesizing a conflicting harness failure; the daemon owns
      // the single explicit stopped terminal event.
      this.stopRequested = true;
      this.finish(null, "SIGTERM");
      return;
    }
    this.stopRequested = true;
    // Deliberately does NOT cancel the pid-death watcher: killing the process
    // is how the runtime learns it died (exit event or poll) and concludes the
    // event stream. If polling has not fired by the time killTree returns,
    // finish synchronously once the pid is gone.
    await killTree(this.pid, graceMs, this.expectedStartTime);
    if (!processAlive(this.pid) && !processGroupAlive(this.pid)) this.finish(null, "SIGTERM");
  }

  async *events(): AsyncGenerator<AgentEvent> {
    let idx = 0;
    while (true) {
      while (idx < this.buffer.length) {
        const event = this.buffer[idx++]!;
        this.yieldedEvents += 1;
        this.markEventYielded(event);
        yield event;
      }
      if (this.done && idx >= this.buffer.length) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      const onEvent = () => {
        this.emitter.off("event", onEvent);
        this.emitter.off("done", onDone);
        resolve();
      };
      const onDone = () => {
        this.emitter.off("event", onEvent);
        this.emitter.off("done", onDone);
        resolve();
      };
      this.emitter.once("event", onEvent);
      this.emitter.once("done", onDone);
      await promise;
    }
  }
}

// Shared helper for driver hooks: pull a native session id out of a line's
// parsed event or raw JSON without duplicating try/catch in every driver.
export function nativeIdFrom(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
