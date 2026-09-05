import type { Command } from "commander";
import { IpcClient, isDaemonRunning } from "../../daemon/ipc.js";
import { getRegistry } from "../../drivers/registry.js";
import {
  getCachedOrDiscoverModels,
  type HarnessModels,
  type ModelInfo,
  type ProviderModels,
} from "../../core/models.js";
import type { AgentId } from "../../core/session.js";

export interface ModelsCliOptions {
  provider?: string;
  search?: string;
  all?: boolean;
  refresh?: boolean;
  json?: boolean;
}

export function filterHarnessModels(
  harnesses: HarnessModels[],
  options: ModelsCliOptions,
): HarnessModels[] {
  const search = options.search?.toLowerCase().trim();
  const providerFilter = options.provider?.toLowerCase().trim();

  return harnesses.map((h) => {
    let providers = h.providers;

    if (providerFilter) {
      providers = providers.filter(
        (p) =>
          p.provider.toLowerCase().includes(providerFilter) ||
          (p.displayName && p.displayName.toLowerCase().includes(providerFilter)),
      );
    }

    if (search) {
      providers = providers
        .map((p) => {
          const matchingModels = p.models.filter(
            (m) =>
              m.id.toLowerCase().includes(search) ||
              m.name.toLowerCase().includes(search) ||
              m.provider.toLowerCase().includes(search) ||
              (m.aliases && m.aliases.some((a) => a.toLowerCase().includes(search))),
          );
          return { ...p, models: matchingModels };
        })
        .filter((p) => p.models.length > 0);
    }

    return { ...h, providers };
  });
}

export function renderModelsTree(
  harnesses: HarnessModels[],
  options: ModelsCliOptions = {},
): string {
  const isTty = process.stdout.isTTY ?? false;
  const bold = (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s);
  const green = (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (isTty ? `\x1b[31m${s}\x1b[0m` : s);
  const cyan = (s: string) => (isTty ? `\x1b[36m${s}\x1b[0m` : s);
  const yellow = (s: string) => (isTty ? `\x1b[33m${s}\x1b[0m` : s);

  const lines: string[] = [];

  for (let hIdx = 0; hIdx < harnesses.length; hIdx++) {
    const h = harnesses[hIdx];
    const status = h.available
      ? green("(installed)")
      : red(`(not available${h.error ? `: ${h.error}` : ""})`);

    lines.push(`${bold(cyan(h.agent))} ${status}`);

    if (!h.available || h.providers.length === 0) {
      if (h.available) {
        lines.push(`  ${dim("No models discovered")}`);
      }
      if (hIdx < harnesses.length - 1) lines.push("");
      continue;
    }

    for (let pIdx = 0; pIdx < h.providers.length; pIdx++) {
      const p = h.providers[pIdx];
      const isLastProvider = pIdx === h.providers.length - 1;
      const pBranch = isLastProvider ? "└── " : "├── ";
      const pIndent = isLastProvider ? "    " : "│   ";

      const countStr = dim(`(${p.models.length} model${p.models.length === 1 ? "" : "s"})`);
      lines.push(`  ${pBranch}${bold(p.displayName || p.provider)} ${countStr}`);

      const sortedModels = [...p.models].sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        const aAliases = a.aliases && a.aliases.length > 0 ? 1 : 0;
        const bAliases = b.aliases && b.aliases.length > 0 ? 1 : 0;
        if (aAliases !== bAliases) return bAliases - aAliases;
        return 0;
      });

      const maxDisplay = options.all || options.provider ? sortedModels.length : 8;
      const visibleModels = sortedModels.slice(0, maxDisplay);
      const remainingCount = sortedModels.length - visibleModels.length;

      for (let mIdx = 0; mIdx < visibleModels.length; mIdx++) {
        const m = visibleModels[mIdx];
        const isLastModel = mIdx === visibleModels.length - 1 && remainingCount === 0;
        const mBranch = isLastModel ? "└── " : "├── ";

        let line = `  ${pIndent}${mBranch}${m.id}`;

        if (m.name && m.name !== m.id) {
          line += ` ${dim(`(${m.name})`)}`;
        }

        if (m.aliases && m.aliases.length > 0) {
          line += ` ${yellow(`[alias: ${m.aliases.join(", ")}]`)}`;
        }

        if (m.reasoningEfforts && m.reasoningEfforts.length > 0) {
          line += ` ${dim(`[effort: ${m.reasoningEfforts.join(", ")}]`)}`;
        }

        if (m.isDefault) {
          line += ` ${green("(default)")}`;
        }

        lines.push(line);
      }

      if (remainingCount > 0) {
        lines.push(
          `  ${pIndent}└── ${dim(`... and ${remainingCount} more models. (Use '--all' or '--provider ${p.provider}' to view all)`)}`,
        );
      }
    }

    if (hIdx < harnesses.length - 1) lines.push("");
  }

  return lines.join("\n");
}

export function registerModelsCommand(program: Command): void {
  program
    .command("models [agent]")
    .description("List available models and reasoning options from agent harnesses")
    .option("-p, --provider <provider>", "filter by provider (e.g. openai, anthropic, openrouter)")
    .option("-q, --search <query>", "search models by substring")
    .option("--all", "show all models without truncation for large catalogs")
    .option("--refresh", "bypass cache and refresh model catalogs from harnesses")
    .option("--json", "output JSON with complete model details")
    .action(async (agentArg?: string, opts: ModelsCliOptions = {}) => {
      const validAgents: AgentId[] = ["claude", "codex", "opencode", "omp"];
      let agent: AgentId | undefined;

      if (agentArg) {
        const normalized = agentArg.toLowerCase() as AgentId;
        if (!validAgents.includes(normalized)) {
          console.error(
            `Invalid agent "${agentArg}". Available agents: ${validAgents.join(", ")}`,
          );
          process.exit(1);
        }
        agent = normalized;
      }

      let harnesses: HarnessModels[] = [];

      try {
        const daemonRunning = await isDaemonRunning();
        if (daemonRunning) {
          const client = new IpcClient();
          const res = (await client.request("models.list", {
            agent,
            refresh: opts.refresh,
          })) as { agents: HarnessModels[] };
          harnesses = res.agents || [];
        } else {
          // Direct standalone discovery
          const registry = getRegistry();
          harnesses = await getCachedOrDiscoverModels(registry, {
            agent,
            refresh: opts.refresh,
          });
        }
      } catch (e) {
        console.error(`Failed to list models: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const filtered = filterHarnessModels(harnesses, opts);

      if (opts.json) {
        console.log(JSON.stringify(filtered, null, 2));
        return;
      }

      const totalModels = filtered.reduce(
        (acc, h) => acc + h.providers.reduce((pAcc, p) => pAcc + p.models.length, 0),
        0,
      );

      if ((opts.search || opts.provider) && totalModels === 0) {
        console.log("No models found matching the criteria.");
        return;
      }

      console.log(renderModelsTree(filtered, opts));
    });
}
