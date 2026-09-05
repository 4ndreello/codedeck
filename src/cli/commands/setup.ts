import type { Command } from "commander";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { DriverRegistry } from "../../core/driver.js";
import {
  getCachedOrDiscoverModels,
  type HarnessModels,
} from "../../core/models.js";
import type { AgentId } from "../../core/session.js";
import { getRegistry } from "../../drivers/registry.js";
import {
  loadConfig,
  saveConfig,
  type RunAgentConfig,
} from "../../config/config.js";

export interface ModelWizardOptions {
  config?: RunAgentConfig;
  registry?: DriverRegistry;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
  discoverModels?: (registry: DriverRegistry) => Promise<HarnessModels[]>;
  save?: (config: RunAgentConfig) => void;
}

/**
 * The open command uses this decision before creating a readline interface.
 * Keeping the terminal state as an argument makes the first-run policy pure.
 */
export function needsModelSetup(
  config: RunAgentConfig | null | undefined,
  // The wizard reads answers, so an interactive stdout is not enough: a piped
  // stdin would leave `question` waiting on input that never arrives.
  isTTY: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): boolean {
  if (!isTTY) return false;
  return config == null || config.models == null;
}


function getModelIds(harness: HarnessModels): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const provider of harness.providers) {
    for (const model of provider.models) {
      if (typeof model.id !== "string" || model.id.trim() === "" || seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push(model.id);
    }
  }
  return ids;
}

function getDefaultModel(harness: HarnessModels, ids: string[], configured?: string): string | undefined {
  if (configured && ids.includes(configured)) return configured;
  for (const provider of harness.providers) {
    const model = provider.models.find((candidate) => candidate.isDefault && ids.includes(candidate.id));
    if (model) return model.id;
  }
  return ids[0];
}

async function askForModel(
  readline: ReadlineInterface,
  harness: HarnessModels,
  configured?: string,
): Promise<string | undefined> {
  const ids = getModelIds(harness);
  const agentName = harness.agent === "claude" ? "Claude Code" : harness.agent.charAt(0).toUpperCase() + harness.agent.slice(1);

  if (ids.length === 0) {
    const answer = await readline.question(
      `No models discovered for ${agentName}. Enter a model id (or press Enter to skip): `,
    );
    const model = answer.trim();
    return model || configured;
  }

  const defaultModel = getDefaultModel(harness, ids, configured);
  const choices = ids.map((id, index) => `${index + 1}) ${id}`).join("  ");
  const answer = await readline.question(
    `${agentName} model [${defaultModel ?? "enter an id"}] ${choices}\nChoose a number or enter a model id: `,
  );
  const selected = answer.trim();
  if (selected === "") return defaultModel ?? configured;

  const number = Number(selected);
  if (Number.isInteger(number) && number >= 1 && number <= ids.length) return ids[number - 1];
  return selected;
}

/**
 * Run the interactive model setup. A non-TTY invocation returns immediately;
 * callers such as `open` can therefore invoke this safely without blocking.
 */
export async function runModelSetupWizard(options: ModelWizardOptions = {}): Promise<RunAgentConfig> {
  const config = options.config ?? loadConfig();
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) return config;

  const registry = options.registry ?? getRegistry();
  let harnesses: HarnessModels[];
  try {
    const discover = options.discoverModels ?? ((selectedRegistry: DriverRegistry) =>
      getCachedOrDiscoverModels(selectedRegistry));
    harnesses = await discover(registry);
  } catch (error) {
    console.error(`Warning: Could not discover models: ${error instanceof Error ? error.message : String(error)}`);
    harnesses = [];
  }

  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const readline = createInterface({ input, output, terminal: false });
  const models: Partial<Record<AgentId, string>> = { ...(config.models ?? {}) };

  let asked = 0;
  try {
    const seenAgents = new Set<AgentId>();
    for (const harness of harnesses) {
      if (!harness.available || seenAgents.has(harness.agent)) continue;
      seenAgents.add(harness.agent);
      asked += 1;
      const selected = await askForModel(readline, harness, config.models?.[harness.agent]);
      if (selected) models[harness.agent] = selected;
    }
  } finally {
    readline.close();
  }

  // Writing `models` is what marks first-run setup as done. Doing that after
  // asking nothing (discovery failed, or no harness is installed) would burn
  // the one prompt the user gets and never offer it again, so leave the config
  // untouched and let the next run try again.
  if (asked === 0) {
    console.error("Warning: No installed agent reported any model; skipping model setup.");
    return config;
  }

  const updatedConfig: RunAgentConfig = { ...config, models };
  const persist = options.save ?? saveConfig;
  try {
    persist(updatedConfig);
  } catch (error) {
    console.error(`Warning: Could not save config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return updatedConfig;
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Choose the default model for each installed agent")
    .action(async () => {
      await runModelSetupWizard();
    });
}
