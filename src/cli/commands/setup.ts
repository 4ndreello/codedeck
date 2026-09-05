import type { Command } from "commander";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { DriverRegistry } from "../../core/driver.js";
import {
  flattenModels,
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

/**
 * `question` never settles once the interface closes, so Ctrl+D at a prompt
 * leaves the wizard hanging with no way out. Racing the close event turns EOF
 * into "no answer" instead. The rejection path is the same verdict by another
 * road: asking again after a close throws ERR_USE_AFTER_CLOSE.
 *
 * Known limit, and not worth code here: input delivered as one burst rather
 * than a line at a time (a piped fixture, never a terminal) drains every line
 * while only the first question is pending, so the rest are lost and the run
 * reports itself interrupted. It saves nothing when that happens, which is the
 * safe outcome, and the wizard only ever runs on a TTY.
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

/** A skipped question and a walked-out wizard need different handling. */
type ModelAnswer = { aborted: true } | { aborted: false; model?: string };

const chose = (model?: string): ModelAnswer => ({ aborted: false, model });

async function askForModel(
  readline: ReadlineInterface,
  harness: HarnessModels,
  configured?: string,
): Promise<ModelAnswer> {
  const ids = getModelIds(harness);
  const agentName = harness.agent === "claude" ? "Claude Code" : harness.agent.charAt(0).toUpperCase() + harness.agent.slice(1);

  if (ids.length === 0) {
    const answer = await ask(
      readline,
      `No models discovered for ${agentName}. Enter a model id (or press Enter to skip): `,
    );
    if (answer === undefined) return { aborted: true };
    return chose(answer.trim() || configured);
  }

  const defaultModel = getDefaultModel(harness, ids, configured);
  const choices = ids.map((id, index) => `${index + 1}) ${id}`).join("  ");
  const answer = await ask(
    readline,
    `${agentName} model [${defaultModel ?? "enter an id"}] ${choices}\nChoose a number or enter a model id: `,
  );
  if (answer === undefined) return { aborted: true };
  const selected = answer.trim();
  if (selected === "") return chose(defaultModel ?? configured);

  const number = Number(selected);
  if (Number.isInteger(number) && number >= 1 && number <= ids.length) return chose(ids[number - 1]);
  return chose(selected);
}

/**
 * Run the interactive model setup. A non-TTY invocation returns immediately;
 * callers such as `open` can therefore invoke this safely without blocking.
 */
export async function runModelSetupWizard(options: ModelWizardOptions = {}): Promise<RunAgentConfig> {
  const config = options.config ?? loadConfig();
  const isTTY = options.isTTY ?? isInteractiveTerminal();
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
  let aborted = false;
  try {
    const seenAgents = new Set<AgentId>();
    for (const harness of harnesses) {
      if (!harness.available || seenAgents.has(harness.agent)) continue;
      seenAgents.add(harness.agent);
      asked += 1;
      const answer = await askForModel(readline, harness, config.models?.[harness.agent]);
      // Walking out is reported by the answer itself rather than by watching
      // for a close event: the normal path closes the interface too, so the
      // event cannot tell the two apart.
      if (answer.aborted) {
        aborted = true;
        break;
      }
      if (answer.model) models[harness.agent] = answer.model;
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

  // Same reasoning for a walk-out: Ctrl+D partway through is not an answer, so
  // half the choices are not worth marking setup as done.
  if (aborted) {
    console.error("Warning: Model setup was interrupted; nothing was saved.");
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
