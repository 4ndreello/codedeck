import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./paths.js";
import { isAgentId, type AgentId } from "../core/session.js";
import { parseSandbox } from "../core/driver.js";
import type { CodexSandbox } from "../core/driver.js";
import type { Role } from "../core/roles.js";
import type { OrchestratorMode } from "./orchestrator-mode.js";

export {
  BALANCED_PRESET,
  DISPATCHER_PRESET,
  EXPLORER_PRESET,
  ORCHESTRATOR_PRESETS,
  isOrchestratorMode,
  orchestratorModeLabel,
  resolveOrchestratorMode,
} from "./orchestrator-mode.js";
export type {
  InvestigateMode,
  OrchestratorMode,
  OrchestratorModeLabel,
  OrchestratorTools,
  SelfWorkMode,
} from "./orchestrator-mode.js";

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
  remoteControl?: boolean;
  defaultSandbox?: CodexSandbox;
  /**
   * Run interactive sessions under a pty CodeDeck owns, which is what lets it
   * type harness commands — today the `/rename` that names a Claude Code
   * session after the first prompt. Defaults to true; unset it to keep the
   * plain spawn.
   */
  pty?: boolean;
  /**
   * Per harness, and the fallback for whatever `agents` does not answer: a run
   * with no role, or one whose role nobody bound. Setup no longer writes it.
   */
  models?: Partial<Record<AgentId, string>>;
  agents?: Partial<Record<Role, RoleBinding>>;
  orchestrator?: OrchestratorMode;
}

/**
 * A saved binding is only usable whole. A half-written entry (a harness with
 * no model, or the reverse) resolves to nothing rather than to a guess, so the
 * caller falls back the same way it would for a role nobody configured.
 *
 * The file is JSON someone can edit, and the cast in `loadConfig` believes
 * whatever it finds, so the harness is checked against the four CodeDeck
 * drives. Without that, `{"harness":"wat"}` reached the daemon as an agent id
 * and died there instead of falling back here.
 */
export function resolveRoleBinding(
  role: Role | undefined,
  config: RunAgentConfig = {},
): RoleBinding | undefined {
  if (role === undefined) return undefined;
  const binding = config.agents?.[role];
  if (!binding || !isAgentId(binding.harness)) return undefined;
  if (typeof binding.model !== "string" || binding.model.trim() === "") return undefined;
  return { harness: binding.harness, model: binding.model };
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

/**
 * Resolve a hand-edited sandbox value without allowing an invalid value to
 * reach a driver. An invalid value is treated as absent, so the driver keeps
 * its own fallback.
 */
export function resolveDefaultSandbox(config: RunAgentConfig = {}): CodexSandbox | undefined {
  try {
    const value = config?.defaultSandbox;
    return typeof value === "string" ? parseSandbox(value) : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_CONFIG: RunAgentConfig = {
  defaultAgent: "claude",
  worktree: false,
  remoteControl: true,
  pty: true,
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
