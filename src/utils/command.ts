import fs from "node:fs";
import path from "node:path";

// Cross-platform command lookup and spawn targets.
//
// POSIX resolves a bare name through PATH with an executable bit. Windows has
// no `which`, no executable bit, and finds programs by trying every PATHEXT
// extension in each PATH directory. npm installs a global CLI there as
// `claude.cmd` (plus an extensionless POSIX `claude` shell script that Windows
// cannot run), and Node refuses to spawn a .cmd/.bat without a shell
// (EINVAL since the CVE-2024-27980 fix). Every harness lookup and spawn goes
// through this module so all of that is handled in one place.

export type CommandFs = Pick<typeof fs, "statSync" | "accessSync" | "readFileSync" | "existsSync">;

export interface CommandEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  // Seam for tests that exercise Windows lookups on a POSIX host.
  fs?: CommandFs;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isWindows(opts?: CommandEnv): boolean {
  return (opts?.platform ?? process.platform) === "win32";
}

function pathApi(opts?: CommandEnv): path.PlatformPath {
  return isWindows(opts) ? path.win32 : path.posix;
}

// Windows env names are case-insensitive, but a spread copy of process.env
// is a plain object: read "Path" as well as "PATH".
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = envValue(env, "PATHEXT") || DEFAULT_PATHEXT;
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
}

function isRunnableFile(candidate: string, opts?: CommandEnv): boolean {
  const io = opts?.fs ?? fs;
  try {
    if (!io.statSync(candidate).isFile()) return false;
    // Windows has no executable bit; the extension decides runnability.
    if (!isWindows(opts)) io.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Candidate file names for one base path. On Windows a name that already
// carries a PATHEXT extension is tried as is; otherwise only the PATHEXT
// spellings are tried, never the bare name, so npm's extensionless POSIX
// shim next to `claude.cmd` is skipped exactly as cmd.exe skips it.
function candidates(base: string, opts?: CommandEnv): string[] {
  if (!isWindows(opts)) return [base];
  const exts = windowsExtensions(opts?.env ?? process.env);
  const ext = path.win32.extname(base).toLowerCase();
  if (ext && exts.includes(ext)) return [base];
  return exts.map((e) => base + e);
}

/**
 * Resolve a command to an absolute runnable file, like `which` on POSIX and
 * `where` on Windows. A name containing a path separator is resolved against
 * the cwd instead of PATH. Returns undefined when nothing runnable is found.
 */
export function resolveCommand(command: string, opts?: CommandEnv): string | undefined {
  if (!command) return undefined;
  const windows = isWindows(opts);
  const p = pathApi(opts);
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();

  const hasSeparator = command.includes("/") || (windows && command.includes("\\"));
  if (hasSeparator || p.isAbsolute(command)) {
    const base = p.resolve(cwd, command);
    return candidates(base, opts).find((c) => isRunnableFile(c, opts));
  }

  const dirs = (envValue(env, "PATH") ?? "").split(p.delimiter);
  // cmd.exe searches the current directory first; spawn/CreateProcess does
  // not, and a planted claude.cmd in a repo must never win. Skip it.
  for (const dir of dirs) {
    const clean = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!clean) continue;
    const base = p.resolve(cwd, clean, command);
    const hit = candidates(base, opts).find((c) => isRunnableFile(c, opts));
    if (hit) return hit;
  }
  return undefined;
}

export interface SpawnTarget {
  cmd: string;
  args: string[];
  // Set when cmd.exe parses the line: Node must not re-quote it.
  windowsVerbatimArguments?: boolean;
}

// npm's cmd-shim ends with: "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
// (older shims spell it "%~dp0\..."). Capture the target relative to the shim.
const CMD_SHIM_TARGET = /"%(?:~?dp0)%?\\([^"]+)"\s+%\*/i;

/**
 * For an npm cmd-shim, the file it launches. Running that directly keeps
 * prompts away from cmd.exe, which truncates arguments at a newline and
 * expands `%VAR%` and `^` inside them.
 */
export function unwrapCmdShim(
  shimPath: string,
  opts?: CommandEnv,
): { cmd: string; prefix: string[] } | undefined {
  const io = opts?.fs ?? fs;
  let text: string;
  try {
    text = String(io.readFileSync(shimPath, "utf8"));
  } catch {
    return undefined;
  }
  const match = CMD_SHIM_TARGET.exec(text);
  if (!match) return undefined;
  const target = path.win32.resolve(path.win32.dirname(shimPath), match[1]);
  if (!io.existsSync(target)) return undefined;
  if (/\.(c|m)?js$/i.test(target)) {
    // The shim prefers a node.exe that sits next to it.
    const localNode = path.win32.join(path.win32.dirname(shimPath), "node.exe");
    return { cmd: io.existsSync(localNode) ? localNode : process.execPath, prefix: [target] };
  }
  if (/\.(exe|com)$/i.test(target)) return { cmd: target, prefix: [] };
  return undefined;
}

// cmd.exe metacharacters, escaped with ^ (same set as cross-spawn).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  // CommandLineToArgvW quoting first, then cmd.exe caret escaping.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return doubleEscape ? quoted.replace(CMD_META, "^$1") : quoted;
}

/**
 * How to spawn `command` with `args` on this platform. POSIX passes through.
 * Windows resolves PATHEXT (so `claude` becomes `...\npm\claude.cmd`), runs
 * an npm shim's real target directly, and only falls back to cmd.exe, with
 * its quoting, for a batch file it cannot unwrap.
 */
export function spawnTarget(command: string, args: string[], opts?: CommandEnv): SpawnTarget {
  if (!isWindows(opts)) return { cmd: command, args };
  const resolved = resolveCommand(command, opts) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { cmd: resolved, args };

  const shim = unwrapCmdShim(resolved, opts);
  if (shim) return { cmd: shim.cmd, args: [...shim.prefix, ...args] };

  const env = opts?.env ?? process.env;
  const comspec = envValue(env, "COMSPEC") || "cmd.exe";
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [resolved.replace(CMD_META, "^$1"), ...args.map((a) => escapeCmdArgument(a, doubleEscape))].join(" ");
  return {
    cmd: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * An installer's fixed location (`~/.local/bin/agy`, `~/.opencode/bin/opencode`).
 * POSIX keeps the plain existence check; Windows also tries the PATHEXT
 * spellings, because the installer writes `agy.exe`, not `agy`.
 */
export function findLocalBinary(file: string, opts?: CommandEnv): string | undefined {
  if (!isWindows(opts)) return (opts?.fs ?? fs).existsSync(file) ? file : undefined;
  return resolveCommand(file, opts);
}
