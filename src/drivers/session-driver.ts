import type { AgentCapabilities } from "../core/capabilities.js";
import type {
  AgentDriver,
  AgentInstallation,
  DriverSession,
  ReattachRequest,
  StartOptions,
} from "../core/driver.js";
import type { AgentEvent } from "../core/events.js";
import type { AgentId } from "../core/session.js";
import { killTree } from "../utils/process.js";
import { safeJsonParse } from "./helpers.js";
import { SessionRuntime, nativeIdFrom, type RuntimeHooks } from "./session-runtime.js";
import { synthesizeTerminalEvent } from "./terminal.js";

export interface SessionDriverHookOptions {
  parse: (line: string, sessionId: string) => AgentEvent[];
  nativeKeys: readonly string[];
  harness: string;
  parseStderr?: (line: string, sessionId: string) => AgentEvent | null;
  plainTextFallback?: boolean;
}

export function createRuntimeHooks(options: SessionDriverHookOptions): RuntimeHooks {
  return {
    onLine: (line, { sessionId, push, setNativeId, isStderr }) => {
      if (isStderr) {
        const event = options.parseStderr?.(line, sessionId);
        if (event) push(event);
        return;
      }

      const parsedEvents = options.parse(line, sessionId);
      for (const event of parsedEvents) {
        const native =
          event.type === "session.started" && event.nativeSessionId
            ? event.nativeSessionId
            : nativeIdFrom(event.raw, options.nativeKeys);
        if (native) setNativeId(native);
        push(event);
      }

      if (
        options.plainTextFallback &&
        parsedEvents.length === 0 &&
        line.trim() &&
        line.trim() !== "null" &&
        safeJsonParse(line) === null
      ) {
        push({
          type: "text.delta",
          sessionId,
          timestamp: new Date().toISOString(),
          delta: `${line}\n`,
          raw: line,
        } as AgentEvent);
      }

      const native = nativeIdFrom(safeJsonParse(line), options.nativeKeys);
      if (native) setNativeId(native);
    },
    synthesizeTerminal: (ctx) => {
      const event = synthesizeTerminalEvent({ ...ctx, harness: options.harness });
      return event ? [event] : [];
    },
  };
}

export abstract class SessionDriver implements AgentDriver {
  abstract readonly id: AgentId;
  protected abstract readonly hooks: RuntimeHooks;
  protected abstract readonly resumeError: string;

  private readonly handles = new Map<string, SessionRuntime>();

  protected abstract buildArgs(options: StartOptions): string[];

  abstract capabilities(): AgentCapabilities;

  abstract detect(): Promise<AgentInstallation>;

  async start(options: StartOptions): Promise<DriverSession> {
    const runtime = SessionRuntime.spawn({
      sessionId: options.sessionId,
      cmd: this.id,
      args: this.buildArgs(options),
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
    if (!nativeId) throw new Error(this.resumeError);
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
