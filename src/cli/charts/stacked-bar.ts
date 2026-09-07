export interface StackSegment {
  key: string;
  label: string;
  value: number;
}

export interface StackedBarOptions {
  color?: boolean;
}

export interface StackedBarResult {
  bar: string;
  legend: string;
}

const PALETTE = [
  "\x1b[36m", // Cyan
  "\x1b[32m", // Green
  "\x1b[33m", // Yellow
  "\x1b[35m", // Magenta
  "\x1b[34m", // Blue
  "\x1b[91m", // Bright Red
  "\x1b[96m", // Bright Cyan
  "\x1b[92m", // Bright Green
];
const RESET = "\x1b[0m";

export function renderStackedBar(
  segments: StackSegment[],
  width: number,
  options: StackedBarOptions = {},
): StackedBarResult {
  const useColor = options.color ?? true;
  const validSegments = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = validSegments.reduce((sum, s) => sum + s.value, 0);

  if (total <= 0 || width <= 2) {
    const emptyRoom = Math.max(0, width - 2);
    return {
      bar: `[${" ".repeat(emptyRoom)}]`,
      legend: "",
    };
  }

  const innerWidth = width - 2; // Discount brackets '[' and ']'

  // Largest Remainder Method (Hamilton)
  const exactAllocations = validSegments.map((s) => ({
    segment: s,
    exact: (s.value / total) * innerWidth,
  }));

  const integers = exactAllocations.map((a) => Math.floor(a.exact));
  const remainders = exactAllocations.map((a, idx) => ({
    idx,
    rem: a.exact - integers[idx],
  }));

  let allocated = integers.reduce((sum, v) => sum + v, 0);
  remainders.sort((a, b) => b.rem - a.rem);

  for (let i = 0; i < innerWidth - allocated; i++) {
    integers[remainders[i % remainders.length].idx] += 1;
  }

  let barChars = "";
  const legendParts: string[] = [];

  for (let i = 0; i < validSegments.length; i++) {
    const count = integers[i];
    const color = useColor ? PALETTE[i % PALETTE.length] : "";
    const reset = useColor ? RESET : "";
    const pct = Math.round((validSegments[i].value / total) * 100);

    if (count > 0) {
      barChars += `${color}${"█".repeat(count)}${reset}`;
    }

    // Only show items that have at least 1% share
    if (pct >= 1) {
      legendParts.push(`${color}■${reset} ${validSegments[i].label} (${pct}%)`);
    }
  }

  return {
    bar: `[${barChars}]`,
    legend: legendParts.join("  "),
  };
}
