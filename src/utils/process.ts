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

// Fixed absolute candidates for systemd-inhibit. PATH-based lookup (which(1))
// lets a writable directory shadow the binary (typescript:S4036); callers
// MUST use this instead of which()/spawn-with-bare-name for inhibit.
const INHIBIT_BIN_CANDIDATES = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"];

export function resolveInhibitBin(): string | null {
  for (const candidate of INHIBIT_BIN_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

// Fixed absolute candidates for systemd-run. Same rule as inhibit: never
// PATH lookup (typescript:S4036); callers MUST use this instead of
// which()/spawn-with-bare-name for scoping.
const SYSTEMD_RUN_CANDIDATES = ["/usr/bin/systemd-run", "/bin/systemd-run"];

export function resolveSystemdRunBin(): string | null {
  for (const candidate of SYSTEMD_RUN_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

// Reachability of the per-user manager. systemd-run fails AFTER the spawn
// when it is down, so check the socket synchronously instead of probing
// with a throwaway unit per worker launch.
export function systemdUserManagerSocket(): string | null {
  try {
    if (typeof process.getuid !== "function") return null;
    const sock = `/run/user/${process.getuid()}/systemd/private`;
    return fs.existsSync(sock) ? sock : null;
  } catch {
    return null;
  }
}

const DEFAULT_SCOPE_MEMORY_MAX = "4G";
const DEFAULT_SCOPE_SWAP_MAX = "0";
// Uppercase only: systemd rejects lowercase suffixes ("Failed to parse
// MemoryMax= value '4g'"), and rejects MemoryMax=0 ("out of range") while
// MemorySwapMax=0 is valid (disables swap). Anything failing here falls
// back to the default, so one env typo warns nowhere but breaks nothing.
const MEM_SIZE_PATTERN = /^\d+(\.\d+)?[KMGTPE]?$/;

export function scopeLimits(
  overrides?: { memoryMax?: string; swapMax?: string },
  env: NodeJS.ProcessEnv = process.env,
): { memoryMax: string; swapMax: string } {
  const pick = (
    explicit: string | undefined,
    envKey: string,
    fallback: string,
    allowZero: boolean,
  ): string => {
    const v = (explicit ?? "").trim() || (env[envKey] ?? "").trim();
    if (!MEM_SIZE_PATTERN.test(v)) return fallback;
    // A Docker-trained hand reads 0 as "unlimited"; systemd reads it as an
    // error on the memory side. Fall back instead of failing every spawn.
    if (!allowZero && Number.parseFloat(v) === 0) return fallback;
    return v;
  };
  return {
    memoryMax: pick(overrides?.memoryMax, "CODEDECK_WORKER_MEMORY_MAX", DEFAULT_SCOPE_MEMORY_MAX, false),
    swapMax: pick(overrides?.swapMax, "CODEDECK_WORKER_SWAP_MAX", DEFAULT_SCOPE_SWAP_MAX, true),
  };
}

export interface ScopedSpawnRequest {
  cmd: string;
  args: string[];
  description?: string;
  memoryMax?: string;
  swapMax?: string;
}

export interface ScopedSpawnDeps {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  systemdRunBin?: string | null;
  userManagerReachable?: boolean;
}

// Wraps a spawn in a sibling transient scope:
//   systemd-run --user --scope --quiet -p MemoryMax=… -p MemorySwapMax=… -- <cmd> <args>
// The child lands in app.slice/run-*.scope, a SIBLING of the terminal scope,
// so an oomd kill takes only the worker. Verified: pid/pgid/exit-code/signal
// all behave as a direct spawn (systemd-run execs into the unit), and
// --quiet keeps the "Running as unit" banner out of the worker's stderr log.
// Returns null when scoping is unavailable — callers MUST fall back to a
// plain spawn (containers, macOS, no user manager, CODEDECK_NO_SCOPE=1).
export function buildScopedSpawn(
  req: ScopedSpawnRequest,
  deps?: ScopedSpawnDeps,
): { cmd: string; args: string[] } | null {
  if ((deps?.platform ?? process.platform) !== "linux") return null;
  const env = deps?.env ?? process.env;
  if ((env.CODEDECK_NO_SCOPE ?? "") === "1") return null;
  const bin = deps?.systemdRunBin !== undefined ? deps.systemdRunBin : resolveSystemdRunBin();
  if (!bin) return null;
  const reachable =
    deps?.userManagerReachable !== undefined
      ? deps.userManagerReachable
      : systemdUserManagerSocket() !== null;
  if (!reachable) return null;
  const limits = scopeLimits({ memoryMax: req.memoryMax, swapMax: req.swapMax }, env);
  const args = [
    "--user",
    "--scope",
    "--quiet",
    "-p",
    `MemoryMax=${limits.memoryMax}`,
    "-p",
    `MemorySwapMax=${limits.swapMax}`,
  ];
  if (req.description) args.push(`--description=${req.description}`);
  args.push("--", req.cmd, ...req.args);
  return { cmd: bin, args };
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
