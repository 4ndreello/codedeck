import fs from "node:fs";
import path from "node:path";
import { resolveModel, resolveRoleBinding, type RunAgentConfig } from "../config/config.js";
import { findClosestModel, modelNames, type HarnessModels } from "../core/models.js";
import type { AgentId } from "../core/session.js";
import { roleBody, roleFile, type Role } from "../core/roles.js";

export type ModelVerdict =
  | { kind: "ok" }
  | { kind: "unknown-catalog"; warning: string }
  | { kind: "rejected"; error: string };

export interface OpenFlags {
  model?: string;
  effort?: string;
  resume?: string;
  worktree?: boolean;
  bypass?: boolean;
  theme?: boolean;
}

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

/**
 * What the catalog can say about a model. Reachable is not the same as allowed:
 * the catalog lists what a harness knows about, never what this account may
 * use, so an entitlement problem only surfaces at launch.
 */
export const catalogWarning = (harnessName: string, model: string, state: string): string =>
  `Warning: ${harnessName} model catalog is ${state}; continuing with "${model}".`;

/**
 * Pure so all three outcomes are testable without touching the disk cache or
 * spawning a harness. Takes the already-filtered catalog: finding it is the
 * launcher's job, judging it is identical everywhere.
 */
export function judgeModelIn(
  catalog: HarnessModels | undefined,
  model: string,
  fromConfig: boolean,
  harnessName: string,
): ModelVerdict {
  const keepGoing = (reason: string): ModelVerdict => ({
    kind: "unknown-catalog",
    warning: catalogWarning(harnessName, model, `unavailable${reason}`),
  });

  if (!catalog || !catalog.available || catalog.error) {
    return keepGoing(catalog?.error ? ` (${catalog.error})` : "");
  }

  const candidates = modelNames(catalog);
  if (candidates.length === 0) {
    return { kind: "unknown-catalog", warning: catalogWarning(harnessName, model, "empty") };
  }

  if (candidates.includes(model)) return { kind: "ok" };

  const suggestion = findClosestModel(model, candidates);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : " No close model was found.";
  // A model can leave the catalog on its own, with nobody having typed it
  // wrong, and `needsModelSetup` never asks again, so the way out has to be
  // spelled out.
  const recovery = fromConfig ? " Run `codedeck setup` to pick another." : "";
  return { kind: "rejected", error: `Model "${model}" is not in the ${harnessName} catalog.${hint}${recovery}` };
}
