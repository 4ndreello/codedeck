import { describe, expect, it } from "vitest";

import {
  applyKey,
  hitCount,
  initialState,
  itemKey,
  parseFreeText,
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

/**
 * One screen answers one role and spans every harness, so the fixture carries
 * two of them: an id belongs to a harness, never to the screen.
 */
const screen = (overrides: Partial<Screen> = {}): Screen => ({
  role: "reviewer",
  title: "reviewer",
  counter: "agente 3 de 4",
  pinned: false,
  harnesses: new Set(["opencode", "codex"]),
  known: new Set([
    itemKey("opencode", "opencode/big-pickle"),
    itemKey("opencode", "opencode/claude-sonnet-4-6"),
    itemKey("codex", "gpt-5.6-luna"),
  ]),
  items: [
    { id: "opencode/big-pickle", label: "opencode/big-pickle", group: "opencode", harness: "opencode" },
    {
      id: "opencode/claude-sonnet-4-6",
      label: "opencode/claude-sonnet-4-6",
      group: "opencode",
      harness: "opencode",
    },
    { id: "gpt-5.6-luna", label: "gpt-5.6-luna", group: "codex", harness: "codex" },
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

    expect(action).toEqual({
      kind: "picked",
      id: "opencode/claude-sonnet-4-6",
      harness: "opencode",
    });
  });

  // The screen spans harnesses, so a pick that carried only the id would leave
  // the caller unable to say who runs it.
  it("reports the harness the picked row belongs to", () => {
    const { action } = press(initialState(screen()), [key("down"), key("down"), key("return")]);

    expect(action).toEqual({ kind: "picked", id: "gpt-5.6-luna", harness: "codex" });
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
    const { state } = press(initialState(screen()), [key("down"), ...typing("luna")]);

    expect(state.filter).toBe("luna");
    expect(visibleItems(state).map((item) => item.id)).toEqual(["gpt-5.6-luna"]);
    expect(state.cursor).toBe(0);
  });

  it("matches case-insensitively", () => {
    const { state } = press(initialState(screen()), typing("LUN"));

    expect(visibleItems(state)).toHaveLength(1);
  });

  it("drops the last character on backspace", () => {
    const { state } = press(initialState(screen()), [...typing("lu"), key("backspace")]);

    expect(state.filter).toBe("l");
  });

  // The harness is on screen as a group header. Typing it and getting the
  // synthetic "not in the catalog" row read as a broken filter.
  it("matches the harness shown in the group header", () => {
    const { state } = press(initialState(screen()), typing("codex"));

    expect(visibleItems(state).map((item) => item.id)).toEqual(["gpt-5.6-luna"]);
  });

  // 1,462 catalog entries spell the version readably in `name` and only in the
  // id the way it is typed, so "Sonnet 4.6" had no way to find anything.
  it("matches the readable name the row does not show", () => {
    const withNames = screen({
      items: [
        {
          id: "opencode/claude-sonnet-4-6",
          label: "opencode/claude-sonnet-4-6",
          group: "opencode",
          name: "Claude Sonnet 4.6",
        },
        { id: "opencode/big-pickle", label: "opencode/big-pickle", group: "opencode" },
      ],
    });
    const { state } = press(initialState(withNames), typing("sonnet 4.6"));

    expect(visibleItems(state).map((item) => item.id)).toEqual(["opencode/claude-sonnet-4-6"]);
    expect(hitCount(state)).toBe(1);
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

// One screen spans every harness, so a hand-typed id has to name its own. The
// separator is ":" because opencode spells real ids with "/".
describe("free text", () => {
  it("splits a harness prefix off the model, on the first colon only", () => {
    const harnesses = new Set(["opencode", "codex"]);

    expect(parseFreeText("codex:gpt-5.7", harnesses)).toEqual({ harness: "codex", id: "gpt-5.7" });
    expect(parseFreeText("opencode:openrouter/z-ai/glm-5", harnesses)).toEqual({
      harness: "opencode",
      id: "openrouter/z-ai/glm-5",
    });
    expect(parseFreeText("CODEX:gpt-5.7", harnesses)).toEqual({ harness: "codex", id: "gpt-5.7" });
  });

  it("refuses a bare id, an unknown harness, and an empty half", () => {
    const harnesses = new Set(["opencode", "codex"]);

    expect(parseFreeText("gpt-5.7", harnesses)).toBeUndefined();
    expect(parseFreeText("gemini:whatever", harnesses)).toBeUndefined();
    expect(parseFreeText("codex:", harnesses)).toBeUndefined();
    expect(parseFreeText(":gpt-5.7", harnesses)).toBeUndefined();
  });

  it("offers a pickable row once the text names a harness", () => {
    const { state } = press(initialState(screen()), typing("codex:gpt-5.7"));
    const [row] = visibleItems(state);

    expect(row.synthetic).toBe(true);
    expect(row.id).toBe("gpt-5.7");
    expect(row.harness).toBe("codex");
  });

  // Without the prefix there is no harness to save, so the row says what is
  // missing instead of offering an Enter that would have to guess one.
  it("refuses to pick text that names no harness", () => {
    const { state } = press(initialState(screen()), typing("zzz"));
    const [row] = visibleItems(state);

    expect(row.synthetic).toBe(true);
    expect(row.id).toBe("");
    expect(row.label).toContain("zzz");
    expect(applyKey(state, key("return"), 10).action).toEqual({ kind: "none" });
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
    const first = applyKey(typed("codex:nope").state, key("return"), 10);
    expect(first.action).toEqual({ kind: "none" });
    expect(first.state.confirming).toBe(itemKey("codex", "nope"));

    const second = applyKey(first.state, key("return"), 10);
    expect(second.action).toEqual({ kind: "picked", id: "nope", harness: "codex" });
  });

  it("cancels the confirmation on any other key", () => {
    const first = applyKey(typed("codex:nope").state, key("return"), 10);
    const cancelled = applyKey(first.state, key("x"), 10);

    expect(cancelled.state.confirming).toBeUndefined();
    expect(cancelled.action).toEqual({ kind: "none" });
  });

  it("writes an id the catalog knows on the first enter", () => {
    const { action } = press(initialState(screen()), [...typing("big-pickle"), key("return")]);

    expect(action).toEqual({ kind: "picked", id: "opencode/big-pickle", harness: "opencode" });
  });

  // The same id can exist under two harnesses. A confirmation answered for one
  // must not be spent on the other.
  it("does not carry a confirmation across harnesses", () => {
    const both = screen({
      harnesses: new Set(["opencode", "codex"]),
      items: [],
      known: new Set([itemKey("opencode", "shared")]),
    });
    const first = applyKey(press(initialState(both), typing("codex:shared")).state, key("return"), 10);

    expect(first.action).toEqual({ kind: "none" });
    expect(first.state.confirming).toBe(itemKey("codex", "shared"));

    // Retyping for the other harness must not cash in the pending answer: that
    // one is vouched for by the catalog and needs no confirmation at all, and
    // the codex answer has to die with the filter that raised it.
    const retyped = press(
      { ...first.state, filter: "" },
      [...typing("opencode:shared"), key("return")],
      10,
    );

    expect(retyped.action).toEqual({ kind: "picked", id: "shared", harness: "opencode" });
    expect(retyped.state.confirming).toBeUndefined();
  });

  // Pasted text edits the filter, so it has to drop the pending answer the same
  // way typed text does. It used to survive, leaving the footer asking about an
  // id the row on screen no longer was.
  it("drops a pending confirmation when a paste changes the filter", () => {
    const pending = applyKey(typed("codex:nope").state, key("return"), 10);
    expect(pending.state.confirming).toBe(itemKey("codex", "nope"));

    const pasted = press(pending.state, [key("paste-start"), key("x"), key("paste-end")]);

    expect(pasted.state.filter).toBe("codex:nopex");
    expect(pasted.state.confirming).toBeUndefined();
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
