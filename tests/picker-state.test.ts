import { describe, expect, it } from "vitest";

import {
  applyKey,
  hitCount,
  initialState,
  reanchor,
  visibleItems,
  type Key,
  type PickerAction,
  type PickerState,
  type Screen,
} from "../src/cli/picker-state.js";

// Real sequences, not the key names, so the paste guard is exercised the way
// readline actually delivers these.
const SEQUENCES: Record<string, string> = {
  return: "\r",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  escape: "\x1b",
  "paste-start": "\x1b[200~",
  "paste-end": "\x1b[201~",
};

const key = (name: string, extra: Partial<Key> = {}): Key => ({
  sequence: SEQUENCES[name] ?? name,
  name,
  ctrl: false,
  meta: false,
  ...extra,
});

const typing = (text: string): Key[] => [...text].map((char) => key(char));

const screen = (overrides: Partial<Screen> = {}): Screen => ({
  agent: "opencode",
  title: "opencode",
  counter: "agente 3 de 4",
  pinned: false,
  known: new Set(["opencode/big-pickle", "opencode/claude-sonnet-4-6", "openrouter/z-ai/glm-5"]),
  items: [
    { id: "opencode/big-pickle", label: "opencode/big-pickle", group: "opencode" },
    { id: "opencode/claude-sonnet-4-6", label: "opencode/claude-sonnet-4-6", group: "opencode" },
    { id: "openrouter/z-ai/glm-5", label: "openrouter/z-ai/glm-5", group: "openrouter" },
  ],
  ...overrides,
});

function press(
  state: PickerState,
  keys: Key[],
  viewport = 10,
): { state: PickerState; action: PickerAction } {
  return keys.reduce<{ state: PickerState; action: PickerAction }>(
    (acc, pressed) => {
      const next = applyKey(acc.state, pressed, viewport);
      return { state: next.state, action: next.action.kind === "none" ? acc.action : next.action };
    },
    { state, action: { kind: "none" } },
  );
}

describe("navigation", () => {
  it("moves the cursor and picks the highlighted item", () => {
    const { action } = press(initialState(screen()), [key("down"), key("return")]);

    expect(action).toEqual({ kind: "picked", id: "opencode/claude-sonnet-4-6" });
  });

  it("stops at the ends instead of wrapping", () => {
    const top = press(initialState(screen()), [key("up"), key("up")]);
    expect(top.state.cursor).toBe(0);

    const bottom = press(initialState(screen()), [key("down"), key("down"), key("down"), key("down")]);
    expect(bottom.state.cursor).toBe(2);
  });
});

describe("filtering", () => {
  it("narrows on every keystroke and resets the cursor to the top", () => {
    const { state } = press(initialState(screen()), [key("down"), ...typing("glm")]);

    expect(state.filter).toBe("glm");
    expect(visibleItems(state).map((item) => item.id)).toEqual(["openrouter/z-ai/glm-5"]);
    expect(state.cursor).toBe(0);
  });

  it("matches case-insensitively", () => {
    const { state } = press(initialState(screen()), typing("GL"));

    expect(visibleItems(state)).toHaveLength(1);
  });

  it("drops the last character on backspace", () => {
    const { state } = press(initialState(screen()), [...typing("gl"), key("backspace")]);

    expect(state.filter).toBe("g");
  });

  it("offers a synthetic row when nothing matches", () => {
    const { state } = press(initialState(screen()), typing("zzz"));
    const items = visibleItems(state);

    expect(items).toHaveLength(1);
    expect(items[0].synthetic).toBe(true);
    expect(items[0].id).toBe("zzz");
  });

  // A harness that reported no catalog has nothing to filter, so the synthetic
  // row is the whole screen, and Enter on it must not write an empty id.
  it("opens in filter mode with a synthetic row when the catalog is empty", () => {
    const empty = initialState(screen({ items: [], known: new Set() }));

    expect(visibleItems(empty)).toHaveLength(1);
    expect(visibleItems(empty)[0].synthetic).toBe(true);
    expect(applyKey(empty, key("return"), 10).action).toEqual({ kind: "none" });
  });
});

describe("skip and abort", () => {
  it("skips on ctrl-g", () => {
    const { action } = press(initialState(screen()), [key("g", { ctrl: true, sequence: "\x07" })]);

    expect(action).toEqual({ kind: "skipped" });
  });

  // Raw mode raises no SIGINT: the ctrl-c arrives as a byte and the machine
  // has to answer it.
  it("aborts on ctrl-c", () => {
    const { action } = press(initialState(screen()), [key("c", { ctrl: true, sequence: "\x03" })]);

    expect(action).toEqual({ kind: "aborted" });
  });

  // Esc alone takes 500ms to resolve, and a fragmented arrow arrives as a lone
  // escape, so skipping on it would throw away an answer nobody gave.
  it("does not skip on escape, and does not filter on it either", () => {
    const { state, action } = press(initialState(screen()), [key("escape")]);

    expect(action).toEqual({ kind: "none" });
    expect(state.filter).toBe("");
  });
});

describe("bracketed paste", () => {
  // Pasting "alpha\nbeta" used to choose a model on the newline.
  it("buffers the whole paste into the filter without acting on it", () => {
    const body = [...typing("alpha"), key("return"), ...typing("beta")];
    const { state, action } = press(initialState(screen()), [
      key("paste-start"),
      ...body,
      key("paste-end"),
    ]);

    expect(state.filter).toBe("alphabeta");
    expect(state.pasting).toBe(false);
    expect(action).toEqual({ kind: "none" });
  });

  it("ignores arrows and ctrl-g while pasting", () => {
    const { state, action } = press(initialState(screen()), [
      key("paste-start"),
      key("down"),
      key("g", { ctrl: true, sequence: "\x07" }),
      key("paste-end"),
    ]);

    expect(state.cursor).toBe(0);
    expect(action).toEqual({ kind: "none" });
  });
});

describe("confirming an id the catalog does not know", () => {
  const typed = (text: string) => press(initialState(screen()), typing(text));

  it("asks before writing and writes on the second enter", () => {
    const first = applyKey(typed("nope").state, key("return"), 10);
    expect(first.action).toEqual({ kind: "none" });
    expect(first.state.confirming).toBe("nope");

    const second = applyKey(first.state, key("return"), 10);
    expect(second.action).toEqual({ kind: "picked", id: "nope" });
  });

  it("cancels the confirmation on any other key", () => {
    const first = applyKey(typed("nope").state, key("return"), 10);
    const cancelled = applyKey(first.state, key("x"), 10);

    expect(cancelled.state.confirming).toBeUndefined();
    expect(cancelled.action).toEqual({ kind: "none" });
  });

  it("writes an id the catalog knows on the first enter", () => {
    const { action } = press(initialState(screen()), [...typing("big-pickle"), key("return")]);

    expect(action).toEqual({ kind: "picked", id: "opencode/big-pickle" });
  });
});

describe("viewport", () => {
  it("scrolls the offset to keep the cursor visible", () => {
    const many = screen({
      items: Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, label: `m-${i}`, group: "g" })),
      known: new Set(),
    });
    const { state } = press(initialState(many), Array.from({ length: 12 }, () => key("down")), 5);

    expect(state.cursor).toBe(12);
    expect(state.offset).toBe(8);
  });
});

describe("hit count", () => {
  // visibleItems never returns empty, so counting it reported one hit for a
  // filter that matched nothing.
  it("counts real matches, not the synthetic row", () => {
    const state = { ...initialState(screen()), filter: "zzz" };

    expect(visibleItems(state)).toHaveLength(1);
    expect(hitCount(state)).toBe(0);
  });

  it("counts every item when the filter is empty", () => {
    expect(hitCount(initialState(screen()))).toBe(screen().items.length);
  });
});

describe("reanchor", () => {
  it("pulls a cursor left outside a shrunken viewport back into view", () => {
    const after = reanchor({ ...initialState(screen()), cursor: 5, offset: 1 }, 2);

    expect(after.cursor).toBe(5);
    expect(after.offset).toBe(4);
  });

  it("leaves a cursor that is already in view alone", () => {
    const fine = { ...initialState(screen()), cursor: 2, offset: 1 };

    expect(reanchor(fine, 5)).toEqual(fine);
  });
});
