import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { getPaths } from "../config/paths.js";

/**
 * Owning the pty is what lets CodeDeck type for the user.
 *
 * Claude Code renames a live session only through `/rename`, which is a TUI
 * command: the `rename_session` control request needs an SDK stdin or a
 * device-signed Remote Control bridge, and the title record in the transcript
 * is re-read on re-stamp rather than watched. So the session name derived from
 * the first prompt can only land the way a person would land it — typed.
 *
 * `script` allocates the pty, because it is the one allocator already on the
 * box: a native dependency would follow every `npm i -g codedeck` onto
 * machines that never open a session. Its stdin is a pipe here, which doubles
 * as the injection channel, and that costs the window size — see the shim.
 */

const SHIM_FILE = "pty-shim.mjs";
const SCRIPT_BINARY = "script";
/** A path with a control character in it cannot be a real binary, and a shell
 * string is the wrong place to find out. */
const SAFE_PATH = /^[^\u0000-\u001f]+$/;
const CONTROL_ENV = "CODEDECK_PTY_CONTROL";
const ROWS_ENV = "CODEDECK_PTY_ROWS";
const COLS_ENV = "CODEDECK_PTY_COLS";
const NAME_SUFFIX = ".name";
/** ETX, which is what Ctrl+C is once the terminal stops turning it into SIGINT. */
const INTERRUPT_KEY = 0x03;
const FALLBACK_ROWS = 24;
const FALLBACK_COLUMNS = 80;
const QUIET_MS = 300;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SGR_MOUSE_START = "\u001b[<";
const SGR_MOUSE_REPORT = /^\u001b\[<[0-9]+;[0-9]+;[0-9]+[Mm]$/;
// Matching terminal replies needs ESC and BEL in the pattern.
const TERMINAL_REPLY = /^(?:(?:\u001bP[^\u001b]*\u001b\\)|(?:\u001b\][^\u001b\u0007]*(?:\u0007|\u001b\\))|(?:\u001b\[[?>][0-?]*[ -/]*(?:c|\$y|u|R|n)))+$/; // NOSONAR

export interface InputGateOptions {
  inject: (keystrokes: string) => void;
  trace?: (event: Record<string, unknown>) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  now?: () => number;
}

/**
 * Claude Code shares its input line between user keys and `/rename`. The name
 * can arrive while someone is typing, turning "Bora tamb" into
 * "Bora tamb/rename XPto xyz" and submitting both as one prompt. Hold the
 * rename until the input is clean and the user has been quiet for 300 ms.
 * Set `CODEDECK_PTY_DEBUG` to an absolute path to append a trace of input bytes
 * and gate decisions for one session.
 */
export function createInputGate(options: InputGateOptions) {
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const now = options.now ?? Date.now;
  const record = options.trace
    ? (event: Record<string, unknown>): void => {
        try {
          options.trace?.(event);
        } catch {}
      }
    : undefined;
  let dirty = false;
  let pending: string | undefined;
  let used = false;
  let disposed = false;
  let inPaste = false;
  let escapeCandidate = "";
  let sgrMouseCandidate = false;
  let dirtyBeforeEscape = false;
  let previousByteBeforeEscape: number | undefined;
  let guardNextEnter = false;
  let previousByte: number | undefined;
  let lastActivity = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const state = (): Record<string, unknown> => ({
    dirty,
    guard: guardNextEnter,
    pending: pending !== undefined,
    used,
  });

  const recordState = (kind: string, extra: Record<string, unknown> = {}): void => {
    if (!record) return;
    record({ kind, ...state(), ...extra });
  };

  const recordInput = (chunk: Buffer, ignored: "focus" | "reply" | null): void => {
    if (!record) return;
    record({ kind: "input", chunk: chunk.toString("hex"), ignored, ...state() });
  };

  const clearTimer = (): void => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };

  const tryInject = (): void => {
    timer = undefined;
    if (disposed) {
      recordState("hold", { reason: "disposed" });
      return;
    }
    if (used) {
      recordState("hold", { reason: "used" });
      return;
    }
    if (pending === undefined) {
      recordState("hold", { reason: "no-pending" });
      return;
    }
    if (dirty) {
      recordState("hold", { reason: "dirty" });
      return;
    }
    used = true;
    const keystrokes = pending;
    pending = undefined;
    options.inject(keystrokes);
    recordState("inject");
  };

  const scheduleQuiet = (): void => {
    clearTimer();
    const remaining = Math.max(0, QUIET_MS - (now() - lastActivity));
    if (remaining === 0) tryInject();
    else timer = schedule(tryInject, remaining);
  };

  const markDirty = (): void => {
    dirty = true;
  };

  const isSubmit = (byte: number, previousByte: number | undefined, inPaste: boolean): boolean =>
    byte === 0x0d && !inPaste && previousByte !== 0x5c && previousByte !== 0x1b;

  const observeEnter = (): void => {
    dirty = guardNextEnter;
    guardNextEnter = false;
  };

  const isSgrMousePrefix = (candidate: string): boolean => {
    if (!candidate.startsWith(SGR_MOUSE_START)) return false;
    const body = candidate.slice(SGR_MOUSE_START.length);
    if (SGR_MOUSE_REPORT.test(candidate)) return true;
    if (!/^[0-9;]*$/.test(body)) return false;
    const fields = body.split(";");
    return fields.length <= 3 && fields.slice(0, -1).every(Boolean);
  };

  const flushUnknownEscape = (byte: number): void => {
    // Unrecognised escape sequences can edit earlier text, so guard the next Enter.
    if (escapeCandidate !== "\u001b\r") guardNextEnter = true;
    const candidate = Buffer.from(escapeCandidate);
    const retryEscape = byte === 0x1b;
    const flush = retryEscape ? candidate.subarray(0, -1) : candidate;
    for (const candidateByte of flush) {
      if (isSubmit(candidateByte, previousByte, inPaste)) observeEnter();
      else markDirty();
      previousByte = candidateByte;
    }
    escapeCandidate = retryEscape ? String.fromCharCode(byte) : "";
    sgrMouseCandidate = false;
    if (retryEscape) {
      dirtyBeforeEscape = dirty;
      previousByteBeforeEscape = previousByte;
    }
  };

  const observeByte = (byte: number): boolean => {
    const char = String.fromCharCode(byte);
    if (escapeCandidate !== "") {
      escapeCandidate += char;
      const isStart = BRACKETED_PASTE_START.startsWith(escapeCandidate);
      const isEnd = BRACKETED_PASTE_END.startsWith(escapeCandidate);
      if (escapeCandidate === BRACKETED_PASTE_START) {
        inPaste = true;
        escapeCandidate = "";
        markDirty();
        return true;
      } else if (escapeCandidate === BRACKETED_PASTE_END) {
        inPaste = false;
        escapeCandidate = "";
        markDirty();
        return true;
      } else if (escapeCandidate === SGR_MOUSE_START && !inPaste) {
        sgrMouseCandidate = true;
      } else if (sgrMouseCandidate) {
        if (SGR_MOUSE_REPORT.test(escapeCandidate)) {
          escapeCandidate = "";
          sgrMouseCandidate = false;
          dirty = dirtyBeforeEscape;
          previousByte = previousByteBeforeEscape;
          return false;
        }
        if (isSgrMousePrefix(escapeCandidate)) {
          previousByte = byte;
          return false;
        }
        flushUnknownEscape(byte);
        previousByte = byte;
        return true;
      } else if (!isStart && !isEnd) {
        flushUnknownEscape(byte);
        previousByte = byte;
        return true;
      }
      previousByte = byte;
      return false;
    }
    if (byte === 0x1b) {
      dirtyBeforeEscape = dirty;
      previousByteBeforeEscape = previousByte;
      escapeCandidate = char;
      markDirty();
      previousByte = byte;
      return false;
    }
    if (isSubmit(byte, previousByte, inPaste)) {
      observeEnter();
    } else {
      markDirty();
      if (byte < 0x20 && byte !== 0x08 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        // An unknown control may drive a suggestion menu, so treat it like an unknown escape.
        guardNextEnter = true;
      }
    }
    previousByte = byte;
    return true;
  };

  return {
    observe(chunk: Buffer): void {
      if (disposed) return;
      if (chunk.equals(Buffer.from("\u001b[I")) || chunk.equals(Buffer.from("\u001b[O"))) {
        recordInput(chunk, "focus");
        return;
      }
      if (TERMINAL_REPLY.test(chunk.toString("latin1"))) {
        recordInput(chunk, "reply");
        return;
      }
      const observedAt = now();
      let hasActivity = false;
      for (const byte of chunk) hasActivity = observeByte(byte) || hasActivity;
      if (hasActivity) lastActivity = observedAt;
      recordInput(chunk, null);
      scheduleQuiet();
    },
    offer(keystrokes: string): void {
      if (disposed || used || pending !== undefined) {
        recordState("offer", { accepted: false });
        return;
      }
      pending = keystrokes;
      recordState("offer", { accepted: true });
      scheduleQuiet();
    },
    dispose(): void {
      disposed = true;
      pending = undefined;
      clearTimer();
    },
  };
}

export interface PtyTarget {
  bin: string;
  args: string[];
}

export function ptyShimPath(pluginDir: string): string {
  return path.join(pluginDir, SHIM_FILE);
}

/**
 * Where the session file and the name the hook derives from the first prompt
 * live. Created 0700 on the way out, because what lands here is typed into a
 * live session and the shared temp directory is writable by anyone on the box.
 */
export function sessionsDir(): string {
  const dir = getPaths().sessionsDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const QUOTE = "'";
const ESCAPED_QUOTE = "'\\''";

function shellQuote(value: string): string {
  return QUOTE + value.replaceAll(QUOTE, ESCAPED_QUOTE) + QUOTE;
}

/**
 * `exec` keeps the shim as the pty's session leader, so nothing but the shim
 * and the harness sit between the terminal and Claude Code.
 */
export function buildInnerCommand(shim: string, target: PtyTarget, node: string = process.execPath): string {
  for (const part of [node, shim, target.bin]) {
    if (!SAFE_PATH.test(part)) {
      throw new Error(`pty: refusing to run a command with a control character in it: ${JSON.stringify(part)}`);
    }
  }
  return `exec ${[node, shim, target.bin, ...target.args].map(shellQuote).join(" ")}`;
}

/**
 * BSD and util-linux spell `script` differently, and only util-linux returns
 * the child's exit status (`-e`). On macOS the status comes back on its own.
 */
export function buildScriptInvocation(
  inner: string,
  platform: NodeJS.Platform = process.platform,
  bin: string = SCRIPT_BINARY,
): { bin: string; args: string[] } {
  if (platform === "darwin") return { bin, args: ["-q", "/dev/null", "/bin/sh", "-c", inner] };
  return { bin, args: ["-qefc", inner, "/dev/null"] };
}

/**
 * The absolute path of a binary on PATH, or nothing.
 *
 * Resolved rather than spawned by name so the session runs the `script` that
 * was checked, instead of whatever a PATH entry resolves to a moment later.
 */
export function findBinaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export function hasBinaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return findBinaryOnPath(name, env) !== undefined;
}

export interface PtyPreconditions {
  shim: string;
  enabled?: boolean;
  platform?: NodeJS.Platform;
  stdinIsTty?: boolean;
  stdoutIsTty?: boolean;
  env?: NodeJS.ProcessEnv;
  fileExists?: (file: string) => boolean;
  hasScript?: (env: NodeJS.ProcessEnv) => boolean;
}

/**
 * Why this session cannot run under a pty, or nothing. Every reason is a
 * fallback to the plain spawn rather than a failure: a session that opens
 * without renaming itself beats a session that does not open.
 */
export function ptyUnavailableReason(options: PtyPreconditions): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? ((file: string) => fs.existsSync(file));
  const hasScript = options.hasScript ?? ((value: NodeJS.ProcessEnv) => hasBinaryOnPath(SCRIPT_BINARY, value));

  if (options.enabled === false) return "disabled by configuration";
  if (platform === "win32") return "no script(1) on Windows";
  if (options.stdinIsTty !== true || options.stdoutIsTty !== true) return "not attached to a terminal";
  if (!hasScript(env)) return "script(1) not found on PATH";
  if (!fileExists(options.shim)) return `pty shim missing at ${options.shim}`;
  return undefined;
}

/**
 * `plugin/hooks/session-name.sh` writes the first prompt's slug next to the
 * session file. Watching for it keeps this side ignorant of Claude Code
 * internals: the hook decides the name, the wrapper only types it, once.
 *
 * Anything already sitting there belongs to a dead session: the watcher starts
 * before the harness does, and the hook only writes once a prompt is
 * submitted. The session file is named after a pid, which the kernel reuses,
 * so a leaked sidecar would otherwise have this session rename itself after
 * someone else's prompt. They are removed rather than read.
 */
export function watchNameSidecar(sessionFile: string, onName: (name: string) => void): () => void {
  const dir = path.dirname(sessionFile);
  const prefix = `${path.basename(sessionFile)}.`;
  let delivered = false;
  let watcher: fs.FSWatcher | undefined;

  const isSidecar = (file: string): boolean => file.startsWith(prefix) && file.endsWith(NAME_SUFFIX);

  const read = (file: string): void => {
    if (delivered || !isSidecar(file)) return;
    let name: string;
    try {
      // O_NOFOLLOW so a symlink planted under this name reads as nothing
      // rather than as whatever it points at. Belt to the directory's braces.
      const handle = fs.openSync(path.join(dir, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        name = fs.readFileSync(handle, "utf8");
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return;
    }
    if (name.trim().length === 0) return;
    delivered = true;
    onName(name);
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (isSidecar(file)) fs.rmSync(path.join(dir, file), { force: true });
    }
    watcher = fs.watch(dir, (_event, file) => {
      if (typeof file === "string") read(file);
    });
  } catch {
    // A watcher that cannot start costs the rename, never the session.
    return () => watcher?.close();
  }

  return () => {
    try {
      watcher?.close();
    } catch {}
  };
}

export interface PtyLaunch {
  shim: string;
  sessionFile: string;
  /** Keystrokes for the name the harness's hook derived, or nothing to skip. */
  keystrokesForName?: (name: string) => string | undefined;
}

export interface PtyStartOptions {
  target: PtyTarget;
  launch: PtyLaunch;
  cwd: string;
  env: NodeJS.ProcessEnv;
  debugFile?: string;
  spawnChild?: typeof nodeSpawn;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /**
   * Called for every Ctrl+C typed. Raw mode means the terminal no longer turns
   * that key into a signal for anyone up here, so the escape hatch that kills
   * a wedged harness has to be fed from the keystroke itself.
   */
  onInterrupt?: () => void;
}

export interface PtySession {
  child: ChildProcess;
  inject: (keystrokes: string) => void;
  dispose: () => void;
}

export function startPtySession(options: PtyStartOptions): PtySession {
  const startedAt = process.hrtime.bigint();
  const debugFile = options.debugFile ?? process.env.CODEDECK_PTY_DEBUG;
  let traceFd: number | undefined;
  const closeTrace = (): void => {
    if (traceFd === undefined) return;
    try {
      fs.closeSync(traceFd);
    } catch {}
    traceFd = undefined;
  };
  const spawnChild = options.spawnChild ?? nodeSpawn;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  // In the private directory rather than the shared one: a peer that can
  // connect to this socket can resize the session's terminal.
  const control = path.join(sessionsDir(), `codedeck-pty-${process.pid}-${Date.now().toString(36)}.sock`);
  // A terminal that reports 0 is a terminal whose size nobody set: passing the
  // zero down would leave the inner pty exactly as unusable as script leaves it.
  const rows = stdout.rows || FALLBACK_ROWS;
  const columns = stdout.columns || FALLBACK_COLUMNS;

  const invocation = buildScriptInvocation(
    buildInnerCommand(options.launch.shim, options.target),
    process.platform,
    findBinaryOnPath(SCRIPT_BINARY, options.env) ?? SCRIPT_BINARY,
  );
  const child = spawnChild(invocation.bin, invocation.args, {
    cwd: options.cwd,
    env: {
      ...options.env,
      [CONTROL_ENV]: control,
      [ROWS_ENV]: String(rows),
      [COLS_ENV]: String(columns),
    },
    // stdout is piped rather than inherited because the pty merges the
    // harness's stderr into it, and that is where an entitlement refusal is
    // read off. Bytes are written through untouched.
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (debugFile && path.isAbsolute(debugFile)) {
    try {
      traceFd = fs.openSync(
        debugFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NONBLOCK,
        0o600,
      );
      if (!fs.fstatSync(traceFd).isFile()) closeTrace();
      else fs.fchmodSync(traceFd, 0o600);
    } catch {
      closeTrace();
    }
  }
  const trace = traceFd === undefined
    ? undefined
    : (event: Record<string, unknown>): void => {
        if (traceFd === undefined) return;
        try {
          const t = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
          fs.writeSync(traceFd, `${JSON.stringify({ ...event, t })}\n`);
        } catch {
          closeTrace();
        }
      };

  // Raw mode makes the parent a transparent wire: Ctrl+C stops being a signal
  // here and becomes the byte the inner pty's line discipline interprets,
  // exactly as it would in a terminal talking to Claude Code directly.
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  // A write to a pipe whose reader died raises EPIPE asynchronously, and an
  // unhandled one takes the CLI down before it can print the farewell. The
  // window is small — script gone, `close` not yet fired — and real: a
  // keystroke lands in it whenever a session dies under someone's hands.
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});

  const write = (chunk: Buffer | string): void => {
    if (child.stdin?.writable !== true) return;
    child.stdin.write(chunk);
  };

  const inject = (keystrokes: string): void => {
    write(keystrokes);
  };
  const gate = createInputGate({ inject, trace });

  const forward = (chunk: Buffer): void => {
    gate.observe(chunk);
    if (options.onInterrupt && chunk.includes(INTERRUPT_KEY)) options.onInterrupt();
    write(chunk);
  };
  stdin.on("data", forward);
  stdin.resume();

  // The shim binds the socket a moment after the pty exists, and a lost
  // connection costs a redraw rather than the session.
  let connection: net.Socket | undefined;
  // Sent on connect as well as on resize: a resize that lands before the shim
  // is listening would otherwise be dropped, leaving the harness drawing at
  // the size it booted with until the next one.
  const sendResize = (): void => {
    connection?.write(`${JSON.stringify({ type: "resize", rows: stdout.rows, cols: stdout.columns })}\n`);
  };
  stdout.on("resize", sendResize);

  let connecting = true;
  const connect = (attempt = 0): void => {
    if (!connecting) return;
    const socket = net.connect(control);
    socket.on("connect", () => {
      connecting = false;
      connection = socket;
      sendResize();
    });
    socket.on("error", () => {
      socket.destroy();
      if (attempt < 60) setTimeout(() => connect(attempt + 1), 50).unref();
    });
  };
  connect();

  const keystrokesForName = options.launch.keystrokesForName;
  const stopWatching = keystrokesForName
    ? watchNameSidecar(options.launch.sessionFile, (name) => {
        trace?.({ kind: "sidecar", name });
        const keystrokes = keystrokesForName(name);
        if (keystrokes) gate.offer(keystrokes);
      })
    : () => {};

  const dispose = (): void => {
    connecting = false;
    gate.dispose();
    stopWatching();
    stdout.off("resize", sendResize);
    stdin.off("data", forward);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
    connection?.destroy();
    closeTrace();
    try {
      fs.rmSync(control, { force: true });
    } catch {}
  };

  return { child, inject, dispose };
}
