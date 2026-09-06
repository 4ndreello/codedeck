import fs from "node:fs";
import path from "node:path";
import { resolveModel, resolveRoleBinding, type RunAgentConfig } from "../config/config.js";
import type { AgentId } from "../core/session.js";
import { roleBody, roleFile, type Role } from "../core/roles.js";

export const DEFAULT_OPEN_MODEL = "claude-opus-4-8";

export interface OpenModelInput {
  model?: string;
  passthroughModel?: string;
}

/**
 * The prompt half of a role: the agent body without frontmatter plus the
 * shared ultra text. Identical for every harness; only the delivery differs
 * (Claude flags vs opencode inline config).
 */
export function resolveRoleContract(
  pluginDir: string,
  role: Role,
): { agentBody: string; ultra: string } {
  const file = roleFile(pluginDir, role);
  if (!fs.existsSync(file)) {
    throw new Error(`Role "${role}" has no agent file at ${file}. The CodeDeck plugin is incomplete.`);
  }
  const ultraFile = path.join(pluginDir, "ultra.md");
  if (!fs.existsSync(ultraFile)) {
    throw new Error(`CodeDeck ultra prompt not found at ${ultraFile}. The CodeDeck plugin is incomplete.`);
  }
  return {
    agentBody: roleBody(pluginDir, role),
    ultra: fs.readFileSync(ultraFile, "utf8"),
  };
}

/**
 * Which model an open launches with. An explicit flag wins over the binding,
 * like today; without either, the binding harness (or claude) answers from
 * config, or stays undefined for the launcher default.
 */
export function resolveOpenModel(
  role: Role,
  opts: OpenModelInput,
  config: RunAgentConfig = {},
): { model: string | undefined; fromConfig: boolean } {
  const binding = resolveRoleBinding(role, config);
  const harness: AgentId = binding?.harness ?? "claude";
  const configured = binding?.model ?? resolveModel(harness, undefined, config);
  return {
    model: opts.model ?? configured,
    fromConfig: opts.model === undefined && opts.passthroughModel === undefined && configured !== undefined,
  };
}

const MODEL_PREFIX = "--model=";

/**
 * Claude honours the last --model on the line and the passthrough is appended
 * last, so `open --model bad -- --model good` really launches "good". Checking
 * anything but the last one grounds a launch that would have worked.
 *
 * Only the passthrough is scanned, never the built vector. That vector always
 * opens with a --model pair, so scanning it could never answer "the passthrough
 * overrode nothing", and a bare "--model" swallowed as another flag's value (as
 * in `open --resume --model`) would be read as a model of its own.
 *
 * Known limit: a literal "--model" passed as the value of one of Claude's own
 * flags still reads as an override. Telling that apart needs Claude's option
 * arity, which CodeDeck does not have.
 */
export function effectiveModel(passthrough: string[]): string | undefined {
  for (let i = passthrough.length - 1; i >= 0; i--) {
    const token = passthrough[i];
    if (token.startsWith(MODEL_PREFIX)) return token.slice(MODEL_PREFIX.length);
    if (i > 0 && passthrough[i - 1] === "--model") return token;
  }
}
