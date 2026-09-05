import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function getHomeDir(): string {
  return os.homedir();
}

export function getRunAgentDir(): string {
  // Allow override via env for testing
  if (process.env.RUN_AGENT_DIR) return process.env.RUN_AGENT_DIR;
  // Respect XDG_DATA_HOME if set, otherwise ~/.run-agent as per spec
  // Spec says ~/.run-agent, we honor that
  return path.join(getHomeDir(), ".run-agent");
}

export function getConfigDir(): string {
  if (process.env.RUN_AGENT_CONFIG_DIR) return process.env.RUN_AGENT_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "run-agent");
  return path.join(getHomeDir(), ".config", "run-agent");
}

export function getPaths() {
  const base = getRunAgentDir();
  const configBase = getConfigDir();
  return {
    base,
    db: path.join(base, "run-agent.db"),
    daemonSock: path.join(base, "daemon.sock"),
    daemonPid: path.join(base, "daemon.pid"),
    daemonLog: path.join(base, "daemon.log"),
    logsDir: path.join(base, "logs"),
    worktreesDir: path.join(base, "worktrees"),
    cacheDir: path.join(base, "cache"),
    modelsCache: path.join(base, "cache", "models.json"),
    configFile: path.join(configBase, "config.json"),
  };
}

export function ensureDirs(): void {
  const p = getPaths();
  for (const dir of [p.base, p.logsDir, p.worktreesDir, p.cacheDir, path.dirname(p.configFile)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
