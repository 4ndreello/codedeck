import type { Command } from "commander";
import type { DriverRegistry } from "../../core/driver.js";
import {
  getCachedOrDiscoverModels,
  type HarnessModels,
} from "../../core/models.js";
import type { AgentId } from "../../core/session.js";
import type { PickerItem, Screen, ScreenResult } from "../picker-state.js";
import { runScreens } from "../picker.js";
import { colors, readDimensions, type Dimensions } from "../ui.js";
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

const AGENT_LABELS: Partial<Record<AgentId, string>> = { claude: "Claude Code", codex: "Codex", omp: "omp" };

function agentLabel(agent: AgentId): string {
  return AGENT_LABELS[agent] ?? agent;
}

function pinnedFor(harness: HarnessModels, ids: string[], configured?: string): PickerItem | undefined {
  if (configured) {
    // A saved id the catalog no longer lists still gets shown. Hiding it is how
    // the wizard used to answer `open`'s own "that model is gone, run setup":
    // the user arrived here and could not see which model it meant. Marking it
    // synthetic makes keeping it cost the same second Enter as typing it.
    return ids.includes(configured)
      ? { id: configured, label: configured, note: "atual" }
      : { id: configured, label: configured, note: "atual, fora do catalogo", synthetic: true };
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
      // A driver reporting a blank id used to become a selectable blank row
      // that Enter would save as the model. The line wizard guarded this and
      // the port dropped the guard.
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      grouped.push({ id, label: id, group: provider.provider });
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
