import fs from "node:fs";
import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import type { RunUsageSummary } from "../../core/run-usage.js";
import type { AgentId } from "../../core/session.js";
import type { UsagePeriod, UsageQueryParams, UsageQueryResult } from "../../daemon/protocol.js";
import { getPaths } from "../../config/paths.js";
import { Database } from "../../store/database.js";
import { SessionStore, resolveUsageDateRange } from "../../store/sessions.js";
import { renderSnapshot } from "../usage/snapshot.js";
import { runDashboard, type DashboardFetcher } from "../usage/dashboard.js";

export interface UsageCommandOptions {
  json?: boolean;
  plain?: boolean;
  today?: boolean;
  days?: string;
  since?: string;
  until?: string;
  all?: boolean;
  repo?: string;
  current?: boolean;
  model?: string;
  agent?: string;
  run?: string;
  by?: "day" | "repo" | "model" | "agent" | "run";
  tui?: boolean;
  watch?: boolean;
  interval?: string;
}

export function formatUsageSummary(summary: RunUsageSummary): string {
  const cost = `$${summary.costUsd.toFixed(2)}${summary.costComplete ? "" : "?"}`;
  return `Run ${summary.runId}: ${summary.sessionCount} sessions, ${summary.inputTokens} input / ${summary.outputTokens} output / ${summary.cachedTokens} cached tokens, cost ${cost}`;
}

export async function fetchUsageQuery(params: UsageQueryParams): Promise<UsageQueryResult> {
  const client = new IpcClient();
  try {
    return await client.request<UsageQueryResult>("usage.query", params);
  } catch {
    // If daemon is not running or IPC fails, fallback to direct SQLite read-only mode!
    const paths = getPaths();
    if (!fs.existsSync(paths.db)) {
      const { since, until } = resolveUsageDateRange(params);
      return {
        range: { period: params.period, since, until },
        totals: {
          sessionCount: 0,
          activeSessionCount: 0,
          completedSessionCount: 0,
          failedSessionCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          costComplete: true,
          sessionsWithoutCost: 0,
        },
        byDay: [],
        byRepository: [],
        byModel: [],
        byAgent: [],
        byRun: [],
      };
    }

    const db = new Database(paths.db, { readOnly: true });
    try {
      const store = new SessionStore(db.getHandle());
      return store.queryUsage(params);
    } finally {
      db.close();
    }
  }
}

export function registerUsageCommand(program: Command): void {
  program
    .command("usage")
    .description("Show token usage, costs, and analytics across sessions or for a run")
    .argument("[run-id]", "run id to inspect (legacy single-run mode)")
    .option("--run <id>", "run id to inspect")
    .option("-t, --today", "filter usage from start of today")
    .option("-d, --days <days>", "filter usage for the last N days (e.g. 3, 7, 30)")
    .option("--since <date>", "start date (YYYY-MM-DD or ISO)")
    .option("--until <date>", "end date (YYYY-MM-DD or ISO)")
    .option("--all", "include all historical usage")
    .option("-r, --repo <repo>", "filter by repository or working directory")
    .option("-c, --current", "filter by current working directory repository")
    .option("-m, --model <model>", "filter by model name")
    .option("-a, --agent <agent>", "filter by agent harness (e.g. codex, claude)")
    .option("--by <dimension>", "group by dimension: day, repo, model, agent, run")
    .option("-i, --tui", "open interactive full-screen TUI dashboard")
    .option("-w, --watch", "watch usage in real time with live updates")
    .option("--interval <seconds>", "refresh interval for --watch (default: 2)", "2")
    .option("--plain", "output plain text table without ANSI colors")
    .option("--json", "output usage data as JSON")
    .action(async (runId: string | undefined, opts: UsageCommandOptions) => {
      const targetRunId = opts.run ?? runId;

      // 1. Single-Run Branch (100% Backwards Compatible with statusline.sh)
      if (targetRunId) {
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
          summary = await client.request<RunUsageSummary>("usage.get", { runId: targetRunId });
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 3;
          return;
        }

        if (opts.json) console.log(JSON.stringify(summary));
        else console.log(formatUsageSummary(summary));
        return;
      }

      // 2. Aggregate Analytics Branch
      let period: UsagePeriod | undefined;
      let since = opts.since;
      const until = opts.until;

      if (opts.all) {
        period = "all";
      } else if (opts.today) {
        period = "today";
      } else if (opts.days) {
        const d = parseInt(opts.days, 10);
        if (d === 3) period = "3d";
        else if (d === 7) period = "7d";
        else if (d === 30) period = "30d";
        else if (!isNaN(d) && d > 0) {
          const now = new Date();
          const sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (d - 1), 0, 0, 0, 0);
          since = sinceDate.toISOString();
        }
      } else if (!since) {
        // Default to today if no temporal flags provided
        period = "today";
      }

      let repository = opts.repo;
      if (opts.current) {
        repository = process.cwd();
      }

      const queryParams: UsageQueryParams = {
        period,
        since,
        until,
        repository,
        model: opts.model,
        agent: opts.agent as AgentId | undefined,
      };

      // Interactive TUI Mode
      if (opts.tui) {
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          console.error("Interactive TUI requires a TTY terminal.");
          process.exitCode = 1;
          return;
        }
        const fetcher: DashboardFetcher = {
          fetch: async (p) => fetchUsageQuery({ ...queryParams, period: p }),
        };
        await runDashboard(fetcher, { input: process.stdin, output: process.stdout });
        return;
      }

      // Live Watch Mode
      if (opts.watch) {
        const intervalSec = Math.max(1, Number(opts.interval) || 2);
        const printLive = async () => {
          const res = await fetchUsageQuery(queryParams);
          const snap = renderSnapshot(res, { plain: false, by: opts.by });
          process.stdout.write(`\x1b[H\x1b[2J${snap}\n\n  \x1b[2mUpdating every ${intervalSec}s... (Ctrl+C to quit)\x1b[0m\n`);
        };
        await printLive();
        const timer = setInterval(() => { void printLive(); }, intervalSec * 1000);
        process.on("SIGINT", () => {
          clearInterval(timer);
          process.exit(0);
        });
        return;
      }

      // Standard Fetch
      let result: UsageQueryResult;
      try {
        result = await fetchUsageQuery(queryParams);
      } catch (error) {
        console.error(`Failed to fetch usage: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 3;
        return;
      }

      // Output formats
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const isPlain = opts.plain ?? !process.stdout.isTTY;
        console.log(renderSnapshot(result, { plain: isPlain, by: opts.by }));
      }
    });
}
