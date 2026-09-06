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
  loadConfig,
  saveConfig,
  type RoleBinding,
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
  const results = await runScreens(screens, { input, output, onResize: watchResize }, paint);

  const { agents, write } = collectSelections(results, config.agents, screens.length);
  if (!write) {
    console.error("Warning: Model setup was interrupted; nothing was saved.");
    return config;
  }

  const updatedConfig: RunAgentConfig = { ...config, agents };
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
  output.write(`\n  saved: ${summary}\n\n`);
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
