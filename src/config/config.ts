import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./paths.js";
import type { AgentId } from "../core/session.js";

export interface RunAgentConfig {
  defaultAgent?: AgentId;
  worktree?: boolean;
  defaultModel?: string;
}

const DEFAULT_CONFIG: RunAgentConfig = {
  defaultAgent: "claude",
  worktree: false,
};

export function loadConfig(): RunAgentConfig {
  const { configFile } = getPaths();
  try {
    if (!fs.existsSync(configFile)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(raw) as RunAgentConfig;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: RunAgentConfig): void {
  const { configFile } = getPaths();
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf-8");
}
