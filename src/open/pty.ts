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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

  const forward = (chunk: Buffer): void => {
    if (options.onInterrupt && chunk.includes(INTERRUPT_KEY)) options.onInterrupt();
    write(chunk);
  };
  stdin.on("data", forward);
  stdin.resume();

  // The shim binds the socket a moment after the pty exists, and a lost
  // connection costs a redraw rather than the session.
  let connection: net.Socket | undefined;
  let connecting = true;
  const connect = (attempt = 0): void => {
    if (!connecting) return;
    const socket = net.connect(control);
    socket.on("connect", () => {
      connecting = false;
      connection = socket;
    });
    socket.on("error", () => {
      socket.destroy();
      if (attempt < 60) setTimeout(() => connect(attempt + 1), 50).unref();
    });
  };
  connect();

  const sendResize = (): void => {
    connection?.write(`${JSON.stringify({ type: "resize", rows: stdout.rows, cols: stdout.columns })}\n`);
  };
  stdout.on("resize", sendResize);

  const inject = (keystrokes: string): void => {
    write(keystrokes);
  };

  const keystrokesForName = options.launch.keystrokesForName;
  const stopWatching = keystrokesForName
    ? watchNameSidecar(options.launch.sessionFile, (name) => {
        const keystrokes = keystrokesForName(name);
        if (keystrokes) inject(keystrokes);
      })
    : () => {};

  const dispose = (): void => {
    connecting = false;
    stopWatching();
    stdout.off("resize", sendResize);
    stdin.off("data", forward);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
    connection?.destroy();
    try {
      fs.rmSync(control, { force: true });
    } catch {}
  };

  return { child, inject, dispose };
}
