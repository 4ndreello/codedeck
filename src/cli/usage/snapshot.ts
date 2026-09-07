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
    const periodLabel = range.period ? `período: ${range.period}` : `${range.since.slice(0, 10)} até ${range.until.slice(0, 10)}`;
    lines.push(renderLogo(`codedeck usage  ~  ${periodLabel}`));
  } else {
    lines.push(`CodeDeck Usage — ${range.since.slice(0, 10)} to ${range.until.slice(0, 10)}`);
    lines.push("");
  }

  // Summary Card
  const costStr = formatCurrency(totals.costUsd, totals.costComplete);
  const tokensStr = `${formatTokens(totals.totalTokens)} (${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cachedTokens)} cached)`;
  const sessionsStr = `${totals.sessionCount} (${totals.completedSessionCount} concluídas, ${totals.failedSessionCount} falhas${totals.activeSessionCount > 0 ? `, ${totals.activeSessionCount} ativas` : ""})`;

  lines.push(`  ${c.bold("Custo Total:")}    ${costStr} USD${!totals.costComplete ? c.dim(` (${totals.sessionsWithoutCost} sessões sem preço tabelado)`) : ""}`);
  lines.push(`  ${c.bold("Tokens:")}         ${tokensStr}`);
  lines.push(`  ${c.bold("Sessões:")}        ${sessionsStr}`);
  lines.push("");

  // Daily Evolution (if more than 1 day)
  if (byDay.length > 1 && options.by !== "repo" && options.by !== "model") {
    lines.push(`  ${c.dim("-- EVOLUÇÃO DIÁRIA " + "-".repeat(Math.max(0, Math.min(width - 24, 50))))}`);
    const maxDayCost = Math.max(...byDay.map((d) => d.costUsd), 0.01);

    for (const day of byDay) {
      const pct = Math.round((day.costUsd / maxDayCost) * 100);
      const bar = renderHorizontalBar(pct, 16);
      const dateLabel = padToWidth(day.key.slice(5), 6); // "09-07"
      const countLabel = padToWidth(`${day.sessionCount} sessões`, 13);
      const costLabel = padToWidth(formatCurrency(day.costUsd, day.costComplete), 10);
      lines.push(`  ${dateLabel}  ${c.dim(countLabel)}  ${c.bold(costLabel)}  ${bar} ${pct}%`);
    }
    lines.push("");
  }

  // Table by Dimension
  const dimension = options.by ?? "repo";
  let tableTitle = "-- CONSUMO POR PROJETO / REPOSITÓRIO ";
  let items: UsageMetricBucket[] = byRepository;

  if (dimension === "model") {
    tableTitle = "-- CONSUMO POR MODELO ";
    items = byModel;
  } else if (dimension === "day") {
    tableTitle = "-- CONSUMO POR DIA ";
    items = byDay;
  } else if (dimension === "agent") {
    tableTitle = "-- CONSUMO POR AGENTE ";
    items = result.byAgent;
  } else if (dimension === "run") {
    tableTitle = "-- CONSUMO POR RUN ";
    items = result.byRun;
  }

  lines.push(`  ${c.dim(tableTitle + "-".repeat(Math.max(0, Math.min(width - tableTitle.length - 4, 50))))}`);

  // Table header
  const colName = padToWidth(dimension === "model" ? "MODELO" : dimension === "agent" ? "AGENTE" : dimension === "run" ? "RUN" : "PROJETO", 28);
  const colSessions = padToWidth("SESSÕES", 9);
  const colTokens = padToWidth("TOKENS (IN/OUT/CACHE)", 26);
  const colCost = padToWidth("CUSTO", 10);
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
    lines.push(`  ${c.dim(`+ ${items.length - 10} itens ocultos...`)}`);
  }
  lines.push("");

  // Tip footer
  if (!isPlain) {
    lines.push(`  ${c.dim("(Dica: use 'codedeck usage -i' para TUI interativa com gráficos ou '-w' para monitorar ao vivo)")}`);
  }

  return lines.map((l) => truncate(l, width)).join("\n");
}
