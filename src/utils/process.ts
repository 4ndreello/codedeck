import { spawn, type ChildProcess, execSync } from "node:child_process";

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
}

export function which(cmd: string): string | null {
  try {
    const out = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim();
    return out || null;
  } catch { return null; }
}

export async function detectBinary(cmd: string): Promise<{ installed: boolean; path?: string; version?: string }> {
  const path = which(cmd);
  if (!path) return { installed: false };
  let version: string | undefined;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync(cmd, ["--version"], { timeout: 5000 });
      version = stdout.trim().split("\n")[0].slice(0, 100);
    } catch {
      try {
        const { stdout } = await execFileAsync(cmd, ["--help"], { timeout: 5000 });
        version = stdout.trim().split("\n")[0].slice(0, 100);
      } catch {}
    }
  } catch {}
  return { installed: true, path, version };
}
