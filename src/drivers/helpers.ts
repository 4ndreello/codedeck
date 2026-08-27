import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DetachedSpawn {
  proc: ChildProcess;
  // Sizes of the log files captured BEFORE the harness could write: the
  // tailer starts exactly where the previous turn's output ended.
  stdoutOffset: number;
  stderrOffset: number;
}

// Spawn the harness DETACHED with stdout/stderr in FILES instead of pipes.
// This is the codedeck equivalent of the operator's `nohup … > file`:
// - `detached` gives the child its own process group, so it survives the
//   daemon (and anything that kills the daemon's group);
// - file output has no reader to lose — a restarting daemon cannot EPIPE the
//   child, and cannot apply pipe backpressure that freezes it;
// - the output stays on disk, so the next daemon reattaches by tailing the
//   same files from a persisted offset.
export function spawnDetached(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
}): DetachedSpawn {
  fs.mkdirSync(path.dirname(opts.stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(opts.stderrPath), { recursive: true });
  const sizeOf = (p: string): number => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  const stdoutOffset = sizeOf(opts.stdoutPath);
  const stderrOffset = sizeOf(opts.stderrPath);

  const out = fs.openSync(opts.stdoutPath, "a");
  const err = fs.openSync(opts.stderrPath, "a");
  try {
    const proc = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      // stdin is "ignore", never a closed pipe: a closed pipe works for some
      // harnesses (they read EOF) but an OPEN one hangs forever waiting for
      // input that never comes. "ignore" removes the whole failure class.
      stdio: ["ignore", out, err],
    });
    return { proc, stdoutOffset, stderrOffset };
  } finally {
    try {
      fs.closeSync(out);
    } catch {}
    try {
      fs.closeSync(err);
    } catch {}
  }
}

export async function detectBinary(
  cmd: string,
  versionArgs: string[] = ["--version"],
): Promise<{ installed: boolean; path?: string; version?: string; error?: string }> {
  try {
    const { stdout: whichOut } = await execFileAsync("which", [cmd]);
    const path = whichOut.trim();
    if (!path) return { installed: false };
    let version: string | undefined;
    try {
      const { stdout } = await execFileAsync(cmd, versionArgs, { timeout: 5000 });
      version = stdout.trim().split("\n")[0].slice(0, 200);
    } catch {
      try {
        const { stdout } = await execFileAsync(cmd, ["--help"], { timeout: 5000 });
        version = stdout.trim().split("\n")[0].slice(0, 200);
      } catch (e) {
        version = undefined;
      }
    }
    return { installed: true, path, version };
  } catch (e) {
    // Try command -v fallback
    try {
      const { stdout } = await execFileAsync("bash", ["-lc", `command -v ${cmd}`], { timeout: 3000 });
      if (stdout.trim()) {
        return { installed: true, path: stdout.trim(), version: undefined };
      }
    } catch {}
    return { installed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function safeJsonParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
