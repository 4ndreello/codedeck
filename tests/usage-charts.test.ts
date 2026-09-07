import { describe, expect, it } from "vitest";
import { renderBarChart } from "../src/cli/charts/bar-chart.js";
import { renderStackedBar } from "../src/cli/charts/stacked-bar.js";
import { renderSparkline } from "../src/cli/charts/sparkline.js";

describe("bar-chart", () => {
  it("renders an empty notice when no data is provided", () => {
    const lines = renderBarChart([]);
    expect(lines[0]).toContain("sem dados");
  });

  it("renders a vertical histogram with axes and unicode block characters", () => {
    const data = [
      { label: "2026-09-05", value: 10 },
      { label: "2026-09-06", value: 20 },
      { label: "2026-09-07", value: 40 },
    ];
    const lines = renderBarChart(data, { height: 4 });
    expect(lines.length).toBe(6); // 4 bar rows + 1 axis row + 1 label row
    expect(lines[0]).toContain("│");
    expect(lines[4]).toContain("└───");
    expect(lines[5]).toContain("09-07");
  });

  it("handles all-zero data without NaN or throwing", () => {
    const data = [
      { label: "01", value: 0 },
      { label: "02", value: 0 },
    ];
    const lines = renderBarChart(data);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("NaN");
    }
  });
});

describe("stacked-bar", () => {
  it("handles zero total tokens gracefully", () => {
    const result = renderStackedBar([{ key: "k1", label: "m1", value: 0 }], 20);
    expect(result.bar).toBe(`[${" ".repeat(18)}]`);
    expect(result.legend).toBe("");
  });

  it("allocates exact width using Hamilton method", () => {
    const segments = [
      { key: "claude", label: "Claude", value: 60 },
      { key: "codex", label: "Codex", value: 30 },
      { key: "gemini", label: "Gemini", value: 10 },
    ];
    const result = renderStackedBar(segments, 32); // 32 chars = 2 brackets + 30 inner chars
    expect(result.bar.length).toBe(32);
    expect(result.bar.startsWith("[")).toBe(true);
    expect(result.bar.endsWith("]")).toBe(true);
    expect(result.legend).toContain("Claude (60%)");
    expect(result.legend).toContain("Codex (30%)");
    expect(result.legend).toContain("Gemini (10%)");
  });
});

describe("sparkline", () => {
  it("renders empty string for empty input", () => {
    expect(renderSparkline([])).toBe("");
  });

  it("renders consistent character for single value or identical values", () => {
    expect(renderSparkline([5, 5, 5])).toBe("▅▅▅");
  });

  it("scales values across the 8-block range", () => {
    const spark = renderSparkline([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(spark.length).toBe(8);
    expect(spark[0]).toBe(" ");
    expect(spark[7]).toBe("█");
  });
});
