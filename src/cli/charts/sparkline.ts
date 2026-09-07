const SPARKS = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function renderSparkline(values: number[]): string {
  if (values.length === 0) return "";
  const valid = values.map((v) => (Number.isFinite(v) && v >= 0 ? v : 0));
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min;

  return valid
    .map((v) => {
      if (range === 0) return v > 0 ? SPARKS[4] : SPARKS[0];
      const idx = Math.min(7, Math.max(0, Math.round(((v - min) / range) * 7)));
      return SPARKS[idx];
    })
    .join("");
}
