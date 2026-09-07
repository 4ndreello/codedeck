export interface PickerItem {
  id: string;
  label: string;
  group?: string;
  /** The catalog's readable name, when it says something the id does not. */
  name?: string;
  note?: string;
  synthetic?: true;
  /** Which harness lists this model. Absent only on a row nothing can pick. */
  harness?: string;
}

export interface Screen {
  /** The role being answered, not a harness: one screen picks both halves. */
  role: string;
  title: string;
  counter: string;
  error?: string;
  /** Non-error explanatory lines that should remain visible above the list. */
  description?: readonly string[];
  items: PickerItem[];
  /** Screens that should follow this one, decided after its answer. */
  next?: (result: ScreenResult) => Screen[];
  /** `items[0]` is a pinned row, drawn above the group headers. */
  pinned: boolean;
  known: ReadonlySet<string>;
  /** Harness names free text may name, lowercase. */
  harnesses: ReadonlySet<string>;
}

/**
 * The catalog is keyed by both halves because a model id alone is ambiguous:
 * two harnesses can list the same one, and `run --agent` needs to know which
 * of them was picked.
 *
 * The separator is ":", the same one free text types and the summary line
 * prints, so the key stays readable wherever it surfaces (the confirm footer
 * shows it verbatim). Splitting it the other way would need a harness name
 * containing ":", and the four there are cannot, so a model id carrying one
 * is still unambiguous.
 */
export function itemKey(harness: string | undefined, id: string): string {
  return `${harness ?? ""}:${id}`;
}

export interface PickerState {
  screen: Screen;
  filter: string;
  cursor: number;
  offset: number;
  pasting: boolean;
  /** An `itemKey` waiting on a second Enter because the catalog lacks it. */
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
  | { kind: "picked"; id: string; harness: string }
  | { kind: "skipped" }
  | { kind: "aborted" };

/**
 * Lives here rather than in the session so the screen builder and the config
 * writer can use the vocabulary without pulling in raw mode.
 */
export type ScreenResult =
  | { kind: "picked"; role: string; harness: string; id: string }
  | { kind: "skipped"; role: string }
  | { kind: "aborted" };

export function initialState(screen: Screen): PickerState {
  return { screen, filter: "", cursor: 0, offset: 0, pasting: false };
}

/**
 * Searches everything the catalog knows about a model, not just what fits on
 * the row. The provider is on screen as a group header, so typing it and
 * getting nothing read as a broken filter, and the readable name is the only
 * place a version like "Opus 5" is spelled the way people say it.
 */
function matches(item: PickerItem, filter: string): boolean {
  return [item.label, item.id, item.group, item.name].some(
    (field) => field !== undefined && field.toLowerCase().includes(filter),
  );
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

/**
 * A model typed by hand has to name its harness, because the screen answers a
 * role and a bare id says nothing about who runs it. The separator is ":" and
 * not "/": opencode spells its own ids with a slash ("opencode/gpt-5.6-luna"),
 * so splitting on that would cut a real id in half.
 *
 * Only the first ":" separates. Everything after it is the model, verbatim.
 */
export function parseFreeText(
  raw: string,
  harnesses: ReadonlySet<string>,
): { harness: string; id: string } | undefined {
  const cut = raw.indexOf(":");
  if (cut <= 0) return undefined;
  const harness = raw.slice(0, cut).trim().toLowerCase();
  const id = raw.slice(cut + 1).trim();
  if (!id || !harnesses.has(harness)) return undefined;
  return { harness, id };
}

export function visibleItems(state: PickerState): PickerItem[] {
  const filter = state.filter.trim().toLowerCase();
  const hits = filter ? state.screen.items.filter((item) => matches(item, filter)) : state.screen.items;
  if (hits.length > 0) return hits;

  // Nothing to list, so the only way forward is writing the raw text. This is
  // also the whole screen when no installed harness reported a catalog, which
  // would never have a list to filter.
  const raw = state.filter.trim();
  const typed = parseFreeText(raw, state.screen.harnesses);
  if (typed) {
    return [{
      id: typed.id,
      label: `usar "${typed.id}" em ${typed.harness}`,
      harness: typed.harness,
      synthetic: true,
    }];
  }

  // An id with no harness in front of it is not a choice this screen can save,
  // so the row says what is missing rather than offering an Enter that would
  // have to guess. The empty id is what blocks that Enter.
  const example = [...state.screen.harnesses][0] ?? "codex";
  return [{
    id: "",
    label: raw ? `escreva ${example}:${raw}` : `digite harness:modelo, por exemplo ${example}:gpt-5.7`,
    synthetic: true,
  }];
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
    // Pasted text edits the filter like typed text does, so it has to drop a
    // pending confirmation the same way. Keeping it meant the footer asked
    // about one id while the row on screen was already another.
    return none({
      ...state,
      confirming: undefined,
      filter: state.filter + key.sequence,
      cursor: 0,
      offset: 0,
    });
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
    // Both halves or nothing. A row with no harness cannot be saved, and the
    // rows that reach here without one are exactly the ones already refused
    // above, so this only guards the type.
    if (!item.harness) return none(cleared);

    const entry = itemKey(item.harness, item.id);
    const picked = { kind: "picked", id: item.id, harness: item.harness } as const;
    if (!item.synthetic || cleared.screen.known.has(entry)) {
      return { state: cleared, action: picked };
    }
    // The pending confirmation is keyed by both halves, so answering it for one
    // harness cannot accept the same id under another.
    if (pending === entry) return { state: cleared, action: picked };
    return none({ ...cleared, confirming: entry });
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
