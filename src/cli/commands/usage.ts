import fs from "node:fs";
import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import type { RunUsageSummary } from "../../core/run-usage.js";
import { buildUsageQueryParams } from "../../core/usage-query.js";
import type { UsageQueryParams, UsageQueryResult } from "../../daemon/protocol.js";
import { getPaths } from "../../config/paths.js";
import { SESSION_ID_PATTERN } from "../../open/runtime.js";
import { Database } from "../../store/database.js";
import { SessionStore, resolveUsageDateRange } from "../../store/sessions.js";
import { renderSnapshot } from "../usage/snapshot.js";
import { runDashboard, type DashboardFetcher } from "../usage/dashboard.js";
import { backfillUsage } from "./usage-backfill.js";
import { DEFAULT_WEB_PORT, parseWebPort, startWebServer } from "../../web/server.js";
import { createUsageRoutes } from "../../web/usage-routes.js";

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
  by?: "day" | "repo" | "model" | "agent" | "run" | "origin";
  tui?: boolean;
  watch?: boolean;
  interval?: string;
  observe?: string;
  backfill?: boolean;
  web?: boolean;
  port?: string;
  open?: boolean;
}

export interface UsageCommandDependencies {
  fetchUsageQuery?: typeof fetchUsageQuery;
  backfillUsage?: typeof backfillUsage;
  startServer?: typeof startWebServer;
}

function parseUsageObservation(value: string | undefined): { nativeId: string; costUsd: number } | undefined {
  if (value === undefined) return undefined;
  const separator = value.lastIndexOf("=");
  if (separator <= 0 || separator === value.length - 1) return undefined;

  const nativeId = value.slice(0, separator);
  const costUsd = Number(value.slice(separator + 1));
  if (!SESSION_ID_PATTERN.test(nativeId) || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
  return { nativeId, costUsd };
}

export function formatUsageSummary(summary: RunUsageSummary): string {
  const cost = `$${summary.costUsd.toFixed(2)}${summary.costComplete ? "" : "?"}`;
  return `Run ${summary.runId}: ${summary.sessionCount} sessions, ${summary.inputTokens} input / ${summary.outputTokens} output / ${summary.cachedTokens} cached tokens, cost ${cost}`;
}

function renderUsageSnapshot(
  result: UsageQueryResult,
  options: { plain: boolean; by: UsageCommandOptions["by"] },
): string {
  const { plain, by } = options;
  if (by !== "origin") return renderSnapshot(result, { plain, by });
  const rows = result.byOrigin.map((bucket) => {
    const cost = `$${bucket.costUsd.toFixed(2)}${bucket.costComplete ? "" : "?"}`;
    return `${bucket.key}: ${bucket.sessionCount} sessions, ${bucket.inputTokens} input / ${bucket.outputTokens} output / ${bucket.cachedTokens} cached tokens, cost ${cost}`;
  });
  return ["Usage by origin", ...rows].join("\n");
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
        byOrigin: [],
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

export function registerUsageCommand(program: Command, dependencies: UsageCommandDependencies = {}): void {
  const queryUsage = dependencies.fetchUsageQuery ?? fetchUsageQuery;
  const runBackfill = dependencies.backfillUsage ?? backfillUsage;

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
    .option("--by <dimension>", "group by dimension: day, repo, model, agent, run, origin")
    .option("--observe <nativeId=cost>", "report live orchestrator cost")
    .option("--backfill", "import historical orchestrator usage")
    .option("--web", "open aggregate usage in the browser")
    .option("--port <n>", "port to listen on (default: 3100)", String(DEFAULT_WEB_PORT))
    .option("--no-open", "serve usage without opening a browser")
    .option("-i, --tui", "open interactive full-screen TUI dashboard")
    .option("-w, --watch", "watch usage in real time with live updates")
    .option("--interval <seconds>", "refresh interval for --watch (default: 2)", "2")
    .option("--plain", "output plain text table without ANSI colors")
    .option("--json", "output usage data as JSON")
    .action(async (runId: string | undefined, opts: UsageCommandOptions) => {
      if (opts.backfill) {
        try {
          const summary = await runBackfill();
          if (opts.json) console.log(JSON.stringify(summary));
          else console.log(`Usage backfill: imported ${summary.imported}, skipped ${summary.skipped}`);
        } catch (error) {
          console.error(`Failed to backfill usage: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 3;
        }
        return;
      }

      if (opts.web && opts.tui) {
        console.error("Options --web and --tui cannot be used together.");
        process.exitCode = 2;
        return;
      }

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
          const observe = parseUsageObservation(opts.observe);
          summary = await client.request<RunUsageSummary>("usage.get", {
            runId: targetRunId,
            ...(observe ? { observe } : {}),
          });
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
      const cwd = process.cwd();
      const queryParams = buildUsageQueryParams(opts, cwd, new Date());

      if (opts.web) {
        let port: number;
        try {
          port = parseWebPort(opts.port);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
        }

        try {
          await (dependencies.startServer ?? startWebServer)({
            routes: createUsageRoutes({
              fetchUsageQuery: queryUsage,
              cwd,
              page: {
                by: opts.by,
                interval: opts.interval,
                filters: {
                  period: queryParams.period ?? "",
                  repo: queryParams.repository ?? "",
                  model: queryParams.model ?? "",
                  agent: queryParams.agent ?? "",
                  since: queryParams.since ?? "",
                  until: queryParams.until ?? "",
                },
              },
            }),
            port,
            initialPath: "/usage",
            title: "CodeDeck usage",
            open: opts.open,
          });
        } catch (error) {
          console.error(`Failed to listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
        return;
      }

      // Interactive TUI Mode
      if (opts.tui) {
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          console.error("Interactive TUI requires a TTY terminal.");
          process.exitCode = 1;
          return;
        }
        const fetcher: DashboardFetcher = {
          fetch: async (p) => queryUsage({ ...queryParams, period: p }),
        };
        await runDashboard(fetcher, { input: process.stdin, output: process.stdout });
        return;
      }

      // Live Watch Mode
      if (opts.watch) {
        const intervalSec = Math.max(1, Number(opts.interval) || 2);
        const printLive = async () => {
          const res = await queryUsage(queryParams);
          const snap = renderUsageSnapshot(res, { plain: false, by: opts.by });
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
        result = await queryUsage(queryParams);
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
        console.log(renderUsageSnapshot(result, { plain: isPlain, by: opts.by }));
      }
    });
}
