import type { BatchModelsResult, HarnessModels } from "../core/models.js";
import type { AgentId } from "../core/session.js";
import type { Role } from "../core/roles.js";
import type { RoleBinding, RunAgentConfig } from "./config.js";
import type { OrchestratorMode } from "./orchestrator-mode.js";

export class SetupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupUsageError";
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SetupEnvelope {
  proposta: RunAgentConfig | null;
  validacoes: {
    config: {
      status: "not-run" | "ok" | "missing" | "invalid";
      source: "none" | "canonical" | "legacy";
      path: string;
      message: string | null;
    };
    catalogo: {
      status: "not-needed" | "fresh" | "offline" | "unavailable";
      source: "none" | "cache" | "network" | "stale-cache";
      ageMs: number | null;
      message: string | null;
    };
    bindings: Array<{
      role: Role;
      harness: AgentId;
      model: string;
      status: "accepted" | "unknown-model" | "harness-unavailable" | "unverified";
      message: string;
    }>;
  };
  mudancas: Array<{
    path: string;
    beforePresent: boolean;
    before: JsonValue;
    afterPresent: boolean;
    after: JsonValue;
  }>;
  resultado: {
    status: "applied" | "dry-run" | "unchanged" | "aborted" | "error";
    code: 0 | 1 | 2 | 10 | 11 | 12 | 13 | 14 | 15 | 130;
    saved: boolean;
    message: string;
  };
}

export interface SetupBinding {
  role: Role;
  binding: RoleBinding;
}

export interface SetupSelection {
  agents: Partial<Record<Role, RoleBinding>>;
  orchestrator?: OrchestratorMode;
  sandbox?: RunAgentConfig["defaultSandbox"];
  autocompact?: RunAgentConfig["autocompact"];
  offCatalogConfirmed?: Partial<Record<Role, boolean>>;
}

export interface SetupPlanResult {
  proposedConfig: RunAgentConfig;
  diff: SetupEnvelope["mudancas"];
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (jsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, jsonValue(value[key])]),
    ) as { [key: string]: JsonValue };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(jsonValue(left)) === JSON.stringify(jsonValue(right));
}

function pointerPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diffAt(
  output: SetupEnvelope["mudancas"],
  pathValue: string,
  beforePresent: boolean,
  before: unknown,
  afterPresent: boolean,
  after: unknown,
  expandObjectChildren = false,
): void {
  const beforeObject = beforePresent && jsonObject(before) ? before : undefined;
  const afterObject = afterPresent && jsonObject(after) ? after : undefined;
  if (beforeObject !== undefined && afterObject !== undefined) {
    const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])]
      .sort((left, right) => left.localeCompare(right));
    if (keys.length === 0) return;
    for (const key of keys) {
      diffAt(
        output,
        pathValue + "/" + pointerPart(key),
        Object.hasOwn(beforeObject, key),
        beforeObject[key],
        Object.hasOwn(afterObject, key),
        afterObject[key],
      );
    }
    return;
  }
  if (!beforePresent && afterObject !== undefined) {
    if (expandObjectChildren) {
      const keys = Object.keys(afterObject).sort((left, right) => left.localeCompare(right));
      if (keys.length === 0) {
        output.push({
          path: pathValue,
          beforePresent: false,
          before: null,
          afterPresent: true,
          after: jsonValue(afterObject),
        });
        return;
      }
      for (const key of keys) {
        const value = afterObject[key];
        const childPath = pathValue + "/" + pointerPart(key);
        if (jsonObject(value)) {
          output.push({
            path: childPath,
            beforePresent: false,
            before: null,
            afterPresent: true,
            after: jsonValue(value),
          });
        } else {
          diffAt(output, childPath, false, undefined, true, value);
        }
      }
      return;
    }
    output.push({
      path: pathValue,
      beforePresent: false,
      before: null,
      afterPresent: true,
      after: jsonValue(afterObject),
    });
    return;
  }
  if (beforeObject !== undefined && !afterPresent) {
    if (expandObjectChildren) {
      const keys = Object.keys(beforeObject).sort((left, right) => left.localeCompare(right));
      if (keys.length === 0) {
        output.push({
          path: pathValue,
          beforePresent: true,
          before: jsonValue(beforeObject),
          afterPresent: false,
          after: null,
        });
        return;
      }
      for (const key of keys) {
        const value = beforeObject[key];
        const childPath = pathValue + "/" + pointerPart(key);
        if (jsonObject(value)) {
          output.push({
            path: childPath,
            beforePresent: true,
            before: jsonValue(value),
            afterPresent: false,
            after: null,
          });
        } else {
          diffAt(output, childPath, true, value, false, undefined);
        }
      }
      return;
    }
    output.push({
      path: pathValue,
      beforePresent: true,
      before: jsonValue(beforeObject),
      afterPresent: false,
      after: null,
    });
    return;
  }
  if (beforePresent === afterPresent && (!beforePresent || jsonEqual(before, after))) return;
  output.push({
    path: pathValue,
    beforePresent,
    before: jsonValue(before),
    afterPresent,
    after: jsonValue(after),
  });
}

export function diffConfig(before: RunAgentConfig, after: RunAgentConfig): SetupEnvelope["mudancas"] {
  const output: SetupEnvelope["mudancas"] = [];
  const beforeObject = jsonObject(before) ? before : {};
  const afterObject = jsonObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])]
    .sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    diffAt(
      output,
      "/" + pointerPart(key),
      Object.hasOwn(beforeObject, key),
      beforeObject[key],
      Object.hasOwn(afterObject, key),
      afterObject[key],
      true,
    );
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

export function catalogContains(catalog: HarnessModels, model: string): boolean {
  return catalog.providers.some((provider) =>
    provider.models.some(
      (candidate) =>
        candidate.id === model || (candidate.aliases !== undefined && candidate.aliases.some((alias) => alias === model)),
    ),
  );
}

export type BindingValidation = SetupEnvelope["validacoes"]["bindings"][number];

export function validateBindings(
  bindings: readonly SetupBinding[],
  catalog: BatchModelsResult,
): { entries: BindingValidation[]; code?: 11 | 12 | 13; message: string | null } {
  const byAgent = new Map(catalog.models.map((item) => [item.agent, item]));
  const entries: BindingValidation[] = bindings.map(({ role, binding }) => {
    const found = byAgent.get(binding.harness);
    if (found?.available === false) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "harness-unavailable",
        message:
          'Cannot apply binding for role "' + role + '": harness "' + binding.harness + '" is unavailable.',
      };
    }
    if (catalog.status === "unavailable" || found === undefined) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "unverified",
        message:
          'Cannot validate model "' +
          binding.model +
          '" for harness "' +
          binding.harness +
          '": catalog unavailable.',
      };
    }
    if (catalog.status === "offline" && !catalogContains(found, binding.model)) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "unverified",
        message:
          'Cannot validate model "' +
          binding.model +
          '" for harness "' +
          binding.harness +
          '": the catalog is stale. Re-run with --refresh.',
      };
    }
    if (!catalogContains(found, binding.model)) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "unknown-model",
        message:
          'Model "' +
          binding.model +
          '" is not in the ' +
          binding.harness +
          ' catalog for role "' +
          role +
          '".',
      };
    }
    return { role, harness: binding.harness, model: binding.model, status: "accepted", message: "" };
  });

  const failed = entries.find((entry) => entry.status !== "accepted");
  const code = failed === undefined
    ? undefined
    : failed.status === "harness-unavailable"
      ? 11
      : failed.status === "unknown-model"
        ? 12
        : 13;
  let message: string | null = null;
  if (catalog.status === "offline") {
    message = failed?.status === "unverified" ? failed.message : "Catalog is stale; using offline cache.";
  } else if (catalog.status === "unavailable") {
    message = failed?.message ?? "Catalog unavailable.";
  }
  return { entries, code, message };
}

export function buildSetupPlan(
  currentConfig: RunAgentConfig,
  selections: SetupSelection,
): SetupPlanResult {
  const currentAgents = jsonObject(currentConfig.agents)
    ? currentConfig.agents as Partial<Record<Role, RoleBinding>>
    : {};
  const updatedTarget: RunAgentConfig = {
    ...currentConfig,
    agents: { ...currentAgents, ...selections.agents },
  };
  if (selections.orchestrator !== undefined) {
    updatedTarget.orchestrator = {
      investigate: selections.orchestrator.investigate,
      selfWork: selections.orchestrator.selfWork,
      tools: selections.orchestrator.tools,
      ...(selections.orchestrator.parallelism === undefined
        ? {}
        : { parallelism: selections.orchestrator.parallelism }),
    };
  }
  if (selections.sandbox !== undefined) updatedTarget.defaultSandbox = selections.sandbox;
  if (selections.autocompact !== undefined) {
    if (selections.autocompact.enabled !== false || currentConfig.autocompact !== undefined) {
      updatedTarget.autocompact = { ...currentConfig.autocompact, ...selections.autocompact };
    }
  }

  return { proposedConfig: updatedTarget, diff: diffConfig(currentConfig, updatedTarget) };
}
