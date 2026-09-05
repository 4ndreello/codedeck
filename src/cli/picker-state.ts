export interface PickerItem {
  id: string;
  label: string;
  group?: string;
  note?: string;
  synthetic?: true;
}

export interface Screen {
  agent: string;
  title: string;
  counter: string;
  error?: string;
  items: PickerItem[];
  /** `items[0]` is a pinned row, drawn above the provider headers. */
  pinned: boolean;
  known: ReadonlySet<string>;
}

export interface PickerState {
  screen: Screen;
  filter: string;
  cursor: number;
  offset: number;
  pasting: boolean;
  /** Text waiting on a second Enter because the catalog does not know it. */
  confirming?: string;
}

export interface Key {
  sequence: string;
  name?: string;
  ctrl: boolean;
  meta: boolean;
}

export type PickerAction =
  | { kind: "none" }
  | { kind: "picked"; id: string }
  | { kind: "skipped" }
  | { kind: "aborted" };

/**
 * Lives here rather than in the session so the screen builder and the config
 * writer can use the vocabulary without pulling in raw mode.
 */
export type ScreenResult =
  | { kind: "picked"; agent: string; id: string }
  | { kind: "skipped"; agent: string }
  | { kind: "aborted" };

export function initialState(screen: Screen): PickerState {
  return { screen, filter: "", cursor: 0, offset: 0, pasting: false };
}

function matches(item: PickerItem, filter: string): boolean {
  return item.label.toLowerCase().includes(filter) || item.id.toLowerCase().includes(filter);
}

/**
 * Real catalog matches, which is not `visibleItems().length`: that one never
 * returns empty, so counting it reported one hit for a filter that matched
 * nothing.
 */
export function hitCount(state: PickerState): number {
  const filter = state.filter.trim().toLowerCase();
  if (!filter) return state.screen.items.length;
  return state.screen.items.filter((item) => matches(item, filter)).length;
}

export function visibleItems(state: PickerState): PickerItem[] {
  const filter = state.filter.trim().toLowerCase();
  const hits = filter ? state.screen.items.filter((item) => matches(item, filter)) : state.screen.items;
  if (hits.length > 0) return hits;

  // Nothing to list, so the only way forward is writing the raw text. This is
  // also the whole screen for a harness that reported no catalog at all, which
  // would never have a list to filter.
  const raw = state.filter.trim();
  return [{ id: raw, label: raw ? `usar "${raw}" como id` : "digite um id", synthetic: true }];
}

function scrolled(state: PickerState, cursor: number, viewport: number): PickerState {
  const offset = Math.min(state.offset, cursor);
  return { ...state, cursor, offset: Math.max(offset, cursor - viewport + 1) };
}

/**
 * Pulls the cursor back into view without moving it. A resize can shrink the
 * viewport under a cursor that was scrolled into the old one, and the frame
 * then rendered a window the cursor was not in.
 */
export function reanchor(state: PickerState, viewport: number): PickerState {
  return scrolled(state, state.cursor, viewport);
}

const none = (state: PickerState): { state: PickerState; action: PickerAction } => ({
  state,
  action: { kind: "none" },
});

export function applyKey(
  state: PickerState,
  key: Key,
  viewport: number,
): { state: PickerState; action: PickerAction } {
  if (key.name === "paste-start") return none({ ...state, pasting: true });
  if (key.name === "paste-end") return none({ ...state, pasting: false });

  // Inside a paste only text gets through. A `\n` in the middle of pasted text
  // must not choose a model, and a pasted `\x1b[A` must not move the cursor.
  if (state.pasting) {
    if (key.ctrl || key.meta || key.sequence.length !== 1) return none(state);
    if (key.sequence < " ") return none(state);
    return none({ ...state, filter: state.filter + key.sequence, cursor: 0, offset: 0 });
  }

  if (key.ctrl && key.name === "c") return { state, action: { kind: "aborted" } };
  if (key.ctrl && key.name === "g") return { state, action: { kind: "skipped" } };

  const items = visibleItems(state);
  const pending = state.confirming;
  const cleared = pending === undefined ? state : { ...state, confirming: undefined };

  if (key.name === "return") {
    const item = items[cleared.cursor];
    if (!item) return none(cleared);
    if (item.synthetic && item.id === "") return none(cleared);
    if (!item.synthetic || cleared.screen.known.has(item.id)) {
      return { state: cleared, action: { kind: "picked", id: item.id } };
    }
    if (pending === item.id) return { state: cleared, action: { kind: "picked", id: item.id } };
    return none({ ...cleared, confirming: item.id });
  }

  if (key.name === "up") return none(scrolled(cleared, Math.max(0, cleared.cursor - 1), viewport));
  if (key.name === "down") {
    return none(scrolled(cleared, Math.min(items.length - 1, cleared.cursor + 1), viewport));
  }
  if (key.name === "backspace") {
    return none({ ...cleared, filter: cleared.filter.slice(0, -1), cursor: 0, offset: 0 });
  }

  // Esc never skips: an arrow sequence that arrives fragmented shows up as a
  // lone escape, and skipping on that would throw away the user's answer.
  if (key.ctrl || key.meta || key.sequence.length !== 1) return none(cleared);
  if (key.sequence < " ") return none(cleared);

  return none({ ...cleared, filter: cleared.filter + key.sequence, cursor: 0, offset: 0 });
}
