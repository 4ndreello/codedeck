import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

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
const CONTROL_ENV = "CODEDECK_PTY_CONTROL";
const ROWS_ENV = "CODEDECK_PTY_ROWS";
const COLS_ENV = "CODEDECK_PTY_COLS";
const NAME_SUFFIX = ".name";
const FALLBACK_ROWS = 24;
const FALLBACK_COLUMNS = 80;

export interface PtyTarget {
  bin: string;
  args: string[];
}

export function ptyShimPath(pluginDir: string): string {
  return path.join(pluginDir, SHIM_FILE);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `exec` keeps the shim as the pty's session leader, so nothing but the shim
 * and the harness sit between the terminal and Claude Code.
 */
export function buildInnerCommand(shim: string, target: PtyTarget, node: string = process.execPath): string {
  return `exec ${[node, shim, target.bin, ...target.args].map(shellQuote).join(" ")}`;
}

/**
 * BSD and util-linux spell `script` differently, and only util-linux returns
 * the child's exit status (`-e`). On macOS the status comes back on its own.
 */
export function buildScriptInvocation(
  inner: string,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } {
  if (platform === "darwin") return { bin: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", inner] };
  return { bin: "script", args: ["-qefc", inner, "/dev/null"] };
}

export function hasBinaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    try {
      fs.accessSync(path.join(entry, name), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
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
  const hasScript = options.hasScript ?? ((value: NodeJS.ProcessEnv) => hasBinaryOnPath("script", value));

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
 */
export function watchNameSidecar(sessionFile: string, onName: (name: string) => void): () => void {
  const dir = path.dirname(sessionFile);
  const prefix = `${path.basename(sessionFile)}.`;
  let delivered = false;
  let watcher: fs.FSWatcher | undefined;

  const read = (file: string): void => {
    if (delivered || !file.startsWith(prefix) || !file.endsWith(NAME_SUFFIX)) return;
    let name: string;
    try {
      name = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      return;
    }
    if (name.trim().length === 0) return;
    delivered = true;
    onName(name);
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) read(file);
    if (delivered) return () => {};
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
  const control = path.join(os.tmpdir(), `codedeck-pty-${process.pid}-${Date.now().toString(36)}.sock`);
  // A terminal that reports 0 is a terminal whose size nobody set: passing the
  // zero down would leave the inner pty exactly as unusable as script leaves it.
  const rows = stdout.rows || FALLBACK_ROWS;
  const columns = stdout.columns || FALLBACK_COLUMNS;

  const invocation = buildScriptInvocation(buildInnerCommand(options.launch.shim, options.target));
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
  const forward = (chunk: Buffer): void => {
    child.stdin?.write(chunk);
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
    child.stdin?.write(keystrokes);
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
