import { describe, expect, it } from "vitest";

import { applyKey, initialState, type Key, type Screen } from "../src/cli/picker-state.js";
import {
  chromeHeight,
  colors,
  readDimensions,
  renderFrame,
  truncate,
  viewportHeight,
  visibleWidth,
} from "../src/cli/ui.js";

const plain = colors(false);

describe("text primitives", () => {
  // With color on, string.length counts the escapes and lies about the width.
  it("measures width without counting ANSI escapes", () => {
    const painted = colors(true).bold("abcde");

    expect(painted.length).toBeGreaterThan(5);
    expect(visibleWidth(painted)).toBe(5);
  });

  it("returns plain text when color is off, so width is length", () => {
    const off = colors(false).bold("abcde");

    expect(off).toBe("abcde");
    expect(visibleWidth(off)).toBe(5);
  });

  // A 55 character id used to wrap and break the redraw arithmetic.
  it("truncates to the visible width it was given", () => {
    const id = "amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0";

    expect(visibleWidth(truncate(id, 20))).toBeLessThanOrEqual(20);
    expect(truncate(id, 20)).toContain("amazon");
  });

  it("leaves a string that already fits untouched", () => {
    expect(truncate("short", 20)).toBe("short");
  });

  it("truncates painted text without cutting an escape in half", () => {
    const cut = truncate(colors(true).bold("abcdefghij"), 4);

    expect(visibleWidth(cut)).toBeLessThanOrEqual(4);
    expect(cut.endsWith("\x1b[0m")).toBe(true);
  });

  // A pty with no winsize reports 0, and `??` used to let it through.
  it.each([
    ["a reported size", { rows: 40, columns: 120 }, { rows: 40, columns: 120 }],
    ["zero from a pty with no winsize", { rows: 0, columns: 0 }, { rows: 24, columns: 80 }],
    ["absent off a tty", {}, { rows: 24, columns: 80 }],
  ])("normalizes %s", (_label, given, expected) => {
    expect(readDimensions(given)).toEqual(expected);
  });
});

const catalog = (overrides: Partial<Screen> = {}): Screen => ({
  agent: "opencode",
  title: "opencode",
  counter: "agente 3 de 4",
  pinned: false,
  known: new Set(),
  items: [
    { id: "opencode/a", label: "opencode/a", group: "opencode" },
    { id: "opencode/b", label: "opencode/b", group: "opencode" },
    { id: "openrouter/c", label: "openrouter/c", group: "openrouter" },
  ],
  ...overrides,
});

const press = (screen: Screen, char: string) => {
  const key: Key = { sequence: char, name: char, ctrl: false, meta: false };
  return applyKey(initialState(screen), key, 10).state;
};

describe("frame", () => {
  it("groups by provider with a count while the filter is empty", () => {
    const text = renderFrame(initialState(catalog()), { rows: 40, columns: 80 }, plain).join("\n");

    expect(text).toMatch(/-- opencode -+ 2 --/);
    expect(text).toMatch(/-- openrouter -+ 1 --/);
  });

  // With a filter on, the headers go and the provider becomes a row suffix.
  it("drops the headers and counts the hits once filtering", () => {
    const text = renderFrame(press(catalog(), "c"), { rows: 40, columns: 80 }, plain).join("\n");

    expect(text).not.toContain("--");
    expect(text).toContain("de 3");
  });

  it("never writes a line wider than the terminal", () => {
    const wide = catalog({
      items: [
        {
          id: "x",
          label: "amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0",
          group: "bedrock",
        },
      ],
    });

    for (const line of renderFrame(initialState(wide), { rows: 40, columns: 20 }, plain)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("shows the harness error in the header when there is one", () => {
    const broken = catalog({ error: "discovery timed out", items: [] });

    expect(renderFrame(initialState(broken), { rows: 40, columns: 80 }, plain).join("\n")).toContain(
      "discovery timed out",
    );
  });

  // The chrome is counted, not a constant: the error line only exists sometimes.
  it("counts only the chrome it actually draws", () => {
    const tall = { rows: 40, columns: 80 };

    expect(chromeHeight(initialState(catalog({ error: "boom" })), tall)).toBe(
      chromeHeight(initialState(catalog()), tall) + 1,
    );
  });

  it("drops the logo on a short terminal so the list keeps its rows", () => {
    const short = { rows: 12, columns: 80 };
    const tall = { rows: 40, columns: 80 };

    expect(renderFrame(initialState(catalog()), tall, plain).join("\n")).toContain("╔═╗");
    expect(renderFrame(initialState(catalog()), short, plain).join("\n")).not.toContain("╔═╗");
    expect(viewportHeight(initialState(catalog()), short)).toBeGreaterThan(0);
  });
});
