import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

/**
 * Extracts and parses JSON even if output contains banners (e.g. from mise, asdf, shell inits)
 * before or after the JSON payload.
 */
export function extractCleanJson<T>(raw: string): T {
  const trimmed = raw.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed) as T;
  } catch {}

  // Look for JSON object or array candidates
  const startCandidates: { idx: number; char: string }[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{" || ch === "[") {
      startCandidates.push({ idx: i, char: ch });
    }
  }

  // First pass: look for balanced JSON structures by scanning forward with a bracket stack
  for (const { idx } of startCandidates) {
    const stack: string[] = [];
    let inString = false;
    let escape = false;

    for (let i = idx; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        if (inString) escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (c === "{" || c === "[") {
        stack.push(c);
      } else if (c === "}" || c === "]") {
        if (stack.length === 0) break;
        const top = stack[stack.length - 1];
        if ((c === "}" && top === "{") || (c === "]" && top === "[")) {
          stack.pop();
          if (stack.length === 0) {
            const candidate = trimmed.slice(idx, i + 1);
            try {
              return JSON.parse(candidate) as T;
            } catch {}
            break;
          }
        } else {
          break; // Mismatched brackets
        }
      }
    }
  }

  // Second pass fallback: lastIndexOf
  for (const { idx, char } of startCandidates) {
    const closingChar = char === "{" ? "}" : "]";
    const lastIdx = trimmed.lastIndexOf(closingChar);
    if (lastIdx > idx) {
      const candidate = trimmed.slice(idx, lastIdx + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {}
    }
  }

  throw new Error(`Failed to locate valid JSON envelope in CLI output: ${trimmed.slice(0, 100)}`);
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export async function runCommandWithTimeout(
  cmd: string,
  args: string[],
  opts?: RunCommandOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts?.cwd ?? os.tmpdir(),
    timeout: opts?.timeoutMs ?? 10000,
    maxBuffer: opts?.maxBuffer ?? 10 * 1024 * 1024,
    env: {
      ...process.env,
      MISE_QUIET: "1",
      NO_COLOR: "1",
      CI: "1",
      ...opts?.env,
    },
  });
  return stdout;
}

