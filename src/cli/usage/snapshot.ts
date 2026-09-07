import type { UsageQueryResult, UsageMetricBucket } from "../../daemon/protocol.js";
import { colors, padToWidth, truncate, visibleWidth, ellipsizeEnd, renderLogo, type Colors } from "../ui.js";

export interface SnapshotOptions {
  plain?: boolean;
  by?: "day" | "repo" | "model" | "agent" | "run";
  terminalWidth?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatCurrency(n: number, complete = true): string {
  const symbol = complete ? "" : "?";
  return `$${n.toFixed(2)}${symbol}`;
}

function renderHorizontalBar(pct: number, maxBarWidth = 24): string {
  const filled = Math.max(0, Math.min(maxBarWidth, Math.round((pct / 100) * maxBarWidth)));
  const empty = Math.max(0, maxBarWidth - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export function renderSnapshot(result: UsageQueryResult, options: SnapshotOptions = {}): string {
  const isPlain = options.plain ?? false;
  const c: Colors = colors(!isPlain);
  const width = options.terminalWidth ?? (process.stdout.columns || 80);
  const lines: string[] = [];

  const { totals, range, byDay, byRepository, byModel } = result;

  // Header
  if (!isPlain && width >= 60) {
    const periodLabel = range.period ? `period: ${range.period}` : `${range.since.slice(0, 10)} to ${range.until.slice(0, 10)}`;
    lines.push(renderLogo(`codedeck usage  ~  ${periodLabel}`));
  } else {
    lines.push(`CodeDeck Usage — ${range.since.slice(0, 10)} to ${range.until.slice(0, 10)}`);
    lines.push("");
  }

  // Summary Card
  const costStr = formatCurrency(totals.costUsd, totals.costComplete);
  const tokensStr = `${formatTokens(totals.totalTokens)} (${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cachedTokens)} cached)`;
  const sessionsStr = `${totals.sessionCount} (${totals.completedSessionCount} completed, ${totals.failedSessionCount} failed${totals.activeSessionCount > 0 ? `, ${totals.activeSessionCount} active` : ""})`;

  lines.push(`  ${c.bold("Total Cost:")}    ${costStr} USD${!totals.costComplete ? c.dim(` (${totals.sessionsWithoutCost} sessions unpriced)`) : ""}`);
  lines.push(`  ${c.bold("Tokens:")}        ${tokensStr}`);
  lines.push(`  ${c.bold("Sessions:")}      ${sessionsStr}`);
  lines.push("");

  // Daily Evolution (if more than 1 day)
  if (byDay.length > 1 && options.by !== "repo" && options.by !== "model") {
    lines.push(`  ${c.dim("-- DAILY TIMELINE " + "-".repeat(Math.max(0, Math.min(width - 24, 50))))}`);
    const maxDayCost = Math.max(...byDay.map((d) => d.costUsd), 0.01);

    for (const day of byDay) {
      const pct = Math.round((day.costUsd / maxDayCost) * 100);
      const bar = renderHorizontalBar(pct, 16);
      const dateLabel = padToWidth(day.key.slice(5), 6); // "09-07"
      const countLabel = padToWidth(`${day.sessionCount} sessions`, 13);
      const costLabel = padToWidth(formatCurrency(day.costUsd, day.costComplete), 10);
      lines.push(`  ${dateLabel}  ${c.dim(countLabel)}  ${c.bold(costLabel)}  ${bar} ${pct}%`);
    }
    lines.push("");
  }

  // Table by Dimension
  const dimension = options.by ?? "repo";
  let tableTitle = "-- USAGE BY PROJECT / REPOSITORY ";
  let items: UsageMetricBucket[] = byRepository;

  if (dimension === "model") {
    tableTitle = "-- USAGE BY MODEL ";
    items = byModel;
  } else if (dimension === "day") {
    tableTitle = "-- USAGE BY DAY ";
    items = byDay;
  } else if (dimension === "agent") {
    tableTitle = "-- USAGE BY AGENT ";
    items = result.byAgent;
  } else if (dimension === "run") {
    tableTitle = "-- USAGE BY RUN ";
    items = result.byRun;
  }

  lines.push(`  ${c.dim(tableTitle + "-".repeat(Math.max(0, Math.min(width - tableTitle.length - 4, 50))))}`);

  // Table header
  const colName = padToWidth(dimension === "model" ? "MODEL" : dimension === "agent" ? "AGENT" : dimension === "run" ? "RUN" : "PROJECT", 28);
  const colSessions = padToWidth("SESSIONS", 9);
  const colTokens = padToWidth("TOKENS (IN/OUT/CACHE)", 26);
  const colCost = padToWidth("COST", 10);
  const colShare = padToWidth("%", 5);

  lines.push(`  ${c.dim(`${colName}  ${colSessions}  ${colTokens}  ${colCost}  ${colShare}`)}`);
  lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 80)))}`);

  const displayItems = items.slice(0, 10);
  const totalCost = totals.costUsd || 0.01;

  for (const item of displayItems) {
    let cleanName = item.label || item.key;
    if (cleanName.includes("/")) {
      const parts = cleanName.split("/");
      cleanName = parts[parts.length - 1] || cleanName;
    }
    const nameCell = ellipsizeEnd(cleanName, 28);
    const sessionsCell = padToWidth(String(item.sessionCount), 9);
    const tokCell = padToWidth(`${formatTokens(item.inputTokens)} / ${formatTokens(item.outputTokens)} / ${formatTokens(item.cachedTokens)}`, 26);
    const costCell = padToWidth(formatCurrency(item.costUsd, item.costComplete), 10);
    const pctShare = Math.round((item.costUsd / totalCost) * 100);
    const shareCell = padToWidth(`${pctShare}%`, 5);

    lines.push(`  ${nameCell}  ${sessionsCell}  ${tokCell}  ${c.bold(costCell)}  ${c.dim(shareCell)}`);
  }

  if (items.length > 10) {
    lines.push(`  ${c.dim(`+ ${items.length - 10} hidden items...`)}`);
  }
  lines.push("");

  // Tip footer
  if (!isPlain) {
    lines.push(`  ${c.dim("(Tip: use 'codedeck usage -i' for interactive TUI charts or '-w' to watch live)")}`);
  }

  return lines.map((l) => truncate(l, width)).join("\n");
}
