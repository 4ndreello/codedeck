import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

export function getHomeDir(): string {
  return os.homedir();
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

export function getCodedeckDir(): string {
  // Allow override via env for testing
  if (nonEmpty(process.env.CODEDECK_DIR)) return path.resolve(process.env.CODEDECK_DIR);
  // Respect XDG_DATA_HOME if set, otherwise ~/.codedeck as per spec
  // Spec says ~/.codedeck, we honor that
  return path.resolve(getHomeDir(), ".codedeck");
}

export function getConfigDir(): string {
  if (nonEmpty(process.env.CODEDECK_CONFIG_DIR)) {
    return path.resolve(process.env.CODEDECK_CONFIG_DIR);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (nonEmpty(xdg)) return path.resolve(xdg, "codedeck");
  return path.resolve(getHomeDir(), ".config", "codedeck");
}

export function hasConfigOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return nonEmpty(env.CODEDECK_CONFIG_DIR) || nonEmpty(env.XDG_CONFIG_HOME);
}

export function getLegacyConfigFile(): string {
  return path.resolve(getHomeDir(), ".codedeck", "config.json");
}

// Node's IPC server on Windows is a named pipe, which must live under
// \\.\pipe\; a filesystem path fails to listen. Derive the pipe name from
// the data dir so CODEDECK_DIR overrides (tests, parallel installs) still get
// their own daemon.
export function daemonSocketPath(base: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path.join(base, "daemon.sock");
  const id = createHash("sha256").update(base.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\codedeck-${id}`;
}

export function getPaths() {
  const base = getCodedeckDir();
  const configBase = getConfigDir();
  return {
    base,
    db: path.join(base, "codedeck.db"),
    daemonSock: daemonSocketPath(base),
    daemonPid: path.join(base, "daemon.pid"),
    daemonLock: path.join(base, "daemon.lock"),
    daemonLog: path.join(base, "daemon.log"),
    logsDir: path.join(base, "logs"),
    worktreesDir: path.join(base, "worktrees"),
    cacheDir: path.join(base, "cache"),
    // Per-session scratch: the session id a hook reports, and the name it
    // derives from the first prompt. It lives here rather than in the shared
    // temp directory because `open` types what it finds there into a live
    // session, and on Linux anyone on the box can write to /tmp.
    sessionsDir: path.join(base, "sessions"),
    modelsCache: path.join(base, "cache", "models.json"),
    configFile: path.resolve(configBase, "config.json"),
    legacyConfigFile: getLegacyConfigFile(),
  };
}

export function ensureDirs(): void {
  const p = getPaths();
  for (const dir of [p.base, p.logsDir, p.worktreesDir, p.cacheDir, path.dirname(p.configFile)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Narrower than the rest on purpose: what lands here is typed into a
  // session, so only its owner may put anything in it.
  fs.mkdirSync(p.sessionsDir, { recursive: true, mode: 0o700 });
}
