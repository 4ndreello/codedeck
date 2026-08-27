import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SpawnResult {
  proc: ChildProcess;
  pid?: number;
}

export function spawnHarness(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return proc;
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

export function createLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError?: (err: Error) => void,
): () => void {
  let buf = "";
  const handler = (chunk: Buffer | string) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          onLine(line);
        } catch (e) {
          onError?.(e as Error);
        }
      }
    }
  };
  (stream as NodeJS.EventEmitter).on("data", handler);
  const cleanup = () => {
    (stream as NodeJS.EventEmitter).off("data", handler);
    if (buf.trim()) {
      try {
        onLine(buf.trim());
      } catch {}
    }
  };
  return cleanup;
}

export function safeJsonParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
