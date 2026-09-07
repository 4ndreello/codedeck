import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import type { RunUsageSummary } from "../../core/run-usage.js";

interface UsageCommandOptions {
  json?: boolean;
}

export function formatUsageSummary(summary: RunUsageSummary): string {
  const cost = `$${summary.costUsd.toFixed(2)}${summary.costComplete ? "" : "?"}`;
  return `Run ${summary.runId}: ${summary.sessionCount} sessions, ${summary.inputTokens} input / ${summary.outputTokens} output / ${summary.cachedTokens} cached tokens, cost ${cost}`;
}

export function registerUsageCommand(program: Command): void {
  program
    .command("usage")
    .description("Show aggregated usage for a run")
    .argument("<run-id>", "run id")
    .option("--json", "output the aggregated usage as JSON")
    .action(async (runId: string, opts: UsageCommandOptions) => {
      const client = new IpcClient();
      try {
        await client.ensureDaemonStarted();
      } catch (error) {
        console.error(`Failed to start daemon: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 3;
        return;
      }

      let summary: RunUsageSummary;
      try {
        summary = await client.request<RunUsageSummary>("usage.get", { runId });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 3;
        return;
      }

      if (opts.json) console.log(JSON.stringify(summary));
      else console.log(formatUsageSummary(summary));
    });
}
