import type { Command } from "commander";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { DriverRegistry } from "../../core/driver.js";
import {
  flattenModels,
  getCachedOrDiscoverModels,
  type HarnessModels,
} from "../../core/models.js";
import type { AgentId } from "../../core/session.js";
import type { PickerItem, Screen, ScreenResult } from "../picker-state.js";
import { runScreens } from "../picker.js";
import {
  INDENT,
  blockWidth,
  colors,
  columnize,
  headingWith,
  readDimensions,
  renderLogo,
  type Dimensions,
} from "../ui.js";
import { getRegistry } from "../../drivers/registry.js";
import {
  loadConfig,
  saveConfig,
  type RunAgentConfig,
} from "../../config/config.js";

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
  return config == null || config.models == null;
}


// Canonical ids only, not aliases: the wizard is offering a list to pick from,
// where two names for the same model are noise rather than choice.
function getModelIds(harness: HarnessModels): string[] {
  const ids = flattenModels(harness)
    .map((model) => model.id)
    .filter((id) => typeof id === "string" && id.trim() !== "");
  return [...new Set(ids)];
}

function getDefaultModel(harness: HarnessModels, ids: string[], configured?: string): string | undefined {
  if (configured && ids.includes(configured)) return configured;
  for (const provider of harness.providers) {
    const model = provider.models.find((candidate) => candidate.isDefault && ids.includes(candidate.id));
    if (model) return model.id;
  }
  return ids[0];
}

/** Long enough to choose from, short enough to leave the other agents on screen. */
const MAX_LISTED = 16;

const AGENT_LABELS: Partial<Record<AgentId, string>> = { claude: "Claude Code", codex: "Codex", omp: "omp" };

function agentLabel(agent: AgentId): string {
  return AGENT_LABELS[agent] ?? agent;
}

function pinnedFor(harness: HarnessModels, ids: string[], configured?: string): PickerItem | undefined {
  if (configured && ids.includes(configured)) {
    return { id: configured, label: configured, note: "atual" };
  }
  for (const provider of harness.providers) {
    const real = provider.models.find((model) => model.isDefault && ids.includes(model.id));
    if (real) return { id: real.id, label: real.id, note: "padrao" };
  }
  // With no config and no isDefault, ids[0] is just alphabetical order. Hoisting
  // that and calling it the default would stamp a coin flip as a recommendation.
}

export function buildAgentScreen(
  harness: HarnessModels,
  index: number,
  total: number,
  configured?: string,
): Screen {
  const seen = new Set<string>();
  const grouped: PickerItem[] = [];
  for (const provider of harness.providers) {
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      grouped.push({ id: model.id, label: model.id, group: provider.provider });
    }
  }

  const pinned = pinnedFor(harness, [...seen], configured);
  const items = pinned ? [pinned, ...grouped.filter((item) => item.id !== pinned.id)] : grouped;

  return {
    agent: harness.agent,
    title: agentLabel(harness.agent),
    counter: `agente ${index + 1} de ${total}`,
    error: harness.error,
    items,
    pinned: pinned !== undefined,
    known: seen,
  };
}

export function buildScreens(
  harnesses: HarnessModels[],
  configured: Partial<Record<AgentId, string>>,
): Screen[] {
  const seen = new Set<AgentId>();
  // A merged disk cache can hand back the same agent twice.
  const installed = harnesses.filter((harness) => {
    if (!harness.available || seen.has(harness.agent)) return false;
    seen.add(harness.agent);
    return true;
  });
  return installed.map((harness, index) =>
    buildAgentScreen(harness, index, installed.length, configured[harness.agent]),
  );
}

export function collectSelections(
  results: ScreenResult[],
  existing: Partial<Record<AgentId, string>> | undefined,
  shown: number,
): { models: Partial<Record<AgentId, string>>; write: boolean } {
  // Starts from what was already saved: skipping has to leave it intact, and a
  // brand new map would wipe a choice made on an earlier run.
  const models: Partial<Record<AgentId, string>> = { ...(existing ?? {}) };
  for (const result of results) {
    if (result.kind === "picked") models[result.agent as AgentId] = result.id;
  }
  const aborted = results.some((result) => result.kind === "aborted");
  return { models, write: shown > 0 && !aborted };
}

/**
 * `question` never settles once the interface closes, so Ctrl+D at a prompt
 * leaves the wizard hanging with no way out. Racing the close event turns EOF
 * into "no answer" instead. The rejection path is the same verdict by another
 * road: asking again after a close throws ERR_USE_AFTER_CLOSE.
 */
function ask(readline: ReadlineInterface, prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const onClose = () => resolve(undefined);
    readline.once("close", onClose);
    const done = (answer: string | undefined) => {
      readline.off("close", onClose);
      resolve(answer);
    };
    readline.question(prompt).then(done, () => done(undefined));
  });
}

/** One numbered line on screen, and what picking that number means. */
export interface ModelChoice {
  number: number;
  agent: AgentId;
  model: string;
}

export interface ModelMenu {
  screen: string;
  choices: ModelChoice[];
  defaults: Partial<Record<AgentId, string>>;
  agents: AgentId[];
}

/**
 * Numbering runs across every agent rather than restarting per block, so one
 * line of input can answer all of them without saying which is which.
 */
export function buildModelMenu(
  harnesses: HarnessModels[],
  configured: Partial<Record<AgentId, string>> = {},
  width: number = 80,
): ModelMenu {
  const choices: ModelChoice[] = [];
  const defaults: Partial<Record<AgentId, string>> = {};
  const agents: AgentId[] = [];
  const blocks: string[] = [];
  const seen = new Set<AgentId>();

  for (const harness of harnesses) {
    if (!harness.available || seen.has(harness.agent)) continue;
    seen.add(harness.agent);
    agents.push(harness.agent);

    const ids = getModelIds(harness);
    const fallback = getDefaultModel(harness, ids, configured[harness.agent]);
    if (fallback) defaults[harness.agent] = fallback;

    if (ids.length === 0) {
      // Still listed, so the agent is visibly known rather than quietly gone,
      // and the one spelling that can set it is named right there.
      // Zero width forces the inline form: there is no list to align against.
      blocks.push(headingWith(agentLabel(harness.agent), `no models found, type ${harness.agent}=<id>`, 0));
      continue;
    }

    // opencode proxies the whole OpenRouter catalog, some 1500 ids. Printing it
    // scrolls every other agent off the screen, so the list is a shortlist and
    // the rest stays reachable by typing the id.
    const listed = ids.slice(0, MAX_LISTED);
    const entries = listed.map((id) => {
      choices.push({ number: choices.length + 1, agent: harness.agent, model: id });
      return `${String(choices.length).padStart(2)} ${id}`;
    });

    const grid = columnize(entries, width);
    const block = [
      headingWith(agentLabel(harness.agent), `Enter = ${fallback ?? "none"}`, blockWidth(grid)),
      ...grid,
    ];
    const hidden = ids.length - listed.length;
    if (hidden > 0) block.push(`${INDENT}+${hidden} more, type ${harness.agent}=<id> for any of them`);
    blocks.push(block.join("\n"));
  }

  return { screen: blocks.join("\n\n"), choices, defaults, agents };
}

export type ModelSelection =
  | { ok: true; models: Partial<Record<AgentId, string>> }
  | { ok: false; error: string };

/**
 * Reads one line covering every agent at once. A number picks a listed model,
 * `agent=id` names one the list does not carry, and a bare id is accepted when
 * exactly one agent offers it. An empty line takes every default.
 */
export function parseModelSelection(answer: string, menu: ModelMenu): ModelSelection {
  const models: Partial<Record<AgentId, string>> = {};
  const tokens = answer.trim().split(/\s+/).filter((token) => token !== "");

  for (const token of tokens) {
    let agent: AgentId | undefined;
    let model: string | undefined;

    const equals = token.indexOf("=");
    if (equals > 0) {
      const named = token.slice(0, equals) as AgentId;
      if (!menu.agents.includes(named)) {
        return { ok: false, error: `"${named}" is not an installed agent. Installed: ${menu.agents.join(", ")}.` };
      }
      agent = named;
      model = token.slice(equals + 1);
      if (!model) return { ok: false, error: `No model given after "${named}=".` };
    } else if (/^\d+$/.test(token)) {
      const choice = menu.choices.find((candidate) => candidate.number === Number(token));
      if (!choice) return { ok: false, error: `There is no ${token} on the list.` };
      agent = choice.agent;
      model = choice.model;
    } else {
      const owners = [...new Set(menu.choices.filter((c) => c.model === token).map((c) => c.agent))];
      if (owners.length === 0) {
        return { ok: false, error: `"${token}" is not on the list. Write it as <agent>=${token} to use it anyway.` };
      }
      if (owners.length > 1) {
        return { ok: false, error: `"${token}" is offered by ${owners.join(" and ")}. Write it as <agent>=${token}.` };
      }
      agent = owners[0];
      model = token;
    }

    if (models[agent] !== undefined) {
      return { ok: false, error: `Two models given for ${agentLabel(agent)}.` };
    }
    models[agent] = model;
  }

  return { ok: true, models };
}

/**
 * Run the interactive model setup. A non-TTY invocation returns immediately;
 * callers such as `open` can therefore invoke this safely without blocking.
 */
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

  const screens = buildScreens(harnesses, config.models ?? {});

  // Writing `models` is what marks first-run setup as done. Doing that after
  // showing nothing would spend the single prompt the user ever gets.
  if (screens.length === 0) {
    console.error("Warning: No installed agent reported any model; skipping model setup.");
    return config;
  }

  const dim = options.dimensions ?? readDimensions(output);
  if (dim.rows < MIN_ROWS) {
    console.error(`Warning: Terminal is ${dim.rows} rows, model setup needs ${MIN_ROWS}. Nothing was saved.`);
    return config;
  }

  const paint = colors(Boolean(output.isTTY) && !process.env.NO_COLOR);
  const results = await runScreens(screens, { input, output, onResize: watchResize }, paint);

  const { models, write } = collectSelections(results, config.models, screens.length);
  if (!write) {
    console.error("Warning: Model setup was interrupted; nothing was saved.");
    return config;
  }

  const updatedConfig: RunAgentConfig = { ...config, models };
  try {
    (options.save ?? saveConfig)(updatedConfig);
  } catch (error) {
    console.error(`Warning: Could not save config: ${error instanceof Error ? error.message : String(error)}`);
  }

  const summary = screens
    .map((screen) => `${screen.title} ${models[screen.agent as AgentId] ?? "unset"}`)
    .join(" · ");
  output.write(`\n  saved: ${summary}\n\n`);
  return updatedConfig;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Choose the model each installed agent should use")
    .option("--refresh", "ignore the cached catalog and rediscover")
    .action(async (opts: { refresh?: boolean }) => {
      // The message lives here rather than in the wizard, because `open` calls
      // the same function and has to stay quiet when it cannot prompt.
      if (!isInteractiveTerminal()) {
        console.error("codedeck setup needs a terminal on both stdin and stdout.");
        process.exitCode = 1;
        return;
      }
      await runModelSetupWizard({ refresh: opts.refresh });
    });
}
