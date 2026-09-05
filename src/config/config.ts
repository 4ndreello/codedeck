import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./paths.js";
import type { AgentId } from "../core/session.js";
import type { Role } from "../core/roles.js";

/**
 * Which harness runs a role, and on which model. Both halves are one answer:
 * a model id means nothing without the harness that lists it, and two
 * harnesses can list the same id.
 */
export interface RoleBinding {
  harness: AgentId;
  model: string;
}

export interface RunAgentConfig {
  defaultAgent?: AgentId;
  worktree?: boolean;
  defaultModel?: string;
  /**
   * Per harness, for a run that names no role. `agents` supersedes this for
   * anything that does, and setup no longer writes it.
   */
  models?: Partial<Record<AgentId, string>>;
  agents?: Partial<Record<Role, RoleBinding>>;
}

/**
 * A saved binding is only usable whole. A half-written entry (a harness with
 * no model, or the reverse) resolves to nothing rather than to a guess, so the
 * caller falls back the same way it would for a role nobody configured.
 */
export function resolveRoleBinding(
  role: Role | undefined,
  config: RunAgentConfig = {},
): RoleBinding | undefined {
  if (role === undefined) return undefined;
  const binding = config.agents?.[role];
  if (!binding || !binding.harness || !binding.model) return undefined;
  return binding;
}

/**
 * Resolve the model passed to a driver without making driver defaults part of
 * CodeDeck's config. An undefined result lets the selected driver choose its
 * own default.
 */
export function resolveModel(
  agent: AgentId,
  explicit?: string,
  config: RunAgentConfig = {},
): string | undefined {
  return explicit ?? config.models?.[agent] ?? config.defaultModel;
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
