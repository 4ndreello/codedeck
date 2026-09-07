import { emitKeypressEvents } from "node:readline";
import type { UsageQueryResult, UsagePeriod } from "../../daemon/protocol.js";
import { colors, readDimensions, truncate, visibleWidth, padToWidth, ellipsizeEnd, type Colors } from "../ui.js";
import { renderBarChart, type BarDatum } from "../charts/bar-chart.js";
import { renderStackedBar } from "../charts/stacked-bar.js";
import { renderSparkline } from "../charts/sparkline.js";

export interface DashboardFetcher {
  fetch(period: UsagePeriod): Promise<UsageQueryResult>;
}

export interface DashboardIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
  output: NodeJS.WritableStream & { rows?: number; columns?: number; isTTY?: boolean };
}

const PERIODS: UsagePeriod[] = ["today", "3d", "7d", "30d", "all"];
const PERIOD_LABELS: Record<UsagePeriod, string> = {
  today: "Hoje",
  "3d": "3 Dias",
  "7d": "7 Dias",
  "30d": "30 Dias",
  all: "Tudo",
};

const TABS = ["1: Geral", "2: Projetos", "3: Modelos", "4: Runs"];

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

export async function runDashboard(fetcher: DashboardFetcher, io: DashboardIO): Promise<void> {
  const { input, output } = io;

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive dashboard requires a TTY terminal");
  }

  let currentTab = 0; // 0: Overview, 1: Projects, 2: Models, 3: Runs
  let currentPeriodIdx = 1; // Default to 3d
  let scrollOffset = 0;
  let data: UsageQueryResult | null = null;
  let loading = true;
  let errorMessage: string | null = null;

  const c: Colors = colors(true);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      output.write("\x1b[?25h\x1b[?1049l"); // Show cursor, exit alternate buffer
    } catch {}
    input.setRawMode?.(false);
    input.pause();
  };

  const onExit = () => restore();
  const onSigterm = () => {
    restore();
    process.exit(143);
  };
  const onSigint = () => {
    restore();
    process.exit(130);
  };

  process.on("exit", onExit);
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  const loadData = async () => {
    loading = true;
    errorMessage = null;
    paint();
    try {
      data = await fetcher.fetch(PERIODS[currentPeriodIdx]);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      paint();
    }
  };

  const renderScreen = (): string[] => {
    const dim = readDimensions(output);
    const width = dim.columns;
    const height = dim.rows;
    const lines: string[] = [];

    // Header bar
    const tabHeaders = TABS.map((t, idx) => (idx === currentTab ? c.bold(c.invert(` ${t} `)) : ` ${t} `)).join(" ");
    lines.push(`  ${tabHeaders}`);

    // Period selector
    const periodLine = PERIODS.map((p, idx) => {
      const label = PERIOD_LABELS[p];
      return idx === currentPeriodIdx ? c.bold(`[${label}]`) : c.dim(` ${label} `);
    }).join("  ");
    lines.push(`  Período: ${periodLine}`);
    lines.push(`  ${c.dim("─".repeat(Math.max(10, width - 4)))}`);

    if (loading) {
      lines.push("");
      lines.push("  Carregando métricas de consumo...");
      return lines.map((l) => truncate(l, width));
    }

    if (errorMessage) {
      lines.push("");
      lines.push(`  ${c.bold("Erro ao carregar dados:")} ${errorMessage}`);
      lines.push(`  Pressione 'r' para tentar novamente ou 'q' para sair.`);
      return lines.map((l) => truncate(l, width));
    }

    if (!data) return lines;

    const { totals, byDay, byRepository, byModel, byRun } = data;

    // Tab 0: Overview
    if (currentTab === 0) {
      // KPI summary
      const costText = `${c.bold(formatCurrency(totals.costUsd, totals.costComplete))} USD`;
      const tokText = `${formatTokens(totals.totalTokens)} (${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cachedTokens)} cached)`;
      const sessText = `${totals.sessionCount} (${totals.completedSessionCount} concluídas, ${totals.failedSessionCount} falhas)`;

      lines.push(`  ${c.bold("Custo Total:")} ${costText}   ${c.bold("Sessões:")} ${sessText}`);
      lines.push(`  ${c.bold("Tokens:")}      ${tokText}`);
      lines.push("");

      // Bar Chart for daily cost
      if (byDay.length > 0) {
        lines.push(`  ${c.dim("-- TIMELINE DE CUSTO DIÁRIO (USD) " + "-".repeat(Math.max(0, width - 45)))}`);
        const chartData: BarDatum[] = byDay.map((d) => ({
          label: d.key,
          value: d.costUsd,
        }));
        const chartLines = renderBarChart(chartData, { height: Math.min(5, Math.max(3, height - 18)) });
        for (const cl of chartLines) lines.push(cl);
        lines.push("");
      }

      // Proportional bar for models
      if (byModel.length > 0) {
        lines.push(`  ${c.dim("-- DISTRIBUIÇÃO POR MODELO " + "-".repeat(Math.max(0, width - 35)))}`);
        const segments = byModel.slice(0, 5).map((m) => ({
          key: m.key,
          label: m.key.replace("claude-", "").replace("gemini-", "").replace("meta/", ""),
          value: m.costUsd || m.totalTokens,
        }));
        const stacked = renderStackedBar(segments, Math.min(width - 6, 60));
        lines.push(`  ${stacked.bar}`);
        if (stacked.legend) lines.push(`  ${c.dim(stacked.legend)}`);
        lines.push("");
      }
    }

    // Tab 1: Projects
    if (currentTab === 1) {
      lines.push(`  ${c.dim(padToWidth("PROJETO / REPOSITÓRIO", 36) + "  " + padToWidth("SESSÕES", 9) + "  " + padToWidth("TOKENS", 20) + "  " + padToWidth("CUSTO", 10))}`);
      lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 80)))}`);
      for (let i = scrollOffset; i < byRepository.length; i++) {
        const item = byRepository[i];
        let name = item.label || item.key;
        if (name.includes("/")) {
          const parts = name.split("/");
          name = parts[parts.length - 1] || name;
        }
        lines.push(`  ${ellipsizeEnd(name, 36)}  ${padToWidth(String(item.sessionCount), 9)}  ${padToWidth(formatTokens(item.totalTokens), 20)}  ${c.bold(padToWidth(formatCurrency(item.costUsd, item.costComplete), 10))}`);
      }
    }

    // Tab 2: Models
    if (currentTab === 2) {
      lines.push(`  ${c.dim(padToWidth("MODELO", 32) + "  " + padToWidth("SESSÕES", 9) + "  " + padToWidth("IN / OUT / CACHED", 26) + "  " + padToWidth("CUSTO", 10))}`);
      lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 80)))}`);
      for (let i = scrollOffset; i < byModel.length; i++) {
        const item = byModel[i];
        const tok = `${formatTokens(item.inputTokens)} / ${formatTokens(item.outputTokens)} / ${formatTokens(item.cachedTokens)}`;
        lines.push(`  ${ellipsizeEnd(item.key, 32)}  ${padToWidth(String(item.sessionCount), 9)}  ${padToWidth(tok, 26)}  ${c.bold(padToWidth(formatCurrency(item.costUsd, item.costComplete), 10))}`);
      }
    }

    // Tab 3: Runs
    if (currentTab === 3) {
      lines.push(`  ${c.dim(padToWidth("RUN ID / NOME", 36) + "  " + padToWidth("SESSÕES", 9) + "  " + padToWidth("TOKENS", 18) + "  " + padToWidth("CUSTO", 10))}`);
      lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 80)))}`);
      for (let i = scrollOffset; i < byRun.length; i++) {
        const item = byRun[i];
        lines.push(`  ${ellipsizeEnd(item.label || item.key, 36)}  ${padToWidth(String(item.sessionCount), 9)}  ${padToWidth(formatTokens(item.totalTokens), 18)}  ${c.bold(padToWidth(formatCurrency(item.costUsd, item.costComplete), 10))}`);
      }
    }

    // Fill blank lines up to height - 2
    while (lines.length < height - 2) {
      lines.push("");
    }

    // Footer Help Bar
    lines.push(`  ${c.dim("1-4: Abas   ←/→: Mudar Período   ↑/↓: Rolar   r: Atualizar   q: Sair")}`);

    return lines.map((l) => truncate(l, width));
  };

  const paint = () => {
    if (restored) return;
    const lines = renderScreen();
    output.write(`\x1b[H\x1b[2J${lines.join("\n")}\n`);
  };

  try {
    output.write("\x1b[?1049h\x1b[?25l"); // Enter Alternate Screen Buffer, hide cursor
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();

    // Resize listener
    const onResize = () => paint();
    process.stdout.on("resize", onResize);

    // Initial data load
    void loadData();

    await new Promise<void>((resolve) => {
      const onKeypress = (_str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
        if (!key) return;

        // Quit on q, Esc, or Ctrl+C
        if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c") || key.sequence === "\x03") {
          input.off("keypress", onKeypress);
          process.stdout.off("resize", onResize);
          resolve();
          return;
        }

        // Tab selection via 1-4
        if (key.name === "1") { currentTab = 0; scrollOffset = 0; paint(); return; }
        if (key.name === "2") { currentTab = 1; scrollOffset = 0; paint(); return; }
        if (key.name === "3") { currentTab = 2; scrollOffset = 0; paint(); return; }
        if (key.name === "4") { currentTab = 3; scrollOffset = 0; paint(); return; }

        // Tab cycling via Tab
        if (key.name === "tab") {
          currentTab = (currentTab + 1) % TABS.length;
          scrollOffset = 0;
          paint();
          return;
        }

        // Period switching via Left/Right or h/l
        if (key.name === "left" || key.name === "h") {
          if (currentPeriodIdx > 0) {
            currentPeriodIdx--;
            scrollOffset = 0;
            void loadData();
          }
          return;
        }
        if (key.name === "right" || key.name === "l") {
          if (currentPeriodIdx < PERIODS.length - 1) {
            currentPeriodIdx++;
            scrollOffset = 0;
            void loadData();
          }
          return;
        }

        // Scrolling via Up/Down or j/k
        if (key.name === "up" || key.name === "k") {
          if (scrollOffset > 0) {
            scrollOffset--;
            paint();
          }
          return;
        }
        if (key.name === "down" || key.name === "j") {
          scrollOffset++;
          paint();
          return;
        }

        // Refresh via r
        if (key.name === "r") {
          void loadData();
          return;
        }
      };

      input.on("keypress", onKeypress);
    });
  } finally {
    process.off("exit", onExit);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    restore();
  }
}
