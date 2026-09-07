import { padToWidth, visibleWidth } from "../ui.js";

const BLOCK_GLYPHS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface BarDatum {
  label: string; // e.g. "05/09" or "Mon"
  value: number; // e.g. cost in USD or token count
}

export interface BarChartOptions {
  height?: number;     // Bar height in lines (default: 4)
  maxWidth?: number;   // Maximum width available
  formatY?: (val: number) => string;
}

export function renderBarChart(data: BarDatum[], options: BarChartOptions = {}): string[] {
  if (data.length === 0) return ["  (sem dados para o período)"];

  const height = Math.max(2, options.height ?? 4);
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

      if (sub >= (row + 1) * 8) {
        rowBars += "   █";
      } else if (sub <= row * 8) {
        rowBars += "    ";
      } else {
        const glyphIdx = Math.min(8, Math.max(0, sub - row * 8));
        rowBars += `   ${BLOCK_GLYPHS[glyphIdx]}`;
      }
    }
    lines.push(`  ${yPrefix} │${rowBars}`);
  }

  // X-axis baseline and ticks
  const axisTicks = data.map(() => "───┴").join("");
  lines.push(`  ${" ".repeat(yLabelWidth)} └───${axisTicks}`);

  // X-axis labels
  let xLabels = "";
  for (const d of data) {
    const rawLabel = d.label.length > 5 ? d.label.slice(5) : d.label; // e.g. "2026-09-07" -> "09-07"
    const padded = padToWidth(rawLabel.slice(0, 5), 4);
    xLabels += `  ${padded}`;
  }
  lines.push(`  ${" ".repeat(yLabelWidth)}   ${xLabels}`);

  return lines;
}
