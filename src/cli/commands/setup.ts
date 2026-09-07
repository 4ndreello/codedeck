import type { Command } from "commander";
import {
  AUTOCOMPACT_DEFAULT_CAP,
  AUTOCOMPACT_DEFAULT_PERCENT,
} from "../../core/autocompact.js";
import type { DriverRegistry } from "../../core/driver.js";
import {
  getBatchModels,
  getCachedOrDiscoverModels,
  type BatchDiscovery,
  type HarnessModels,
} from "../../core/models.js";
import { isAgentId, type AgentId } from "../../core/session.js";
import { itemKey, type PickerItem, type Screen, type ScreenResult } from "../picker-state.js";
import { runScreens } from "../picker.js";
import { colors, readDimensions, type Dimensions } from "../ui.js";
import { getCliName } from "../cli-name.js";
import { getRegistry } from "../../drivers/registry.js";
import { ROLES, type Role } from "../../core/roles.js";
import { getPaths } from "../../config/paths.js";
import {
  BALANCED_PRESET,
  DISPATCHER_PRESET,
  EXPLORER_PRESET,
  ORCHESTRATOR_PRESETS,
  createSetupConfigStore,
  DEFAULT_CONFIG,
  isOrchestratorMode,
  loadConfig,
  orchestratorModeLabel,
  resolveOrchestratorMode,
  saveConfig,
  serializeConfig,
  type SetupConfigRead,
  type SetupConfigStore,
  type InvestigateMode,
  type OrchestratorMode,
  type OrchestratorTools,
  type RoleBinding,
  type RunAgentConfig,
  type SelfWorkMode,
} from "../../config/config.js";

const ORCHESTRATOR_SCREEN_ROLE = "orchestrator-mode";
const ORCHESTRATOR_PICKER_GROUP = "orchestrator";
const PARALLELISM_NONE = "none";
const SANDBOX_SCREEN_ROLE = "sandbox";
const SANDBOX_PICKER_GROUP = "sandbox";
const SANDBOX_OFF = "workspace-write" as const;
const SANDBOX_ON = "danger-full-access" as const;
const AUTOCOMPACT_SCREEN_ROLE = "autocompact";
const AUTOCOMPACT_PICKER_GROUP = "autocompact";
const AUTOCOMPACT_OFF = "off" as const;
const AUTOCOMPACT_ON = "on" as const;
const AUTOCOMPACT_DESCRIPTION = `Native autocompact applies to Claude sessions. The default window is min(${AUTOCOMPACT_DEFAULT_CAP / 1000}k tokens, ${AUTOCOMPACT_DEFAULT_PERCENT * 100}% of the context window).`;

const ORCHESTRATOR_PARALLELISM_NOTE_LINES = [
  "parallelism is advisory. Version 1 puts the requested cap in the",
  "orchestrator prompt for review verification and does not enforce the",
  "cap in code.",
] as const;
export const ORCHESTRATOR_PARALLELISM_NOTE = ORCHESTRATOR_PARALLELISM_NOTE_LINES.join(" ");

type OrchestratorPresetName = keyof typeof ORCHESTRATOR_PRESETS;
type OrchestratorParameter = "investigate" | "selfWork" | "tools" | "parallelism";
const ORCHESTRATOR_PARAMETERS: readonly OrchestratorParameter[] = [
  "investigate",
  "selfWork",
  "tools",
  "parallelism",
];

export interface OrchestratorParameterValues {
  investigate: InvestigateMode;
  selfWork: SelfWorkMode;
  tools: OrchestratorTools;
  parallelism?: number;
}

function copyOrchestratorMode(mode: OrchestratorMode): OrchestratorMode {
  return {
    investigate: mode.investigate,
    selfWork: mode.selfWork,
    tools: mode.tools,
    ...(mode.parallelism === undefined ? {} : { parallelism: mode.parallelism }),
  };
}

function selectionId(selection: string | { id: string }): string {
  return typeof selection === "string" ? selection : selection.id;
}

/**
 * Turns a preset or a complete custom answer into the config block. The
 * returned object contains parameters only, so labels and preset names cannot
 * leak into the saved JSON.
 */
export function orchestratorConfigFromSelection(
  selection: string | { id: string },
  parameters?: OrchestratorParameterValues,
): OrchestratorMode | undefined {
  const id = selectionId(selection);
  if (Object.hasOwn(ORCHESTRATOR_PRESETS, id)) {
    return copyOrchestratorMode(ORCHESTRATOR_PRESETS[id as OrchestratorPresetName]);
  }
  if (id !== "custom" || parameters === undefined) return undefined;

  const mode: OrchestratorMode = {
    investigate: parameters.investigate,
    selfWork: parameters.selfWork,
    tools: parameters.tools,
    ...(parameters.parallelism === undefined ? {} : { parallelism: parameters.parallelism }),
  };
  return isOrchestratorMode(mode) ? mode : undefined;
}

export function orchestratorDisplayLabel(config: RunAgentConfig): string {
  return orchestratorModeLabel(resolveOrchestratorMode(config));
}

function modeValue(mode: OrchestratorMode, parameter: OrchestratorParameter): string {
  if (parameter === "parallelism") return mode.parallelism === undefined ? PARALLELISM_NONE : String(mode.parallelism);
  return mode[parameter];
}

function parameterItems(parameter: OrchestratorParameter, mode: OrchestratorMode): PickerItem[] {
  const choices: string[] =
    parameter === "investigate"
      ? ["none", "read", "free"]
      : parameter === "selfWork"
        ? ["none", "trivial", "small"]
        : parameter === "tools"
          ? ["dispatch", "read", "edit"]
          : [PARALLELISM_NONE, "1", "2", "3", "4", "5", "6", "8", "12"];
  const current = modeValue(mode, parameter);
  const ordered = [current, ...choices.filter((choice) => choice !== current)];

  return ordered.map((choice) => ({
    id: choice,
    label: parameter === "parallelism" && choice === PARALLELISM_NONE ? "sem limite" : choice,
    group: ORCHESTRATOR_PICKER_GROUP,
    harness: ORCHESTRATOR_PICKER_GROUP,
    ...(choice === current ? { note: "atual" } : {}),
  }));
}

export function buildOrchestratorScreen(
  config: RunAgentConfig = {},
  index = 0,
  total = 1,
): Screen {
  const mode = resolveOrchestratorMode(config);
  const presets = [
    ["dispatcher", DISPATCHER_PRESET],
    ["balanced", BALANCED_PRESET],
    ["explorer", EXPLORER_PRESET],
  ] as const;
  const presetItems = presets.map(([name, preset]) => ({
    id: name,
    label: name,
    group: ORCHESTRATOR_PICKER_GROUP,
    harness: ORCHESTRATOR_PICKER_GROUP,
    note: `${preset.investigate} / ${preset.selfWork} / ${preset.tools}`,
  }));

  return {
    role: ORCHESTRATOR_SCREEN_ROLE,
    title: `orchestrator (${orchestratorModeLabel(mode)})`,
    counter: `agente ${index + 1} de ${total}`,
    description: ORCHESTRATOR_PARALLELISM_NOTE_LINES,
    items: [
      ...presetItems,
      {
        id: "custom",
        label: "custom",
        group: ORCHESTRATOR_PICKER_GROUP,
        harness: ORCHESTRATOR_PICKER_GROUP,
        note: "ajustar os quatro parametros",
      },
    ],
    pinned: false,
    known: new Set([
      ...presetItems.map((item) => itemKey(item.harness, item.id)),
      itemKey(ORCHESTRATOR_PICKER_GROUP, "custom"),
    ]),
    harnesses: new Set([ORCHESTRATOR_PICKER_GROUP]),
    next: (result) =>
      result.kind === "picked" && result.id === "custom"
        ? [buildOrchestratorParameterScreen(ORCHESTRATOR_PARAMETERS[0], mode, 0)]
        : [],
  };
}

export function buildSandboxScreen(
  config: RunAgentConfig = {},
  index = 0,
  total = 1,
): Screen {
  const selected = config.defaultSandbox === SANDBOX_ON ? SANDBOX_ON : SANDBOX_OFF;
  const values = selected === SANDBOX_ON ? [SANDBOX_ON, SANDBOX_OFF] : [SANDBOX_OFF, SANDBOX_ON];
  const items = values.map((value) => ({
    id: value,
    label: value === SANDBOX_ON ? "ON" : "OFF",
    group: SANDBOX_PICKER_GROUP,
    harness: SANDBOX_PICKER_GROUP,
    ...(value === selected ? { note: "atual" } : {}),
  }));

  return {
    role: SANDBOX_SCREEN_ROLE,
    title: "Danger full access",
    counter: `configuração ${index + 1} de ${total}`,
    description: ["Danger full access applies to new Codex sessions."],
    items,
    pinned: true,
    known: new Set(items.map((item) => itemKey(item.harness, item.id))),
    harnesses: new Set([SANDBOX_PICKER_GROUP]),
    next: () => [],
  };
}

export function buildAutocompactScreen(
  config: RunAgentConfig = {},
  index = 0,
  total = 1,
): Screen {
  const selected = config.autocompact?.enabled === true ? AUTOCOMPACT_ON : AUTOCOMPACT_OFF;
  const values = selected === AUTOCOMPACT_ON
    ? [AUTOCOMPACT_ON, AUTOCOMPACT_OFF]
    : [AUTOCOMPACT_OFF, AUTOCOMPACT_ON];
  const items = values.map((value) => ({
    id: value,
    label: value.toUpperCase(),
    group: AUTOCOMPACT_PICKER_GROUP,
    harness: AUTOCOMPACT_PICKER_GROUP,
    ...(value === selected ? { note: "atual" } : {}),
  }));

  return {
    role: AUTOCOMPACT_SCREEN_ROLE,
    title: "Claude native autocompact",
    counter: `configuração ${index + 1} de ${total}`,
    description: [AUTOCOMPACT_DESCRIPTION],
    items,
    pinned: true,
    known: new Set(items.map((item) => itemKey(item.harness, item.id))),
    harnesses: new Set([AUTOCOMPACT_PICKER_GROUP]),
    next: () => [],
  };
}

function modeAfterParameter(mode: OrchestratorMode, result: ScreenResult): OrchestratorMode {
  const parameters = collectOrchestratorParameters([result], mode);
  return orchestratorConfigFromSelection("custom", parameters) ?? mode;
}

function buildOrchestratorParameterScreen(
  parameter: OrchestratorParameter,
  mode: OrchestratorMode,
  index: number,
  error?: string,
): Screen {
  const items = parameterItems(parameter, mode);
  const description =
    parameter === "parallelism"
      ? [...ORCHESTRATOR_PARALLELISM_NOTE_LINES, "Type orchestrator:N for another positive cap."]
      : ORCHESTRATOR_PARALLELISM_NOTE_LINES;
  return {
    role: `${ORCHESTRATOR_SCREEN_ROLE}.${parameter}`,
    title: `orchestrator (${orchestratorModeLabel(mode)}) · ${parameter}`,
    counter: `parametro ${index + 1} de ${ORCHESTRATOR_PARAMETERS.length}`,
    ...(error === undefined ? {} : { error }),
    description,
    items,
    pinned: false,
    known: new Set(items.map((item) => itemKey(item.harness, item.id))),
    harnesses: new Set([ORCHESTRATOR_PICKER_GROUP]),
    next: (result: ScreenResult) => {
      if (
        parameter === "parallelism" &&
        result.kind === "picked" &&
        result.id !== PARALLELISM_NONE &&
        numericParallelism(result.id) === undefined
      ) {
        return [
          buildOrchestratorParameterScreen(
            parameter,
            mode,
            index,
            "parallelism must be a positive finite number",
          ),
        ];
      }
      if (index + 1 >= ORCHESTRATOR_PARAMETERS.length) return [];
      const nextIndex = index + 1;
      return [
        buildOrchestratorParameterScreen(
          ORCHESTRATOR_PARAMETERS[nextIndex],
          modeAfterParameter(mode, result),
          nextIndex,
        ),
      ];
    },
  };
}

function numericParallelism(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Keeps skipped parameter screens at the mode shown when customization began. */
export function collectOrchestratorParameters(
  results: readonly ScreenResult[],
  existing: OrchestratorMode,
): OrchestratorParameterValues {
  const parameters: OrchestratorParameterValues = {
    investigate: existing.investigate,
    selfWork: existing.selfWork,
    tools: existing.tools,
    ...(existing.parallelism === undefined ? {} : { parallelism: existing.parallelism }),
  };

  for (const result of results) {
    if (result.kind !== "picked") continue;
    const parameter = result.role.startsWith(`${ORCHESTRATOR_SCREEN_ROLE}.`)
      ? result.role.slice(`${ORCHESTRATOR_SCREEN_ROLE}.`.length)
      : "";
    if (parameter === "investigate" && ["none", "read", "free"].includes(result.id)) {
      parameters.investigate = result.id as InvestigateMode;
    } else if (parameter === "selfWork" && ["none", "trivial", "small"].includes(result.id)) {
      parameters.selfWork = result.id as SelfWorkMode;
    } else if (parameter === "tools" && ["dispatch", "read", "edit"].includes(result.id)) {
      parameters.tools = result.id as OrchestratorTools;
    } else if (parameter === "parallelism") {
      if (result.id === PARALLELISM_NONE) delete parameters.parallelism;
      else {
        const parsed = numericParallelism(result.id);
        if (parsed !== undefined) parameters.parallelism = parsed;
      }
    }
  }
  return parameters;
}

export function collectOrchestratorSelection(
  selection: ScreenResult | undefined,
  parameters: readonly ScreenResult[],
  existing: RunAgentConfig = {},
): OrchestratorMode | undefined {
  if (selection?.kind !== "picked") return undefined;
  if (selection.id !== "custom") return orchestratorConfigFromSelection(selection);
  const current = resolveOrchestratorMode(existing);
  return orchestratorConfigFromSelection("custom", collectOrchestratorParameters(parameters, current));
}

export interface ModelWizardOptions {
  config?: RunAgentConfig;
  registry?: DriverRegistry;
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
  output?: NodeJS.WritableStream & { isTTY?: boolean; rows?: number; columns?: number };
  isTTY?: boolean;
  refresh?: boolean;
  dimensions?: Dimensions;
  discoverModels?: (registry: DriverRegistry, refresh: boolean) => Promise<HarnessModels[]>;
  save?: (config: RunAgentConfig) => void;
}

/**
 * Both streams have to be a terminal, not just stdout. A piped stdin leaves
 * `question` waiting on input that can never arrive, and `tail -f /dev/null |
 * codedeck open` keeps stdout a TTY while stdin is exactly that pipe.
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * The open command uses this decision before creating a readline interface.
 * Keeping the terminal state as an argument makes the first-run policy pure.
 */
export function needsModelSetup(
  config: RunAgentConfig | null | undefined,
  isTTY: boolean = isInteractiveTerminal(),
): boolean {
  if (!isTTY) return false;
  // `agents` is what setup writes now. A config carrying only the older
  // per-harness `models` has never answered the per-role question, so it still
  // counts as unset.
  return config == null || config.agents == null;
}

/**
 * The catalog of every installed harness, flattened into one list.
 *
 * The group is the bare agent id rather than a prettier label because it is
 * also what free text has to type as a prefix ("codex:gpt-5.7"). A header
 * reading "Codex" over rows you reach by typing "codex" would hide that.
 */
/** One normalization for every id, so the catalog and the pin agree on a key. */
function modelId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function catalogItems(installed: HarnessModels[]): { items: PickerItem[]; known: Set<string> } {
  const known = new Set<string>();
  const items: PickerItem[] = [];
  for (const harness of installed) {
    for (const provider of harness.providers) {
      for (const model of provider.models) {
        // A driver reporting a blank id used to become a selectable blank row
        // that Enter would save as the model. The line wizard guarded this and
        // the port dropped the guard.
        const id = modelId(model.id);
        if (!id) continue;
        // Keyed by both halves: two harnesses listing the same id are two real
        // choices, and only a repeat within one harness is a duplicate.
        const key = itemKey(harness.agent, id);
        if (known.has(key)) continue;
        known.add(key);
        // The name is carried for the filter, not for the row: most of the
        // catalog spells a version readably there ("Claude Opus 5") and only in
        // the id the way it is typed.
        const name = typeof model.name === "string" ? model.name.trim() : "";
        items.push({
          id,
          label: id,
          group: harness.agent,
          harness: harness.agent,
          ...(name && name !== id ? { name } : {}),
        });
      }
    }
  }
  return { items, known };
}

function pinnedFor(
  installed: HarnessModels[],
  known: ReadonlySet<string>,
  configured: RoleBinding | undefined,
  fallbackHarness: AgentId,
): PickerItem | undefined {
  if (configured) {
    const inCatalog = known.has(itemKey(configured.harness, configured.model));
    // A saved id the catalog no longer lists still gets shown. Hiding it is how
    // the wizard used to answer `open`'s own "that model is gone, run setup":
    // the user arrived here and could not see which model it meant. Marking it
    // synthetic makes keeping it cost the same second Enter as typing it.
    return {
      id: configured.model,
      label: configured.model,
      group: configured.harness,
      harness: configured.harness,
      note: inCatalog ? `atual · ${configured.harness}` : `atual · ${configured.harness}, fora do catalogo`,
      ...(inCatalog ? {} : { synthetic: true as const }),
    };
  }

  // Nothing saved for this role, so the suggestion comes from the harness that
  // runs everything else by default, and only if that harness names a default.
  const harness = installed.find((candidate) => candidate.agent === fallbackHarness);
  if (!harness) return undefined;
  for (const provider of harness.providers) {
    // Trimmed the same way the catalog trims, or the lookup misses its own row
    // and a harness that pads its ids ends up pinning nothing.
    const real = provider.models
      .map((model) => ({ id: modelId(model.id), isDefault: model.isDefault }))
      .find((model) => model.isDefault && known.has(itemKey(harness.agent, model.id)));
    if (real) {
      return {
        id: real.id,
        label: real.id,
        group: harness.agent,
        harness: harness.agent,
        note: `padrao · ${harness.agent}`,
      };
    }
  }
  // With no config and no isDefault, the first row is just catalog order.
  // Hoisting that and calling it the default would stamp a coin flip as a
  // recommendation.
}

export function buildRoleScreen(
  role: Role,
  installed: HarnessModels[],
  index: number,
  total: number,
  configured: RoleBinding | undefined,
  fallbackHarness: AgentId = "claude",
): Screen {
  const { items: catalog, known } = catalogItems(installed);
  const pinned = pinnedFor(installed, known, configured, fallbackHarness);
  const pinnedKey = pinned ? itemKey(pinned.harness, pinned.id) : undefined;
  const items = pinned
    ? [pinned, ...catalog.filter((item) => itemKey(item.harness, item.id) !== pinnedKey)]
    : catalog;

  // One screen now spans every harness, so a harness that answered with an
  // error no longer owns the error line by itself. Naming each one keeps a
  // missing catalog readable as "codex is why codex has no rows".
  const errors = installed
    .filter((harness) => harness.error)
    .map((harness) => `${harness.agent}: ${harness.error}`);

  return {
    role,
    title: role,
    counter: `agente ${index + 1} de ${total}`,
    ...(errors.length > 0 ? { error: errors.join(" · ") } : {}),
    items,
    pinned: pinned !== undefined,
    known,
    harnesses: new Set(installed.map((harness) => harness.agent)),
  };
}

export function buildScreens(
  roles: readonly Role[],
  harnesses: HarnessModels[],
  configured: Partial<Record<Role, RoleBinding>>,
  fallbackHarness: AgentId = "claude",
): Screen[] {
  const seen = new Set<AgentId>();
  // A merged disk cache can hand back the same agent twice.
  const installed = harnesses.filter((harness) => {
    if (!harness.available || seen.has(harness.agent)) return false;
    seen.add(harness.agent);
    return true;
  });
  if (installed.length === 0) return [];
  return roles.map((role, index) =>
    buildRoleScreen(role, installed, index, roles.length, configured[role], fallbackHarness),
  );
}

export function collectSelections(
  results: ScreenResult[],
  existing: Partial<Record<Role, RoleBinding>> | undefined,
  shown: number,
): { agents: Partial<Record<Role, RoleBinding>>; write: boolean } {
  // Starts from what was already saved: skipping has to leave it intact, and a
  // brand new map would wipe a choice made on an earlier run.
  const agents: Partial<Record<Role, RoleBinding>> = { ...(existing ?? {}) };
  for (const result of results) {
    if (result.kind !== "picked") continue;
    agents[result.role as Role] = { harness: result.harness as AgentId, model: result.id };
  }
  const aborted = results.some((result) => result.kind === "aborted");
  return { agents, write: shown > 0 && !aborted };
}

/** Below this no list survives once the chrome is placed. */
const MIN_ROWS = 8;

function watchResize(listener: () => void): () => void {
  process.stdout.on("resize", listener);
  return () => {
    process.stdout.off("resize", listener);
  };
}

export async function runModelSetupWizard(options: ModelWizardOptions = {}): Promise<RunAgentConfig> {
  const config = options.config ?? loadConfig();
  if (!(options.isTTY ?? isInteractiveTerminal())) return config;

  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const registry = options.registry ?? getRegistry();

  // Order matters: announce, discover with raw mode still off, and only then
  // measure and draw. Discovery blocks for seconds, and doing it with the
  // terminal already taken over looks like a freeze.
  output.write("\n  discovering models...\n");
  let harnesses: HarnessModels[];
  try {
    const discover =
      options.discoverModels ??
      ((selected: DriverRegistry, refresh: boolean) => getCachedOrDiscoverModels(selected, { refresh }));
    harnesses = await discover(registry, options.refresh ?? false);
  } catch (error) {
    // A catalog that cannot be reached is not an answer from the user. It falls
    // into the guard below, which saves nothing and lets the next run ask.
    console.error(`Warning: Could not discover models: ${error instanceof Error ? error.message : String(error)}`);
    harnesses = [];
  }

  const roleScreens = buildScreens(ROLES, harnesses, config.agents ?? {}, config.defaultAgent ?? "claude");

  // Writing `agents` is what marks first-run setup as done. Doing that after
  // showing nothing would spend the single prompt the user ever gets.
  if (roleScreens.length === 0) {
    console.error("Warning: No installed harness reported any model; skipping model setup.");
    return config;
  }

  const dim = options.dimensions ?? readDimensions(output);
  if (dim.rows < MIN_ROWS) {
    console.error(`Warning: Terminal is ${dim.rows} rows, model setup needs ${MIN_ROWS}. Nothing was saved.`);
    return config;
  }

  const paint = colors(Boolean(output.isTTY) && !process.env.NO_COLOR);
  const screens = [
    ...roleScreens,
    buildOrchestratorScreen(config, roleScreens.length, roleScreens.length + 1),
  ];
  const total = screens.length + 2;
  const sandbox = buildSandboxScreen(config, screens.length, total);
  const autocompact = buildAutocompactScreen(config, screens.length + 1, total);
  const results = await runScreens(
    [...screens, sandbox, autocompact],
    { input, output, onResize: watchResize },
    paint,
  );

  if (results.some((result) => result.kind === "aborted")) {
    console.error("Warning: Model setup was interrupted; nothing was saved.");
    return config;
  }

  const answeredResults = results.filter(
    (result): result is Exclude<ScreenResult, { kind: "aborted" }> => result.kind !== "aborted",
  );
  const agentResults = answeredResults.filter((result) =>
    roleScreens.some((screen) => screen.role === result.role),
  );
  const { agents, write } = collectSelections(agentResults, config.agents, roleScreens.length);
  if (!write) {
    console.error("Warning: Model setup was interrupted; nothing was saved.");
    return config;
  }

  const orchestratorSelection = answeredResults.find((result) => result.role === ORCHESTRATOR_SCREEN_ROLE);
  if (orchestratorSelection === undefined) {
    console.error("Warning: Orchestrator setup was interrupted; nothing was saved.");
    return config;
  }

  let orchestrator: OrchestratorMode | undefined;
  if (orchestratorSelection.kind === "picked" && orchestratorSelection.id === "custom") {
    const parameterResults = answeredResults.filter((result) =>
      result.role.startsWith(`${ORCHESTRATOR_SCREEN_ROLE}.`),
    );
    orchestrator = collectOrchestratorSelection(orchestratorSelection, parameterResults, config);
    if (orchestrator === undefined) {
      console.error("Warning: Orchestrator setup was invalid; nothing was saved.");
      return config;
    }
  } else if (orchestratorSelection.kind === "picked") {
    orchestrator = collectOrchestratorSelection(orchestratorSelection, [], config);
    if (orchestrator === undefined) {
      console.error("Warning: Orchestrator setup was invalid; nothing was saved.");
      return config;
    }
  }

  const updatedConfig: RunAgentConfig = { ...config, agents };
  if (orchestrator !== undefined) updatedConfig.orchestrator = orchestrator;
  const sandboxSelection = answeredResults.find((result) => result.role === SANDBOX_SCREEN_ROLE);
  if (sandboxSelection?.kind === "picked") {
    if (sandboxSelection.id === SANDBOX_OFF || sandboxSelection.id === SANDBOX_ON) {
      updatedConfig.defaultSandbox = sandboxSelection.id;
    }
  }
  const autocompactSelection = answeredResults.find((result) => result.role === AUTOCOMPACT_SCREEN_ROLE);
  if (autocompactSelection?.kind === "picked") {
    if (autocompactSelection.id === AUTOCOMPACT_ON) {
      updatedConfig.autocompact = { ...config.autocompact, enabled: true };
    } else if (autocompactSelection.id === AUTOCOMPACT_OFF && config.autocompact !== undefined) {
      updatedConfig.autocompact = { ...config.autocompact, enabled: false };
    }
  }
  let saved = false;
  try {
    (options.save ?? saveConfig)(updatedConfig);
    saved = true;
  } catch (error) {
    console.error(`Warning: Could not save config: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!saved) return updatedConfig;

  const summary = roleScreens
    .map((screen) => {
      const binding = agents[screen.role as Role];
      return `${screen.role} ${binding ? `${binding.harness}:${binding.model}` : "unset"}`;
    })
    .join(" · ");
  const modeSummary = orchestrator === undefined ? "" : ` · orchestrator ${orchestratorModeLabel(orchestrator)}`;
  output.write(`\n  saved: ${summary}${modeSummary}\n\n`);
  return updatedConfig;
}

export interface ParsedSetupBinding {
  role: Role;
  binding: RoleBinding;
}

export interface SetupCliOptions {
  refresh: boolean;
  nonInteractive: boolean;
  json: boolean;
  dryRun: boolean;
  binds: ParsedSetupBinding[];
  batch: boolean;
}

export class SetupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupUsageError";
  }
}

function invalidBindMessage(value: string): string {
  return `Invalid --bind "${value}": expected role=harness:model (role: general|orchestrator|reviewer|auditor; harness: claude|codex|opencode|omp; model: non-empty and without whitespace, control characters or '=')`;
}

export function parseBind(value: string): ParsedSetupBinding {
  const equals = value.indexOf("=");
  const roleValue = equals < 0 ? "" : value.slice(0, equals);
  const right = equals < 0 ? "" : value.slice(equals + 1);
  const colon = right.indexOf(":");
  const harnessValue = colon < 0 ? "" : right.slice(0, colon);
  const model = colon < 0 ? "" : right.slice(colon + 1);
  const role = (ROLES as readonly string[]).includes(roleValue) ? (roleValue as Role) : undefined;
  const harness = isAgentId(harnessValue) ? harnessValue : undefined;
  const modelPattern = /^[^\p{White_Space}\p{Cc}\p{Cf}=]+$/u;

  if (!role || !harness || !modelPattern.test(model)) throw new SetupUsageError(invalidBindMessage(value));
  return { role, binding: { harness, model } };
}

export const parseSetupBind = parseBind;

export type SetupParseResult =
  | { ok: true; options: SetupCliOptions }
  | { ok: false; message: string; json: boolean };

function parseError(message: string, json: boolean): SetupParseResult {
  return { ok: false, message, json };
}

function isSetupFlag(arg: string): boolean {
  return arg.startsWith("-");
}

export function parseSetupArgs(args: readonly string[]): SetupParseResult {
  const json = args.some((arg) => arg === "--json" || arg.startsWith("--json="));
  const binds: ParsedSetupBinding[] = [];
  let refresh = false;
  let nonInteractive = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--refresh") {
      refresh = true;
      continue;
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    if (arg === "--bind") {
      const value = args[index + 1];
      if (value === undefined || isSetupFlag(value)) {
        return parseError('Option "--bind" expects role=harness:model.', json);
      }
      index += 1;
      try {
        binds.push(parseBind(value));
      } catch (error) {
        return parseError(error instanceof Error ? error.message : String(error), json);
      }
      continue;
    }
    if (arg.startsWith("--bind=")) {
      try {
        binds.push(parseBind(arg.slice("--bind=".length)));
      } catch (error) {
        return parseError(error instanceof Error ? error.message : String(error), json);
      }
      continue;
    }

    if (arg.startsWith("-")) return parseError(`Unknown option "${arg}".`, json);
    return parseError(`Unexpected argument "${arg}".`, json);
  }

  return {
    ok: true,
    options: {
      refresh,
      nonInteractive,
      json,
      dryRun,
      binds,
      batch: nonInteractive || json || dryRun || binds.length > 0,
    },
  };
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

export interface SetupBatchDependencies {
  registry?: DriverRegistry;
  configStore?: SetupConfigStore;
  discoverModels?: BatchDiscovery;
  saveCache?: (models: HarnessModels[]) => void | boolean;
  now?: () => number;
  timeoutMs?: number;
  stderr?: NodeJS.WritableStream;
}

export interface SetupBatchResult {
  code: SetupEnvelope["resultado"]["code"];
  envelope: SetupEnvelope;
}

function writeLine(stream: NodeJS.WritableStream | undefined, message: string): void {
  if (stream) {
    stream.write(`${message}\n`);
  } else {
    console.error(message);
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

function notNeededCatalog(): SetupEnvelope["validacoes"]["catalogo"] {
  return { status: "not-needed", source: "none", ageMs: null, message: null };
}

function emptyEnvelope(message: string, code: SetupEnvelope["resultado"]["code"], path: string): SetupEnvelope {
  return {
    proposta: null,
    validacoes: {
      config: { status: "not-run", source: "none", path, message: "not-run" },
      catalogo: { status: "not-needed", source: "none", ageMs: null, message: "not-run" },
      bindings: [],
    },
    mudancas: [],
    resultado: { status: "error", code, saved: false, message },
  };
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (jsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) => [key, jsonValue(value[key])]),
    ) as {
      [key: string]: JsonValue;
    };
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
    const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort((left, right) => left.localeCompare(right));
    if (keys.length === 0) return;
    for (const key of keys) {
      diffAt(
        output,
        `${pathValue}/${pointerPart(key)}`,
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
        const childPath = `${pathValue}/${pointerPart(key)}`;
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
        const childPath = `${pathValue}/${pointerPart(key)}`;
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
  const keys = [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    diffAt(
      output,
      `/${pointerPart(key)}`,
      Object.hasOwn(beforeObject, key),
      beforeObject[key],
      Object.hasOwn(afterObject, key),
      afterObject[key],
      true,
    );
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function catalogContains(catalog: HarnessModels, model: string): boolean {
  return catalog.providers.some((provider) =>
    provider.models.some(
      (candidate) =>
        candidate.id === model || (candidate.aliases !== undefined && candidate.aliases.some((alias) => alias === model)),
    ),
  );
}

type BindingValidation = SetupEnvelope["validacoes"]["bindings"][number];

function validateBindings(
  bindings: readonly ParsedSetupBinding[],
  catalog: Awaited<ReturnType<typeof getBatchModels>>,
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
        message: `Cannot apply binding for role "${role}": harness "${binding.harness}" is unavailable.`,
      };
    }
    if (catalog.status === "unavailable" || found === undefined) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "unverified",
        message: `Cannot validate model "${binding.model}" for harness "${binding.harness}": catalog unavailable.`,
      };
    }
    if (catalog.status === "offline" && !catalogContains(found, binding.model)) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "unverified",
        message: `Cannot validate model "${binding.model}" for harness "${binding.harness}": the catalog is stale. Re-run with --refresh.`,
      };
    }
    if (!catalogContains(found, binding.model)) {
      return {
        role,
        harness: binding.harness,
        model: binding.model,
        status: "unknown-model",
        message: `Model "${binding.model}" is not in the ${binding.harness} catalog for role "${role}".`,
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

function catalogValidation(
  catalog: Awaited<ReturnType<typeof getBatchModels>> | undefined,
  message: string | null,
): SetupEnvelope["validacoes"]["catalogo"] {
  if (catalog === undefined) return notNeededCatalog();
  return {
    status: catalog.status,
    source: catalog.source,
    ageMs: catalog.ageMs,
    message,
  };
}

function configSummary(config: RunAgentConfig): string {
  const agents = config.agents ?? {};
  return ROLES.map((role) => {
    const binding = agents[role];
    return `${role} ${binding ? `${binding.harness}:${binding.model}` : "unset"}`;
  }).join(" · ");
}

function errorResult(
  read: SetupConfigRead,
  proposal: RunAgentConfig | null,
  catalog: SetupEnvelope["validacoes"]["catalogo"],
  bindings: BindingValidation[],
  changes: SetupEnvelope["mudancas"],
  code: 11 | 12 | 13 | 14 | 15,
  message: string,
): SetupBatchResult {
  return {
    code,
    envelope: {
      proposta: proposal,
      validacoes: { config: configValidation(read), catalogo: catalog, bindings },
      mudancas: changes,
      resultado: { status: "error", code, saved: false, message },
    },
  };
}

export async function runSetupBatch(
  options: SetupCliOptions,
  dependencies: SetupBatchDependencies = {},
): Promise<SetupBatchResult> {
  const stderr = dependencies.stderr;
  const store = dependencies.configStore ?? createSetupConfigStore();
  let read: SetupConfigRead;
  try {
    read = store.read();
  } catch (error) {
    const path = getPaths().configFile;
    const message = `Cannot save config "${path}": ${error instanceof Error ? error.message : String(error)}.`;
    writeLine(stderr, message);
    return {
      code: 15,
      envelope: emptyEnvelope(message, 15, path),
    };
  }

  if (read.status === "invalid") {
    const message = read.readError
      ? `Cannot save config "${getPaths().configFile}": ${read.message}.`
      : read.message ?? `Config file "${read.path}" contains invalid JSON; no changes were written. Repair or move it and retry.`;
    writeLine(stderr, message);
    return errorResult(read, null, notNeededCatalog(), [], [], read.readError ? 15 : 14, message);
  }

  const current: RunAgentConfig = { ...DEFAULT_CONFIG, ...(read.config ?? {}) };
  const lastByRole = new Map<Role, number>();
  options.binds.forEach((binding, index) => lastByRole.set(binding.role, index));
  const winning = options.binds.filter((binding, index) => lastByRole.get(binding.role) === index);
  const existingAgents = jsonObject(current.agents) ? current.agents : {};
  const proposed: RunAgentConfig = options.binds.length === 0
    ? { ...current }
    : {
        ...current,
        agents: {
          ...existingAgents,
          ...Object.fromEntries(winning.map(({ role, binding }) => [role, binding])),
        },
      };
  const changes = diffConfig(current, proposed);

  let catalog: Awaited<ReturnType<typeof getBatchModels>> | undefined;
  let bindingValidations: BindingValidation[] = [];
  let catalogMessage: string | null = null;
  if (winning.length > 0 || options.refresh) {
    const agents = winning.length > 0
      ? [...new Set(winning.map(({ binding }) => binding.harness))]
      : undefined;
    catalog = await getBatchModels(dependencies.registry ?? getRegistry(), {
      agents,
      refresh: options.refresh,
      allowNetwork: !options.dryRun || options.refresh,
      now: dependencies.now,
      timeoutMs: dependencies.timeoutMs,
      discover: dependencies.discoverModels,
      saveCache: dependencies.saveCache,
      onDiscoveryStart: () => writeLine(stderr, "discovering models..."),
    });
    if (catalog.discoveryError !== undefined) {
      writeLine(stderr, `Warning: ${catalog.discoveryError}.`);
    }
    if (catalog.cacheWriteFailed) writeLine(stderr, "Warning: Could not update models cache.");
    if (winning.length > 0) {
      const validation = validateBindings(winning, catalog);
      bindingValidations = validation.entries;
      catalogMessage = validation.message;
      if (validation.code !== undefined) {
        for (const entry of bindingValidations) {
          if (entry.status !== "accepted") writeLine(stderr, entry.message);
        }
        return errorResult(
          read,
          proposed,
          catalogValidation(catalog, catalogMessage),
          bindingValidations,
          changes,
          validation.code,
          bindingValidations.find((entry) => entry.status !== "accepted")?.message ?? "Setup validation failed.",
        );
      }
    } else if (catalog.status === "unavailable") {
      catalogMessage = "Catalog unavailable.";
      const message = "Model catalog unavailable.";
      writeLine(stderr, message);
      return errorResult(read, proposed, catalogValidation(catalog, catalogMessage), [], changes, 13, message);
    } else if (catalog.status === "offline") {
      catalogMessage = "Catalog is stale; using offline cache.";
      writeLine(stderr, catalogMessage);
    }
  }

  const validations = {
    config: configValidation(read),
    catalogo: catalogValidation(catalog, catalogMessage),
    bindings: bindingValidations,
  };

  if (winning.length === 0) {
    const message = "Configuration unchanged.";
    if (!options.json) writeLine(stderr, message);
    return {
      code: 0,
      envelope: { proposta: proposed, validacoes: validations, mudancas: changes, resultado: { status: "unchanged", code: 0, saved: false, message } },
    };
  }

  if (options.dryRun) {
    const message = "Dry run; configuration not written.";
    if (!options.json) writeLine(stderr, message);
    return {
      code: 0,
      envelope: { proposta: proposed, validacoes: validations, mudancas: changes, resultado: { status: "dry-run", code: 0, saved: false, message } },
    };
  }

  const serialized = serializeConfig(proposed);
  let saved = false;
  try {
    const canonicalRaw = read.source === "canonical" ? read.raw : null;
    if (canonicalRaw !== null && canonicalRaw === serialized) {
      saved = false;
    } else {
      saved = store.save(proposed) !== false;
    }
  } catch (error) {
    const message = `Cannot save config "${getPaths().configFile}": ${error instanceof Error ? error.message : String(error)}.`;
    writeLine(stderr, message);
    return errorResult(read, proposed, catalogValidation(catalog, catalogMessage), bindingValidations, changes, 15, message);
  }

  if (!saved) {
    const message = "Configuration unchanged.";
    if (!options.json) writeLine(stderr, message);
    return {
      code: 0,
      envelope: { proposta: proposed, validacoes: validations, mudancas: [], resultado: { status: "unchanged", code: 0, saved: false, message } },
    };
  }

  const message = "Configuration saved.";
  if (!options.json) writeLine(stderr, `saved: ${configSummary(proposed)}`);
  return {
    code: 0,
    envelope: { proposta: proposed, validacoes: validations, mudancas: changes, resultado: { status: "applied", code: 0, saved: true, message } },
  };
}

export interface SetupCommandDependencies extends SetupBatchDependencies {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): unknown };
  stdout?: NodeJS.WritableStream & { isTTY?: boolean; rows?: number; columns?: number };
  isTTY?: boolean;
  wizardDiscoverModels?: ModelWizardOptions["discoverModels"];
  saveConfig?: (config: RunAgentConfig) => void;
}

function commandTokens(opts: Record<string, unknown>, command: Command): string[] {
  const tokens: string[] = [];
  if (opts.refresh) tokens.push("--refresh");
  if (opts.nonInteractive) tokens.push("--non-interactive");
  if (opts.json) tokens.push("--json");
  if (opts.dryRun) tokens.push("--dry-run");
  const binds = Array.isArray(opts.bind) ? opts.bind : opts.bind === undefined ? [] : [opts.bind];
  for (const bind of binds) {
    tokens.push("--bind");
    if (bind !== true) tokens.push(String(bind));
  }
  return tokens.concat(command.args.map(String));
}

export interface SetupActionResult {
  code: SetupEnvelope["resultado"]["code"];
  envelope?: SetupEnvelope;
}

export async function executeSetupAction(
  args: readonly string[],
  dependencies: SetupCommandDependencies = {},
): Promise<SetupActionResult> {
  const parsed = parseSetupArgs(args);
  const stdout = dependencies.stdout ?? process.stdout;
  const input = dependencies.input ?? process.stdin;
  const writeError = (message: string) => writeLine(dependencies.stderr, message);

  if (!parsed.ok) {
    if (parsed.json) stdout.write(`${JSON.stringify(emptyEnvelope(parsed.message, 2, getPaths().configFile))}\n`);
    writeError(parsed.message);
    return { code: 2, envelope: parsed.json ? emptyEnvelope(parsed.message, 2, getPaths().configFile) : undefined };
  }

  const tty = dependencies.isTTY ?? Boolean(input.isTTY && stdout.isTTY);
  if (!parsed.options.batch) {
    if (!tty) {
      const message = `${getCliName()} setup needs a terminal on both stdin and stdout.`;
      writeError(message);
      return { code: 1 };
    }
    await runModelSetupWizard({
      registry: dependencies.registry,
      input: dependencies.input,
      output: dependencies.stdout,
      refresh: parsed.options.refresh,
      discoverModels: dependencies.wizardDiscoverModels,
      save: dependencies.saveConfig,
      isTTY: tty,
    });
    return { code: 0 };
  }

  const result = await runSetupBatch(parsed.options, dependencies);
  if (parsed.options.json) stdout.write(`${JSON.stringify(result.envelope)}\n`);
  return result;
}

export function registerSetupCommand(program: Command, dependencies: SetupCommandDependencies = {}): void {
  program
    .command("setup")
    .description("Choose the harness and model each agent should run on")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option("--refresh", "ignore the cached catalog and rediscover")
    .option("--non-interactive", "run setup without the picker")
    .option("--json", "output one machine-readable envelope")
    .option("--dry-run", "show the proposed config without writing it")
    .option(
      "--bind [binding]",
      "bind a role to a harness and model",
      (value: string | true, previous: Array<string | true> = []) => [...previous, value],
      [],
    )
    .action(async (opts: Record<string, unknown>, command: Command) => {
      const result = await executeSetupAction(commandTokens(opts, command), dependencies);
      process.exitCode = result.code;
    });
}
