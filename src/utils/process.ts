import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
}

export function which(cmd: string): string | null {
  try {
    const out = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Linux exposes a monotonic process start tick in /proc/<pid>/stat. Persisting
// it beside the PID closes the reuse race: after a daemon restart, a recycled
// PID is not mistaken for the harness that CodeDeck launched.
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) return undefined;
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    // The slice starts at field 3 (state); starttime is field 22.
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

// Harnesses run detached in their own process group, so signal the GROUP:
// they spawn children of their own (omp sub-agents) that must die with them.
// If an expected start time is supplied, refuse to signal a recycled PID.
export async function killTree(pid: number, graceMs = 3000, expectedStartTime?: string): Promise<void> {
  const matchesExpectedLeader = (): boolean => {
    if (expectedStartTime === undefined) return true;
    const current = processStartTime(pid);
    return current !== undefined && current === expectedStartTime;
  };
  let groupSignaled = false;
  const canSignalGroup = (): boolean =>
    matchesExpectedLeader() || (!processAlive(pid) && processGroupAlive(pid));
  const signal = (sig: NodeJS.Signals, allowGroupAfterLeaderExit = false): boolean => {
    if (!allowGroupAfterLeaderExit && !canSignalGroup()) return false;
    try {
      process.kill(-pid, sig);
      if (sig === "SIGTERM") groupSignaled = true;
      return true;
    } catch {
      if (allowGroupAfterLeaderExit) return false;
      // The group may disappear between the group signal and this fallback.
      // Recheck identity immediately before signaling a positive PID.
      if (!matchesExpectedLeader()) return false;
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!signal("SIGTERM")) return;

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const leaderAlive = processAlive(pid);
    const groupAlive = processGroupAlive(pid);
    if (!leaderAlive && !groupAlive) break;
    if (leaderAlive && !matchesExpectedLeader()) break;
    await sleep(150);
  }

  // If TERM let the leader exit but a sub-process remains in its original
  // group, escalate the already-signaled group. Do not guess at a new PID.
  if (processGroupAlive(pid) && (groupSignaled || expectedStartTime === undefined)) {
    signal("SIGKILL", true);
  } else if (processAlive(pid) && matchesExpectedLeader()) {
    signal("SIGKILL");
  }
  // Settle window so a follow-up start() doesn't race the dying process.
  await sleep(100);
}

export async function detectBinary(cmd: string): Promise<{ installed: boolean; path?: string; version?: string }> {
  const path = which(cmd);
  if (!path) return { installed: false };
  let version: string | undefined;
  try {
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
