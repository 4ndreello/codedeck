export interface StackSegment {
  key: string;
  label: string;
  value: number;
}

const TEXTURES = ["█", "▓", "▒", "░", "■", "▨", "▤", "□"];

export interface StackedBarResult {
  bar: string;
  legend: string;
}

export function renderStackedBar(
  segments: StackSegment[],
  width: number,
): StackedBarResult {
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
    const texture = TEXTURES[i % TEXTURES.length];
    if (count > 0) {
      barChars += texture.repeat(count);
    }
    const pct = Math.round((validSegments[i].value / total) * 100);
    legendParts.push(`${texture} ${validSegments[i].label} (${pct}%)`);
  }

  return {
    bar: `[${barChars}]`,
    legend: legendParts.join("  "),
  };
}
