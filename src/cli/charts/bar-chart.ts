import { visibleWidth } from "../ui.js";

const BLOCK_GLYPHS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface BarDatum {
  label: string; // e.g. "05/09" or "2026-09-07"
  value: number; // e.g. cost in USD or token count
}

export interface BarChartOptions {
  height?: number;     // Bar height in lines (default: 6)
  barWidth?: number;   // Width of each bar column (default: dynamic 4-12)
  maxWidth?: number;   // Maximum terminal width available
  formatY?: (val: number) => string;
  showValues?: boolean; // Show currency/value under each column
  color?: boolean;
}

function centerText(text: string, width: number): string {
  const v = visibleWidth(text);
  if (v >= width) return text.slice(0, width);
  const left = Math.floor((width - v) / 2);
  const right = width - v - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

export function renderBarChart(data: BarDatum[], options: BarChartOptions = {}): string[] {
  if (data.length === 0) return ["  (no data for this period)"];

  const height = Math.max(3, options.height ?? 6);
  const maxWidth = options.maxWidth ?? 80;
  const useColor = options.color ?? true;
  const formatY = options.formatY ?? ((v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)}`);

  const values = data.map((d) => (Number.isFinite(d.value) && d.value > 0 ? d.value : 0));
  const maxValue = Math.max(...values, 0.01);
  const totalSublevels = height * 8;

  // Y-axis labels (4 steps: max, 2/3, 1/3, 0)
  const yLabels = [
    formatY(maxValue),
    formatY((maxValue * 2) / 3),
    formatY(maxValue / 3),
    formatY(0),
  ];
  const yLabelWidth = Math.max(...yLabels.map((l) => visibleWidth(l)));
  const paddedYLabels = yLabels.map((l) => l.padStart(yLabelWidth, " "));

  // Calculate dynamic wide bars based on available space and number of columns
  const availableWidth = Math.max(30, maxWidth - yLabelWidth - 8);
  const count = data.length;
  const targetBarWidth = options.barWidth ?? Math.max(4, Math.min(14, Math.floor(availableWidth / (count * 1.5))));
  const gapWidth = Math.max(2, Math.min(6, Math.floor(targetBarWidth * 0.5)));

  const lines: string[] = [];

  // Render each vertical line of the chart (top down)
  for (let row = height - 1; row >= 0; row--) {
    let yPrefix = " ".repeat(yLabelWidth);
    if (row === height - 1) {
      yPrefix = paddedYLabels[0];
    } else if (row === Math.floor(height * 0.66)) {
      yPrefix = paddedYLabels[1];
    } else if (row === Math.floor(height * 0.33)) {
      yPrefix = paddedYLabels[2];
    } else if (row === 0) {
      yPrefix = paddedYLabels[3];
    }

    let rowBars = "";
    for (let i = 0; i < data.length; i++) {
      const val = values[i];
      const sub = Math.min(totalSublevels, Math.round((val / maxValue) * totalSublevels));
      const gap = " ".repeat(gapWidth);

      if (sub >= (row + 1) * 8) {
        const barBlock = "█".repeat(targetBarWidth);
        rowBars += `${gap}${useColor ? `\x1b[36m${barBlock}\x1b[0m` : barBlock}`;
      } else if (sub <= row * 8) {
        rowBars += `${gap}${" ".repeat(targetBarWidth)}`;
      } else {
        const glyphIdx = Math.min(8, Math.max(0, sub - row * 8));
        const glyph = BLOCK_GLYPHS[glyphIdx];
        const barBlock = glyph.repeat(targetBarWidth);
        rowBars += `${gap}${useColor ? `\x1b[36m${barBlock}\x1b[0m` : barBlock}`;
      }
    }
    lines.push(`  ${yPrefix} │${rowBars}`);
  }

  // X-axis baseline and ticks
  let axisLine = "";
  for (let i = 0; i < data.length; i++) {
    const gap = "─".repeat(gapWidth);
    const tickBar = "─".repeat(targetBarWidth);
    axisLine += `${gap}${tickBar}`;
  }
  lines.push(`  ${" ".repeat(yLabelWidth)} └───${axisLine}──`);

  // X-axis date labels (centered under each bar)
  let dateLine = "";
  for (let i = 0; i < data.length; i++) {
    const gap = " ".repeat(gapWidth);
    const rawLabel = data[i].label.length > 5 ? data[i].label.slice(5) : data[i].label; // e.g. "2026-09-07" -> "09-07"
    const centered = centerText(rawLabel, targetBarWidth);
    dateLine += `${gap}${centered}`;
  }
  lines.push(`  ${" ".repeat(yLabelWidth)}    ${dateLine}`);

  // X-axis value labels (centered under each date)
  if (options.showValues ?? true) {
    let valueLine = "";
    for (let i = 0; i < data.length; i++) {
      const gap = " ".repeat(gapWidth);
      const val = values[i];
      const valText = `$${val.toFixed(val < 10 ? 2 : 0)}`;
      const centered = centerText(valText, targetBarWidth);
      const colored = useColor ? `\x1b[1m${centered}\x1b[0m` : centered;
      valueLine += `${gap}${colored}`;
    }
    lines.push(`  ${" ".repeat(yLabelWidth)}    ${valueLine}`);
  }

  return lines;
}
