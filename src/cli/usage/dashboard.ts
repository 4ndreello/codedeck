import { emitKeypressEvents } from "node:readline";
import type { UsageQueryResult, UsagePeriod } from "../../daemon/protocol.js";
import { colors, readDimensions, truncate, visibleWidth, padToWidth, ellipsizeEnd, type Colors } from "../ui.js";
import { renderBarChart, type BarDatum } from "../charts/bar-chart.js";
import { renderStackedBar } from "../charts/stacked-bar.js";

export interface DashboardFetcher {
  fetch(period: UsagePeriod): Promise<UsageQueryResult>;
}

export interface DashboardIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
  output: NodeJS.WritableStream & { rows?: number; columns?: number; isTTY?: boolean };
}

const PERIODS: UsagePeriod[] = ["today", "3d", "7d", "30d", "all"];
const PERIOD_LABELS: Record<UsagePeriod, string> = {
  today: "Today",
  "3d": "3 Days",
  "7d": "7 Days",
  "30d": "30 Days",
  all: "All",
};

const TABS = ["1: Overview", "2: Projects", "3: Models", "4: Runs"];

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

function renderProgressBar(pct: number, barWidth = 16): string {
  const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
  const empty = Math.max(0, barWidth - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
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
    lines.push(`  Period: ${periodLine}`);
    lines.push(`  ${c.dim("─".repeat(Math.max(10, width - 4)))}`);

    if (loading) {
      lines.push("");
      lines.push("  Loading usage metrics...");
      return lines.map((l) => truncate(l, width));
    }

    if (errorMessage) {
      lines.push("");
      lines.push(`  ${c.bold("Error loading data:")} ${errorMessage}`);
      lines.push(`  Press 'r' to retry or 'q' to quit.`);
      return lines.map((l) => truncate(l, width));
    }

    if (!data) return lines;

    const { totals, byDay, byRepository, byModel, byRun } = data;
    const totalCost = totals.costUsd || 0.01;
    const totalTok = totals.totalTokens || 1;

    // Tab 0: Overview
    if (currentTab === 0) {
      // Executive KPI Box
      const boxWidth = Math.min(width - 6, 120);
      const costText = `${c.bold(formatCurrency(totals.costUsd, totals.costComplete))} USD`;
      const tokText = `${formatTokens(totals.totalTokens)} (${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cachedTokens)} cached)`;
      const sessText = `${totals.sessionCount} (${totals.completedSessionCount} completed, ${totals.failedSessionCount} failed${totals.activeSessionCount > 0 ? `, ${totals.activeSessionCount} active` : ""})`;

      lines.push(`  ┌── EXECUTIVE SUMMARY ${"─".repeat(Math.max(0, boxWidth - 24))}┐`);
      lines.push(`  │  ${c.bold("Total Cost:")} ${padToWidth(costText, 24)}  ${c.bold("Sessions:")} ${padToWidth(sessText, 38)} │`);
      lines.push(`  │  ${c.bold("Tokens:")}      ${padToWidth(tokText, 66)} │`);
      lines.push(`  └──${"─".repeat(Math.max(0, boxWidth - 4))}┘`);
      lines.push("");

      // Bar Chart for daily cost
      if (byDay.length > 0) {
        lines.push(`  ${c.dim("-- DAILY COST TIMELINE (USD) " + "-".repeat(Math.max(0, width - 45)))}`);
        const chartData: BarDatum[] = byDay.map((d) => ({
          label: d.key,
          value: d.costUsd,
        }));
        const chartHeight = Math.max(5, Math.min(10, Math.floor(height * 0.24)));
        const chartLines = renderBarChart(chartData, {
          height: chartHeight,
          maxWidth: width - 6,
          showValues: true,
          color: true,
        });
        for (const cl of chartLines) lines.push(cl);
        lines.push("");
      }

      // Distributions (Projects and Models)
      const distWidth = Math.max(30, Math.min(width - 6, 100));

      if (byRepository.length > 0) {
        lines.push(`  ${c.dim("-- PROJECT DISTRIBUTION " + "-".repeat(Math.max(0, width - 36)))}`);
        const projSegments = byRepository.slice(0, 6).map((p) => ({
          key: p.key,
          label: p.label || p.key,
          value: p.costUsd || p.totalTokens,
        }));
        const stacked = renderStackedBar(projSegments, distWidth, { color: true });
        lines.push(`  ${stacked.bar}`);
        if (stacked.legend) lines.push(`  ${stacked.legend}`);
        lines.push("");
      }

      if (byModel.length > 0) {
        lines.push(`  ${c.dim("-- TOKEN DISTRIBUTION BY MODEL " + "-".repeat(Math.max(0, width - 45)))}`);
        const modelSegments = byModel.slice(0, 6).map((m) => ({
          key: m.key,
          label: m.key.replace("claude-", "").replace("gemini-", "").replace("meta/", ""),
          value: m.totalTokens,
        }));
        const stacked = renderStackedBar(modelSegments, distWidth, { color: true });
        lines.push(`  ${stacked.bar}`);
        if (stacked.legend) lines.push(`  ${stacked.legend}`);
        lines.push("");
      }
    }

    // Tab 1: Projects (Clean Normalized Repositories)
    if (currentTab === 1) {
      lines.push(`  ${c.dim(padToWidth("PROJECT", 32) + "  " + padToWidth("SESSIONS", 9) + "  " + padToWidth("TOKENS", 18) + "  " + padToWidth("COST", 12) + "  " + padToWidth("SHARE", 24))}`);
      lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 100)))}`);

      const maxScroll = Math.max(0, byRepository.length - 5);
      scrollOffset = Math.min(scrollOffset, maxScroll);

      for (let i = scrollOffset; i < byRepository.length; i++) {
        const item = byRepository[i];
        const pct = Math.round((item.costUsd / totalCost) * 100);
        const bar = renderProgressBar(pct, 14);
        const nameCell = ellipsizeEnd(item.label || item.key, 32);
        const sessCell = padToWidth(String(item.sessionCount), 9);
        const tokCell = padToWidth(formatTokens(item.totalTokens), 18);
        const costCell = padToWidth(formatCurrency(item.costUsd, item.costComplete), 12);
        const shareCell = `${bar} ${pct}%`;

        lines.push(`  ${nameCell}  ${sessCell}  ${tokCell}  ${c.bold(costCell)}  ${c.dim(shareCell)}`);
      }
    }

    // Tab 2: Models
    if (currentTab === 2) {
      lines.push(`  ${c.dim(padToWidth("MODEL", 34) + "  " + padToWidth("SESSIONS", 9) + "  " + padToWidth("IN / OUT / CACHED", 26) + "  " + padToWidth("COST", 12) + "  " + padToWidth("TOKENS %", 24))}`);
      lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 110)))}`);

      const maxScroll = Math.max(0, byModel.length - 5);
      scrollOffset = Math.min(scrollOffset, maxScroll);

      for (let i = scrollOffset; i < byModel.length; i++) {
        const item = byModel[i];
        const tok = `${formatTokens(item.inputTokens)} / ${formatTokens(item.outputTokens)} / ${formatTokens(item.cachedTokens)}`;
        const pct = Math.round((item.totalTokens / totalTok) * 100);
        const bar = renderProgressBar(pct, 14);

        lines.push(`  ${ellipsizeEnd(item.key, 34)}  ${padToWidth(String(item.sessionCount), 9)}  ${padToWidth(tok, 26)}  ${c.bold(padToWidth(formatCurrency(item.costUsd, item.costComplete), 12))}  ${c.dim(`${bar} ${pct}%`)}`);
      }
    }

    // Tab 3: Runs
    if (currentTab === 3) {
      lines.push(`  ${c.dim(padToWidth("RUN ID / NAME", 36) + "  " + padToWidth("SESSIONS", 9) + "  " + padToWidth("TOKENS", 18) + "  " + padToWidth("COST", 12) + "  " + padToWidth("SHARE", 24))}`);
      lines.push(`  ${c.dim("─".repeat(Math.min(width - 4, 105)))}`);

      const maxScroll = Math.max(0, byRun.length - 5);
      scrollOffset = Math.min(scrollOffset, maxScroll);

      for (let i = scrollOffset; i < byRun.length; i++) {
        const item = byRun[i];
        const pct = Math.round((item.costUsd / totalCost) * 100);
        const bar = renderProgressBar(pct, 14);

        lines.push(`  ${ellipsizeEnd(item.label || item.key, 36)}  ${padToWidth(String(item.sessionCount), 9)}  ${padToWidth(formatTokens(item.totalTokens), 18)}  ${c.bold(padToWidth(formatCurrency(item.costUsd, item.costComplete), 12))}  ${c.dim(`${bar} ${pct}%`)}`);
      }
    }

    // Fill blank lines up to height - 2
    while (lines.length < height - 2) {
      lines.push("");
    }

    // Footer Help Bar
    lines.push(`  ${c.dim("1-4: Tabs   ←/→: Change Period   ↑/↓: Scroll   r: Refresh   q: Quit")}`);

    return lines.map((l) => truncate(l, width));
  };

  const paint = () => {
    if (restored) return;
    const lines = renderScreen();
    output.write(`\x1b[H\x1b[2J${lines.join("\n")}\n`);
  };

  const onResize = () => paint();

  try {
    output.write("\x1b[?1049h\x1b[?25l"); // Enter Alternate Screen Buffer, hide cursor
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();

    process.stdout.on("resize", onResize);

    // Initial data load
    void loadData();

    await new Promise<void>((resolve) => {
      const onKeypress = (_str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
        if (!key) return;

        // Quit on q, Esc, or Ctrl+C
        if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c") || key.sequence === "\x03") {
          input.off("keypress", onKeypress);
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
    process.stdout.off("resize", onResize);
    process.off("exit", onExit);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    restore();
  }
}
