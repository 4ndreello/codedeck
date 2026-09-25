import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { getPaths } from "../config/paths.js";
import { DEFAULT_WEB_HOST, webBaseUrl } from "../config/web-host.js";
import type { WebEnsureParams, WebEnsureResult } from "./protocol.js";

// The daemon never imports the web server itself (WD-28): it only spawns and watches
// the child that serves the console, so an HTTP failure cannot take the daemon down.

export type { WebEnsureParams, WebEnsureResult };

export const WEB_START_TIMEOUT_MS = 5000;
export const WEB_STOP_TIMEOUT_MS = 3000;

export type WebEnsureErrorCode = "WEB_LISTEN_FAILED" | "WEB_START_FAILED" | "WEB_BAD_ENTRY" | "WEB_BAD_HOST";

export class WebEnsureError extends Error {
  constructor(
    readonly code: WebEnsureErrorCode,
    message: string,
    readonly details?: { port: number },
  ) {
    super(message);
    this.name = "WebEnsureError";
  }
}

export interface WebChildProcess {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface WebSupervisorOptions {
  log: (line: string) => void;
  spawnChild?: (entry: string, args: string[]) => WebChildProcess;
  defaultEntry?: string;
  entryExists?: (entry: string) => boolean;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** What a child was started for; decides whether a later request may reuse it. */
type StartedFor = { kind: "explicit"; port: number } | { kind: "preferred"; port: number } | { kind: "none" };
type HostFor = "explicit" | "preferred" | "none";

interface RunningChild extends WebEnsureResult {
  child: WebChildProcess;
  host: string;
  hostFor: HostFor;
  entry: string;
  build: string | undefined;
  startedFor: StartedFor;
  exited: Promise<void>;
}

type SupervisorState =
  | { kind: "none" }
  | { kind: "starting"; promise: Promise<WebEnsureResult> }
  | { kind: "running"; running: RunningChild };

export interface SpawnWebChildIo {
  spawn: typeof spawn;
  logsDir: string;
}

/** Spawn the child with its stderr appended to `<logsDir>/web-child.log` (WD-50). */
export function spawnWebChild(
  entry: string,
  args: string[],
  io: SpawnWebChildIo = { spawn, logsDir: getPaths().logsDir },
): WebChildProcess {
  fs.mkdirSync(io.logsDir, { recursive: true });
  const stderr = fs.openSync(path.join(io.logsDir, "web-child.log"), "a");
  try {
    const child = io.spawn(process.execPath, [entry, ...args], {
      stdio: ["pipe", "pipe", stderr],
      env: { ...process.env },
    });
    return child as unknown as WebChildProcess;
  } finally {
    fs.closeSync(stderr);
  }
}

export class WebSupervisor {
  private state: SupervisorState = { kind: "none" };
  private current: WebChildProcess | undefined;
  private readonly spawnChild: (entry: string, args: string[]) => WebChildProcess;
  private readonly defaultEntry: string;
  private readonly entryExists: (entry: string) => boolean;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: WebSupervisorOptions) {
    this.spawnChild = options.spawnChild ?? ((entry, args) => spawnWebChild(entry, args));
    this.defaultEntry = options.defaultEntry ?? fileURLToPath(new URL("../web/child.js", import.meta.url));
    this.entryExists = options.entryExists ?? ((entry) => fs.existsSync(entry));
    this.startTimeoutMs = options.startTimeoutMs ?? WEB_START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? WEB_STOP_TIMEOUT_MS;
  }

  async ensure(params: WebEnsureParams): Promise<WebEnsureResult> {
    if (
      [params.host, params.preferredHost].some(
        (host) => host !== undefined && (typeof host !== "string" || isIP(host) === 0),
      )
    ) {
      throw new WebEnsureError("WEB_BAD_HOST", "web.ensure host and preferredHost must be IP addresses");
    }
    if (params.entry !== undefined && !this.isValidEntry(params.entry)) {
      throw new WebEnsureError("WEB_BAD_ENTRY", `invalid web child entry: ${params.entry}`);
    }
    // One start at a time: a request that finds a start in flight waits for it,
    // then judges the outcome by its own params.
    while (this.state.kind === "starting") await this.state.promise.catch(() => {});
    const state = this.state;
    const running = state.kind === "running" ? state.running : undefined;
    const requestedHost = this.requestedHost(running, params);
    if (running && this.matches(running, params, requestedHost.host)) return resultOf(running);

    const previous = running;
    const promise = (async () => {
      if (previous) await this.stop(previous);
      return this.start(params, requestedHost.host, requestedHost.hostFor);
    })();
    this.state = { kind: "starting", promise };
    promise.catch(() => {
      if (this.state.kind === "starting" && this.state.promise === promise) this.state = { kind: "none" };
    });
    return promise;
  }

  close(): void {
    this.state = { kind: "none" };
    this.current?.kill("SIGTERM");
  }

  private isValidEntry(entry: string): boolean {
    return path.isAbsolute(entry) && entry.endsWith("/web/child.js") && this.entryExists(entry);
  }

  private requestedHost(running: RunningChild | undefined, params: WebEnsureParams): { host: string; hostFor: HostFor } {
    if (params.host !== undefined) return { host: params.host, hostFor: "explicit" };
    if (params.preferredHost !== undefined && running?.hostFor !== "explicit") {
      return { host: params.preferredHost, hostFor: "preferred" };
    }
    if (running) return { host: running.host, hostFor: running.hostFor };
    return { host: DEFAULT_WEB_HOST, hostFor: "none" };
  }

  private matches(running: RunningChild, params: WebEnsureParams, requestedHost: string): boolean {
    if (running.host !== requestedHost) return false;
    if (params.entry !== undefined && params.entry !== running.entry) return false;
    if (params.build !== undefined && ((params.entry ?? this.defaultEntry) !== running.entry || params.build !== running.build)) {
      return false;
    }
    // An explicit port never moves a running console. A preferred port does,
    // unless the child was started for that same preferred port.
    if (params.port !== undefined || params.preferredPort === undefined) return true;
    return running.startedFor.kind === "preferred" && running.startedFor.port === params.preferredPort;
  }

  private async stop(running: RunningChild): Promise<void> {
    running.child.kill("SIGTERM");
    if (await exitsWithin(running.exited, this.stopTimeoutMs)) return;
    running.child.kill("SIGKILL");
    await exitsWithin(running.exited, this.stopTimeoutMs);
  }

  private start(params: WebEnsureParams, host: string, hostFor: HostFor): Promise<WebEnsureResult> {
    const entry = params.entry ?? this.defaultEntry;
    const startedFor: StartedFor =
      params.port !== undefined
        ? { kind: "explicit", port: params.port }
        : params.preferredPort !== undefined
          ? { kind: "preferred", port: params.preferredPort }
          : { kind: "none" };
    const args = [
      "--web-child",
      "--host",
      host,
      ...(startedFor.kind === "explicit" ? ["--port", String(startedFor.port)] : []),
      ...(startedFor.kind === "preferred" ? ["--preferred-port", String(startedFor.port)] : []),
    ];
    let child: WebChildProcess;
    try {
      child = this.spawnChild(entry, args);
    } catch (error) {
      return Promise.reject(new WebEnsureError("WEB_START_FAILED", `could not start the web child: ${messageOf(error)}`));
    }
    this.current = child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    return new Promise<WebEnsureResult>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      let listening = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      const fail = (message: string): void => {
        if (!settle()) return;
        child.kill("SIGKILL");
        reject(new WebEnsureError("WEB_START_FAILED", message));
      };
      const timer = setTimeout(() => fail(`web child sent no handshake within ${this.startTimeoutMs} ms`), this.startTimeoutMs);

      child.stdin.on("error", () => {});
      child.stdout.on("error", () => {});
      child.once("error", (error) => fail(`could not start the web child: ${error.message}`));
      child.once("exit", (code, signal) => {
        if (!settled) {
          fail(`web child exited before its handshake (code=${code ?? signal})`);
          return;
        }
        if (!listening) return;
        this.options.log(`web child exited code=${code ?? signal}`);
        if (this.state.kind === "running" && this.state.running.child === child) this.state = { kind: "none" };
      });
      // Keep reading after the handshake so a chatty child never blocks on a full pipe.
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        buffer += chunk.toString();
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const handshake = parseHandshake(buffer.slice(0, end));
        if (handshake.kind === "invalid") {
          fail(`web child sent an invalid handshake: ${handshake.message}`);
          return;
        }
        settle();
        if (handshake.kind === "error") {
          reject(new WebEnsureError("WEB_LISTEN_FAILED", handshake.message, { port: handshake.port ?? params.port ?? 0 }));
          return;
        }
        listening = true;
        const running: RunningChild = {
          baseUrl: webBaseUrl(host, handshake.port),
          port: handshake.port,
          token: handshake.token,
          child,
          host,
          hostFor,
          entry,
          build: handshake.build ?? params.build,
          startedFor,
          exited,
        };
        this.state = { kind: "running", running };
        this.options.log(`web listening port=${handshake.port}`);
        resolve(resultOf(running));
      });
    });
  }
}

type Handshake =
  | { kind: "ok"; port: number; token: string; build?: string }
  | { kind: "error"; message: string; port?: number }
  | { kind: "invalid"; message: string };

function parseHandshake(line: string): Handshake {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid", message: "not JSON" };
  }
  if (typeof value !== "object" || value === null) return { kind: "invalid", message: "not an object" };
  const record = value as Record<string, unknown>;
  if (typeof record.error === "object" && record.error !== null) {
    const error = record.error as Record<string, unknown>;
    return {
      kind: "error",
      message: typeof error.message === "string" ? error.message : "web child could not listen",
      port: typeof error.port === "number" ? error.port : undefined,
    };
  }
  if (typeof record.port !== "number" || typeof record.token !== "string") {
    return { kind: "invalid", message: "missing port or token" };
  }
  return { kind: "ok", port: record.port, token: record.token, build: typeof record.build === "string" ? record.build : undefined };
}

function resultOf(running: RunningChild): WebEnsureResult {
  return { baseUrl: running.baseUrl, host: running.host, port: running.port, token: running.token };
}

function exitsWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
