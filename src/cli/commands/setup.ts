import type { Command } from "commander";
import type { DriverRegistry } from "../../core/driver.js";
import {
  getCachedOrDiscoverModels,
  type HarnessModels,
} from "../../core/models.js";
import type { AgentId } from "../../core/session.js";
import { itemKey, type PickerItem, type Screen, type ScreenResult } from "../picker-state.js";
import { runScreens } from "../picker.js";
import { colors, readDimensions, type Dimensions } from "../ui.js";
import { getCliName } from "../cli-name.js";
import { getRegistry } from "../../drivers/registry.js";
import { ROLES, type Role } from "../../core/roles.js";
import {
  BALANCED_PRESET,
  DISPATCHER_PRESET,
  EXPLORER_PRESET,
  ORCHESTRATOR_PRESETS,
  isOrchestratorMode,
  loadConfig,
  orchestratorModeLabel,
  resolveOrchestratorMode,
  saveConfig,
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

function modeAfterParameter(mode: OrchestratorMode, result: ScreenResult): OrchestratorMode {
  const parameters = collectOrchestratorParameters([result], mode);
  return orchestratorConfigFromSelection("custom", parameters) ?? mode;
}

function buildOrchestratorParameterScreen(
  parameter: OrchestratorParameter,
  mode: OrchestratorMode,
  index: number,
  chain = true,
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
    description,
    items,
    pinned: false,
    known: new Set(items.map((item) => itemKey(item.harness, item.id))),
    harnesses: new Set([ORCHESTRATOR_PICKER_GROUP]),
    ...(chain && index + 1 < ORCHESTRATOR_PARAMETERS.length
      ? {
          next: (result: ScreenResult) => {
            const nextIndex = index + 1;
            return [
              buildOrchestratorParameterScreen(
                ORCHESTRATOR_PARAMETERS[nextIndex],
                modeAfterParameter(mode, result),
                nextIndex,
              ),
            ];
          },
        }
      : {}),
  };
}

/** A static snapshot for callers that need all four parameter screens at once. */
export function buildOrchestratorParameterScreens(mode: OrchestratorMode): Screen[] {
  return ORCHESTRATOR_PARAMETERS.map((parameter, index) =>
    buildOrchestratorParameterScreen(parameter, mode, index, false),
  );
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

  const screens = buildScreens(ROLES, harnesses, config.agents ?? {}, config.defaultAgent ?? "claude");

  // Writing `agents` is what marks first-run setup as done. Doing that after
  // showing nothing would spend the single prompt the user ever gets.
  if (screens.length === 0) {
    console.error("Warning: No installed harness reported any model; skipping model setup.");
    return config;
  }

  const dim = options.dimensions ?? readDimensions(output);
  if (dim.rows < MIN_ROWS) {
    console.error(`Warning: Terminal is ${dim.rows} rows, model setup needs ${MIN_ROWS}. Nothing was saved.`);
    return config;
  }

  const paint = colors(Boolean(output.isTTY) && !process.env.NO_COLOR);
  const results = await runScreens(
    [...screens, buildOrchestratorScreen(config, screens.length, screens.length + 1)],
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
  const agentResults = answeredResults.filter((result) => screens.some((screen) => screen.role === result.role));
  const { agents, write } = collectSelections(agentResults, config.agents, screens.length);
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
  try {
    (options.save ?? saveConfig)(updatedConfig);
  } catch (error) {
    console.error(`Warning: Could not save config: ${error instanceof Error ? error.message : String(error)}`);
  }

  const summary = screens
    .map((screen) => {
      const binding = agents[screen.role as Role];
      return `${screen.role} ${binding ? `${binding.harness}:${binding.model}` : "unset"}`;
    })
    .join(" · ");
  const modeSummary = orchestrator === undefined ? "" : ` · orchestrator ${orchestratorModeLabel(orchestrator)}`;
  output.write(`\n  saved: ${summary}${modeSummary}\n\n`);
  return updatedConfig;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Choose the harness and model each agent should run on")
    .option("--refresh", "ignore the cached catalog and rediscover")
    .action(async (opts: { refresh?: boolean }) => {
      // The message lives here rather than in the wizard, because `open` calls
      // the same function and has to stay quiet when it cannot prompt.
      if (!isInteractiveTerminal()) {
        console.error(`${getCliName()} setup needs a terminal on both stdin and stdout.`);
        process.exitCode = 1;
        return;
      }
      await runModelSetupWizard({ refresh: opts.refresh });
    });
}
