import type { RunAgentConfig } from "./config.js";

export type InvestigateMode = "none" | "read" | "free";
export type SelfWorkMode = "none" | "trivial" | "small";
export type OrchestratorTools = "dispatch" | "read" | "edit";

export interface OrchestratorMode {
  investigate: InvestigateMode;
  selfWork: SelfWorkMode;
  tools: OrchestratorTools;
  parallelism?: number;
}

export type OrchestratorModeLabel = "dispatcher" | "balanced" | "explorer" | "custom";

export const DISPATCHER_PRESET = Object.freeze({
  investigate: "none",
  selfWork: "none",
  tools: "dispatch",
} satisfies OrchestratorMode);

export const BALANCED_PRESET = Object.freeze({
  investigate: "read",
  selfWork: "trivial",
  tools: "edit",
} satisfies OrchestratorMode);

export const EXPLORER_PRESET = Object.freeze({
  investigate: "free",
  selfWork: "small",
  tools: "edit",
} satisfies OrchestratorMode);

export const ORCHESTRATOR_PRESETS = Object.freeze({
  dispatcher: DISPATCHER_PRESET,
  balanced: BALANCED_PRESET,
  explorer: EXPLORER_PRESET,
});

const INVESTIGATE_MODES: readonly InvestigateMode[] = ["none", "read", "free"];
const SELF_WORK_MODES: readonly SelfWorkMode[] = ["none", "trivial", "small"];
const ORCHESTRATOR_TOOLS: readonly OrchestratorTools[] = ["dispatch", "read", "edit"];

function hasOwn(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

export function isOrchestratorMode(value: unknown): value is OrchestratorMode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (!INVESTIGATE_MODES.includes(candidate.investigate as InvestigateMode)) return false;
  if (!SELF_WORK_MODES.includes(candidate.selfWork as SelfWorkMode)) return false;
  if (!ORCHESTRATOR_TOOLS.includes(candidate.tools as OrchestratorTools)) return false;

  if (!hasOwn(candidate, "parallelism")) return true;
  return typeof candidate.parallelism === "number" && Number.isFinite(candidate.parallelism) && candidate.parallelism > 0;
}

function copyMode(mode: OrchestratorMode): OrchestratorMode {
  return {
    investigate: mode.investigate,
    selfWork: mode.selfWork,
    tools: mode.tools,
    ...(hasOwn(mode, "parallelism") ? { parallelism: mode.parallelism } : {}),
  };
}

export function resolveOrchestratorMode(config: RunAgentConfig = {}): OrchestratorMode {
  const configured = config.orchestrator;
  if (!isOrchestratorMode(configured)) return copyMode(DISPATCHER_PRESET);
  return copyMode(configured);
}

function matchesPreset(mode: OrchestratorMode, preset: OrchestratorMode): boolean {
  const sameParallelism =
    hasOwn(mode, "parallelism") === hasOwn(preset, "parallelism") &&
    (!hasOwn(mode, "parallelism") || mode.parallelism === preset.parallelism);

  return (
    mode.investigate === preset.investigate &&
    mode.selfWork === preset.selfWork &&
    mode.tools === preset.tools &&
    sameParallelism
  );
}

export function orchestratorModeLabel(mode: OrchestratorMode): OrchestratorModeLabel {
  if (matchesPreset(mode, DISPATCHER_PRESET)) return "dispatcher";
  if (matchesPreset(mode, BALANCED_PRESET)) return "balanced";
  if (matchesPreset(mode, EXPLORER_PRESET)) return "explorer";
  return "custom";
}
