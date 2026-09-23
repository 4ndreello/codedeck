import type { IncomingMessage, ServerResponse } from "node:http";
import type { DriverRegistry } from "../core/driver.js";
import { REASONING_EFFORTS } from "../core/driver.js";
import { getBatchModels, type BatchModelsOptions, type BatchModelsResult } from "../core/models.js";
import { isAgentId, type AgentId } from "../core/session.js";
import { ROLES, type Role } from "../core/roles.js";
import {
  DEFAULT_CONFIG,
  readConfigForSetup,
  saveConfig,
  serializeConfig,
  type RoleBinding,
  type RunAgentConfig,
  type SetupConfigRead,
} from "../config/config.js";
import { isOrchestratorMode } from "../config/orchestrator-mode.js";
import {
  buildSetupPlan,
  catalogContains,
  resolveSetupTarget,
  validateBindings,
  type BindingValidation,
  type SetupBinding,
  type SetupEnvelope,
  type SetupSelection,
} from "../config/setup.js";
import { getPaths } from "../config/paths.js";
import { getRegistry } from "../drivers/registry.js";
import { SETUP_PAGE } from "./setup-page.js";
import type { WebRoute } from "./server.js";

const MAX_SETUP_BODY_BYTES = 64 * 1024;
const MODEL_PATTERN = /^[^\p{White_Space}\p{Cc}\p{Cf}=]+$/u;

export interface SetupRoutesDependencies {
  profile?: string;
  readConfig?: () => SetupConfigRead;
  saveConfig?: (config: RunAgentConfig) => void | boolean;
  registry?: DriverRegistry;
  getBatchModels?: (options: BatchModelsOptions) => Promise<BatchModelsResult>;
  configPath?: () => string;
}

interface LoadedSetup {
  read: SetupConfigRead;
  current: RunAgentConfig;
  target: ReturnType<typeof resolveSetupTarget>;
  state: BuiltSetupState;
}

interface ReadProblem {
  read: SetupConfigRead;
  code: 14 | 15;
  message: string;
}

type ReadResult = { loaded: LoadedSetup } | { problem: ReadProblem };

export interface BuiltSetupState {
  resolvedTarget: ReturnType<typeof resolveSetupTarget>;
  target: { kind: "global" | "profile"; profile?: string };
  bindings: Partial<Record<Role, RoleBinding>>;
  efforts: Partial<Record<Role, string>>;
  orchestrator?: RunAgentConfig["orchestrator"];
  sandbox?: RunAgentConfig["defaultSandbox"];
  autocompact?: RunAgentConfig["autocompact"];
}

interface ParsedBody {
  ok: boolean;
  value?: unknown;
  message?: string;
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentConfigPath(dependencies: SetupRoutesDependencies): string {
  return dependencies.configPath?.() ?? getPaths().configFile;
}

function setupReadProblem(
  read: SetupConfigRead,
  dependencies: SetupRoutesDependencies,
  thrown?: unknown,
): ReadProblem | undefined {
  if (thrown !== undefined) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    return {
      read: {
        status: "invalid",
        source: "none",
        path: currentConfigPath(dependencies),
        config: null,
        raw: null,
        message: error.message,
        readError: error,
      },
      code: 15,
      message: `Cannot save config "${currentConfigPath(dependencies)}": ${error.message}.`,
    };
  }
  if (read.status !== "invalid") return undefined;
  if (read.readError) {
    return {
      read,
      code: 15,
      message: `Cannot save config "${currentConfigPath(dependencies)}": ${read.message ?? read.readError.message}.`,
    };
  }
  return {
    read,
    code: 14,
    message: read.message ?? `Config file "${read.path}" contains invalid JSON; no changes were written. Repair or move it and retry.`,
  };
}

export function buildSetupState(read: SetupConfigRead, profileOption?: string): BuiltSetupState {
  if (read.status === "invalid") {
    throw new Error(read.message ?? `Config file "${read.path}" could not be read.`);
  }
  const current: RunAgentConfig = { ...DEFAULT_CONFIG, ...(read.config ?? {}) };
  const resolvedTarget = resolveSetupTarget(current, profileOption);
  const bindings = resolvedTarget.config.agents ?? {};
  const efforts = Object.fromEntries(ROLES.flatMap((role) => {
    const effort = bindings[role]?.effort;
    return effort === undefined ? [] : [[role, effort]];
  })) as Partial<Record<Role, string>>;
  return {
    resolvedTarget,
    target: {
      kind: resolvedTarget.profile === undefined ? "global" : "profile",
      ...(resolvedTarget.profile === undefined ? {} : { profile: resolvedTarget.profile }),
    },
    bindings,
    efforts,
    ...(resolvedTarget.config.orchestrator === undefined ? {} : { orchestrator: resolvedTarget.config.orchestrator }),
    ...(resolvedTarget.config.defaultSandbox === undefined ? {} : { sandbox: resolvedTarget.config.defaultSandbox }),
    ...(resolvedTarget.config.autocompact === undefined ? {} : { autocompact: resolvedTarget.config.autocompact }),
  };
}

function readAndResolve(dependencies: SetupRoutesDependencies): ReadResult {
  let read: SetupConfigRead;
  try {
    read = (dependencies.readConfig ?? readConfigForSetup)();
  } catch (error) {
    const problem = setupReadProblem({
      status: "invalid",
      source: "none",
      path: currentConfigPath(dependencies),
      config: null,
      raw: null,
      message: errorMessage(error),
    }, dependencies, error);
    return { problem: problem! };
  }

  const problem = setupReadProblem(read, dependencies);
  if (problem) return { problem };

  const current: RunAgentConfig = { ...DEFAULT_CONFIG, ...(read.config ?? {}) };
  try {
    const state = buildSetupState(read, dependencies.profile);
    return { loaded: { read, current, target: state.resolvedTarget, state } };
  } catch (error) {
    return {
      problem: {
        read,
        code: 14,
        message: errorMessage(error),
      },
    };
  }
}

function configValidation(read: SetupConfigRead): SetupEnvelope["validacoes"]["config"] {
  return {
    status: read.status,
    source: read.source,
    path: read.path,
    message: read.status === "invalid" ? read.message : null,
  };
}

function noCatalog(): SetupEnvelope["validacoes"]["catalogo"] {
  return { status: "not-needed", source: "none", ageMs: null, message: null };
}

function catalogValidation(
  catalog: BatchModelsResult | undefined,
  message: string | null,
): SetupEnvelope["validacoes"]["catalogo"] {
  if (!catalog) return noCatalog();
  return {
    status: catalog.status,
    source: catalog.source,
    ageMs: catalog.ageMs,
    message,
  };
}

function emptyEnvelope(read: SetupConfigRead, code: 14 | 15, message: string): SetupEnvelope {
  return {
    proposta: null,
    validacoes: {
      config: configValidation(read),
      catalogo: noCatalog(),
      bindings: [],
    },
    mudancas: [],
    resultado: { status: "error", code, saved: false, message },
  };
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function isRoleBinding(value: unknown): value is RoleBinding {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["harness", "model", "effort"]) ||
    !isAgentId(value.harness) ||
    typeof value.model !== "string" ||
    !MODEL_PATTERN.test(value.model)
  ) {
    return false;
  }
  return value.effort === undefined || (REASONING_EFFORTS as readonly string[]).includes(value.effort as string);
}

export function isSetupSelection(value: unknown): value is SetupSelection {
  if (!isObject(value)) return false;
  const allowedKeys = ["agents", "orchestrator", "sandbox", "autocompact", "offCatalogConfirmed"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return false;
  if (!isObject(value.agents)) return false;
  if (Object.entries(value.agents).some(([role, binding]) => !isRole(role) || !isRoleBinding(binding))) return false;
  if (value.orchestrator !== undefined) {
    if (!isObject(value.orchestrator) || !hasOnlyKeys(value.orchestrator, ["investigate", "selfWork", "tools", "parallelism"])) {
      return false;
    }
    if (!isOrchestratorMode(value.orchestrator)) return false;
  }
  if (
    value.sandbox !== undefined &&
    value.sandbox !== "workspace-write" &&
    value.sandbox !== "danger-full-access"
  ) return false;
  if (value.autocompact !== undefined) {
    if (!isObject(value.autocompact) || !hasOnlyKeys(value.autocompact, ["enabled"]) || typeof value.autocompact.enabled !== "boolean") {
      return false;
    }
  }
  if (value.offCatalogConfirmed !== undefined) {
    if (!isObject(value.offCatalogConfirmed)) return false;
    if (Object.entries(value.offCatalogConfirmed).some(([role, confirmed]) => !isRole(role) || typeof confirmed !== "boolean")) {
      return false;
    }
  }
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_SETUP_BODY_BYTES) {
        oversized = true;
        continue;
      }
      chunks.push(buffer);
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  if (oversized) return { ok: false, message: "Setup request body exceeds 64 KiB." };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, message: "Setup request body must be valid JSON." };
  }
}

function changedBindings(
  targetBindings: Partial<Record<Role, RoleBinding>> | undefined,
  selection: SetupSelection,
): SetupBinding[] {
  const current = targetBindings ?? {};
  return ROLES.flatMap((role) => {
    const binding = selection.agents[role];
    if (!binding) return [];
    const previous = current[role];
    if (previous?.harness === binding.harness && previous.model === binding.model) return [];
    return [{ role, binding }];
  });
}

function catalogFailure(error: unknown): BatchModelsResult {
  return {
    models: [],
    status: "unavailable",
    source: "none",
    ageMs: null,
    discoveryError: errorMessage(error),
    cacheWriteFailed: false,
  };
}

function errorCodeFor(entries: BindingValidation[]): 11 | 12 | 13 | undefined {
  const failed = entries.find((entry) => entry.status !== "accepted");
  if (!failed) return undefined;
  if (failed.status === "harness-unavailable") return 11;
  if (failed.status === "unknown-model") return 12;
  return 13;
}

function bindingMessage(entries: BindingValidation[]): string | undefined {
  return entries.find((entry) => entry.status !== "accepted")?.message;
}

function confirmedOffCatalog(
  entry: BindingValidation,
  selection: SetupSelection,
  catalog: BatchModelsResult,
): boolean {
  if (!selection.offCatalogConfirmed?.[entry.role]) return false;
  if (entry.status !== "unknown-model" && entry.status !== "unverified") return false;
  const harness = catalog.models.find((candidate) => candidate.agent === entry.harness);
  return harness?.available === true && !catalogContains(harness, entry.model);
}

interface BindingValidationResult {
  catalog?: BatchModelsResult;
  entries: BindingValidation[];
  code?: 11 | 12 | 13;
  message: string | null;
}

export function createSetupRoutes(dependencies: SetupRoutesDependencies = {}): WebRoute[] {
  const loadCatalog = dependencies.getBatchModels ?? ((options: BatchModelsOptions) =>
    getBatchModels(dependencies.registry ?? getRegistry(), options));
  let refreshInFlight: Promise<BatchModelsResult> | undefined;

  function refreshCatalog(): Promise<BatchModelsResult> {
    if (refreshInFlight) return refreshInFlight;
    const pending = loadCatalog({ refresh: true, allowNetwork: true, timeoutMs: 12_000 });
    const inFlight = pending.finally(() => {
      if (refreshInFlight === inFlight) refreshInFlight = undefined;
    });
    refreshInFlight = inFlight;
    return inFlight;
  }

  async function validateChanged(
    bindings: SetupBinding[],
    selection: SetupSelection,
    allowConfirmation: boolean,
  ): Promise<BindingValidationResult> {
    if (bindings.length === 0) return { entries: [], message: null };
    let catalog: BatchModelsResult;
    try {
      catalog = await loadCatalog({
        agents: [...new Set(bindings.map(({ binding }) => binding.harness))] as AgentId[],
        allowNetwork: false,
      });
    } catch (error) {
      catalog = catalogFailure(error);
    }
    const validation = validateBindings(bindings, catalog);
    const entries = validation.entries.map((entry) =>
      allowConfirmation && confirmedOffCatalog(entry, selection, catalog)
        ? { ...entry, status: "accepted" as const, message: "" }
        : entry,
    );
    const code = errorCodeFor(entries);
    const message = bindingMessage(entries) ?? validation.message;
    return { catalog, entries, code, message };
  }

  function method(request: IncomingMessage, response: ServerResponse, expected: string): boolean {
    if (request.method === expected) return true;
    response.writeHead(405, { Allow: expected, "content-type": "text/plain; charset=utf-8" });
    response.end("method not allowed");
    return false;
  }

  function page(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SETUP_PAGE);
  }

  function stateRoute(_request: IncomingMessage, response: ServerResponse): void {
    const result = readAndResolve(dependencies);
    if ("problem" in result) {
      jsonResponse(response, 500, { error: result.problem.message, code: result.problem.code });
      return;
    }
    const { read, state } = result.loaded;
    jsonResponse(response, 200, {
      config: { status: read.status, source: read.source, path: read.path },
      target: state.target,
      bindings: state.bindings,
      efforts: state.efforts,
      ...(state.orchestrator === undefined ? {} : { orchestrator: state.orchestrator }),
      ...(state.sandbox === undefined ? {} : { sandbox: state.sandbox }),
      ...(state.autocompact === undefined ? {} : { autocompact: state.autocompact }),
    });
  }

  async function catalogRoute(_request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const catalog = await loadCatalog({ allowNetwork: false });
      jsonResponse(response, 200, catalog);
    } catch (error) {
      jsonResponse(response, 500, { error: errorMessage(error) });
    }
  }

  async function refreshRoute(_request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      jsonResponse(response, 200, await refreshCatalog());
    } catch (error) {
      jsonResponse(response, 500, { error: errorMessage(error) });
    }
  }

  async function mutationRoute(
    request: IncomingMessage,
    response: ServerResponse,
    dryRun: boolean,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok || !isSetupSelection(body.value)) {
      jsonResponse(response, 400, { error: body.message ?? "Setup request body has an invalid shape." });
      return;
    }
    const selection = body.value;
    const result = readAndResolve(dependencies);
    if ("problem" in result) {
      jsonResponse(response, 500, emptyEnvelope(result.problem.read, result.problem.code, result.problem.message));
      return;
    }

    const { read, current, target } = result.loaded;
    const plan = buildSetupPlan(current, target, selection);
    const changed = changedBindings(target.config.agents, selection);
    let validation: BindingValidationResult;
    try {
      validation = await validateChanged(changed, selection, !dryRun);
    } catch (error) {
      validation = {
        catalog: catalogFailure(error),
        entries: changed.map(({ role, binding }) => ({
          role,
          harness: binding.harness,
          model: binding.model,
          status: "unverified",
          message: errorMessage(error),
        })),
        code: 13,
        message: errorMessage(error),
      };
    }
    const validations: SetupEnvelope["validacoes"] = {
      config: configValidation(read),
      catalogo: catalogValidation(validation.catalog, validation.message),
      bindings: validation.entries,
    };

    if (validation.code !== undefined) {
      const failed = bindingMessage(validation.entries) ?? validation.message ?? "Setup validation failed.";
      jsonResponse(response, 422, {
        proposta: plan.proposedConfig,
        validacoes: validations,
        mudancas: plan.diff,
        resultado: { status: "error", code: validation.code, saved: false, message: failed },
      } satisfies SetupEnvelope);
      return;
    }

    if (plan.diff.length === 0) {
      jsonResponse(response, 200, {
        proposta: plan.proposedConfig,
        validacoes: validations,
        mudancas: plan.diff,
        resultado: { status: "unchanged", code: 0, saved: false, message: "Configuration unchanged." },
      } satisfies SetupEnvelope);
      return;
    }

    if (dryRun) {
      jsonResponse(response, 200, {
        proposta: plan.proposedConfig,
        validacoes: validations,
        mudancas: plan.diff,
        resultado: { status: "dry-run", code: 0, saved: false, message: "Dry run; configuration not written." },
      } satisfies SetupEnvelope);
      return;
    }

    const serialized = serializeConfig(plan.proposedConfig);
    if (read.source === "canonical" && read.raw === serialized) {
      jsonResponse(response, 200, {
        proposta: plan.proposedConfig,
        validacoes: validations,
        mudancas: [],
        resultado: { status: "unchanged", code: 0, saved: false, message: "Configuration unchanged." },
      } satisfies SetupEnvelope);
      return;
    }

    try {
      const saved = (dependencies.saveConfig ?? saveConfig)(plan.proposedConfig);
      if (saved === false) {
        jsonResponse(response, 200, {
          proposta: plan.proposedConfig,
          validacoes: validations,
          mudancas: [],
          resultado: { status: "unchanged", code: 0, saved: false, message: "Configuration unchanged." },
        } satisfies SetupEnvelope);
        return;
      }
    } catch (error) {
      const message = `Cannot save config "${currentConfigPath(dependencies)}": ${errorMessage(error)}.`;
      jsonResponse(response, 500, {
        proposta: plan.proposedConfig,
        validacoes: validations,
        mudancas: plan.diff,
        resultado: { status: "error", code: 15, saved: false, message },
      } satisfies SetupEnvelope);
      return;
    }

    jsonResponse(response, 200, {
      proposta: plan.proposedConfig,
      validacoes: validations,
      mudancas: plan.diff,
      resultado: { status: "applied", code: 0, saved: true, message: "Configuration saved." },
    } satisfies SetupEnvelope);
  }

  const route = (
    path: string,
    kind: WebRoute["kind"],
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
    label?: string,
  ): WebRoute => ({ path, kind, handler, ...(label === undefined ? {} : { label }) });

  return [
    route("/setup", "page", page, "Setup"),
    route("/api/setup/state", "api", (request, response) => {
      if (method(request, response, "GET")) stateRoute(request, response);
    }),
    route("/api/setup/catalog", "api", (request, response) => {
      if (method(request, response, "GET")) void catalogRoute(request, response);
    }),
    route("/api/setup/catalog/refresh", "api", (request, response) => {
      if (method(request, response, "POST")) void refreshRoute(request, response);
    }),
    route("/api/setup/dry-run", "api", (request, response) => {
      if (method(request, response, "POST")) void mutationRoute(request, response, true);
    }),
    route("/api/setup/apply", "api", (request, response) => {
      if (method(request, response, "POST")) void mutationRoute(request, response, false);
    }),
  ];
}
