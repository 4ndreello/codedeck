// Canvas layer of the orchestrator agents pane.
//
// The run canvas, drawn as ASCII boxes for a docked terminal pane.
// Two pure functions behind one frozen interface: selectPane narrows the
// daemon's full session list to one run, formatPane turns that snapshot into
// the lines of the drawing and fits them to the height the pane was given.
// The engine draws them inside a render hook, where a throw drops the whole
// pane, so nothing here throws and nothing here reaches for the engine.
//
// Every line comes out exactly `columns` code units wide so the frame never
// looks ragged, and no line ever carries a line break, a tab or a control
// character: everything the daemon supplied is sanitised and clipped first.
// The filtering and ordering rules are carried across from the deleted
// select.ts; the sanitising and surrogate-safe clipping from format.ts.

import type { PaneRow, PaneSnapshot, SessionRow } from "./types.js";

/** Cards never stretch past this, however wide the dock is. */
export const MAX_CARD_COLUMNS = 56;

/** Keep finished work useful without turning the pane into a transcript. */
const HISTORY_PREVIEW_ROWS = 3;

/** Below this many usable columns the pane draws nothing rather than garbage. */
export const MIN_COLUMNS = 24;

/** Placeholder for a cell the daemon did not supply. Rule 13. */
const EMPTY_CELL = "-";

// Control characters and the line-terminator separators would break the frame,
// so they become spaces before anything is drawn. Carried across verbatim from
// format.ts: the C0 block (which holds \n, \r, \t, \v, \f and the ESC CSI
// sequences), DEL, the C1 block, and U+2028 / U+2029.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Status buckets, matching the web canvas. working and starting are "working";
// needs_input is "waiting for you"; everything else is finished.
const LIVE = new Set(["working", "starting"]);
const WAIT = new Set(["needs_input"]);

// Vocabulary for the drawing. Unknown statuses and harnesses fall back to the
// raw value or a generic glyph, never to undefined. These maps are keyed by
// daemon-supplied strings, so they get a null prototype: a plain `{}` would
// resolve an agent or status of "constructor" through Object.prototype and draw
// a function's source into the card, where the `??` fallback never fires.
function vocab(entries: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>, entries);
}

const STATUS_WORD = vocab({
  working: "Working",
  starting: "Starting",
  needs_input: "Waiting for you",
  completed: "Completed",
  stopped: "Paused",
  failed: "Failed",
});
// Brand marks from the JetBrains Nerd Font and Omarchy icon font. The pane is
// a terminal surface, so these keep the identity of each harness without
// spending the width of its full name.
const HARNESS_GLYPH = vocab({
  claude: "\uEC82",
  opencode: "\uE902",
  codex: "\uEC81",
  omp: "\uE903",
});
const HARNESS_LABEL = vocab({
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex",
  omp: "OMP",
});

function timestamp(row: SessionRow): number {
  return typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : Number.NaN;
}

// Newest first; a row with no parseable updatedAt sorts last; ties break by id
// so the order is total and the pane does not flicker between refreshes.
function compareRows(a: SessionRow, b: SessionRow): number {
  const ta = timestamp(a);
  const tb = timestamp(b);
  const hasA = !Number.isNaN(ta);
  const hasB = !Number.isNaN(tb);
  if (hasA !== hasB) return hasA ? -1 : 1;
  if (hasA && ta !== tb) return tb - ta;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// An omitted or non-finite budget means "keep everything": the default cut is
// formatPane's job now, because only it knows the pane height.
function budgetLimit(budget: number | undefined): number {
  if (typeof budget !== "number" || !Number.isFinite(budget)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.trunc(budget));
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

/** Shorten a leading home directory without relying on a process global. */
export function displayPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

// `workers` is the set of ids the snapshot keeps: a parent outside it (the
// run root, a row cut by the budget, a legacy row with no parent) leaves
// parentId undefined, which draws the card under the root.
function toPaneRow(row: SessionRow, workers: ReadonlySet<string>): PaneRow {
  const iso = typeof row.updatedAt === "string" ? row.updatedAt : undefined;
  const parent = text(row.parentId);
  const path =
    typeof row.worktree === "string" && row.worktree !== ""
      ? row.worktree
      : typeof row.cwd === "string" && row.cwd !== ""
        ? row.cwd
        : undefined;
  return {
    id: row.id,
    status: row.status || EMPTY_CELL,
    agent: row.agent || EMPTY_CELL,
    model: text(row.model) || undefined,
    effort: text(row.effort) || undefined,
    name: row.name || EMPTY_CELL,
    updatedAt: iso,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    parentId: parent !== "" && parent !== row.id && workers.has(parent) ? parent : undefined,
    role: text(row.role) || undefined,
    path,
  };
}

/**
 * Narrow the daemon's full session list to one run. Never throws.
 *
 * Filters to `runId`, lifts the single `origin === "open"` row out as the
 * orchestrator, orders the rest by `updatedAt` descending with a total order,
 * and cuts to `budget`. Each kept row carries the id of the kept row that
 * dispatched it, so formatPane can draw who started whom. With no explicit budget every matched row is kept and
 * `hidden` is 0; dropping rows to fit the pane is formatPane's decision.
 */
export function selectPane(rows: SessionRow[], runId: string, budget?: number): PaneSnapshot {
  try {
    const limit = budgetLimit(budget);
    const source = Array.isArray(rows) ? rows : [];
    const matching = source.filter(
      (row) => row != null && typeof row === "object" && (row as SessionRow).runId === runId,
    );
    const orchestratorRow = matching.find((row) => row.origin === "open");
    const orchestrator = orchestratorRow
      ? {
          agent: text(orchestratorRow.agent) || EMPTY_CELL,
          model: text(orchestratorRow.model) || undefined,
          effort: text(orchestratorRow.effort) || undefined,
          role: text(orchestratorRow.role) || undefined,
        }
      : undefined;
    const workers = matching.filter((row) => row.origin !== "open");
    const ordered = [...workers].sort(compareRows);
    const kept = ordered.slice(0, limit);
    const keptIds = new Set(kept.map((row) => row.id));
    return {
      runId: text(runId),
      orchestrator,
      rows: kept.map((row) => toPaneRow(row, keptIds)),
      hidden: ordered.length - kept.length,
      total: matching.length,
    };
  } catch {
    return { runId: "", orchestrator: undefined, rows: [], hidden: 0, total: 0 };
  }
}

// A cell the daemon supplied: control and separator characters become spaces,
// the ends are trimmed, and an empty result is a placeholder. Rule 7.
function cell(value: unknown): string {
  const clean = text(value).replace(CONTROL, " ").trim();
  return clean === "" ? EMPTY_CELL : clean;
}

// Cut to `width` code units, never wrap, and never strand half of a surrogate
// pair. Carried across from format.ts, with a marker so a clipped value reads
// as clipped. The result is always exactly `width` units after the padEnd.
function fit(value: string, width: number, fill = " "): string {
  if (width <= 0) return "";
  if (value.length <= width) return value.padEnd(width, fill);
  let cut = value.slice(0, width - 1);
  const tail = cut.charCodeAt(cut.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) cut = cut.slice(0, -1);
  return (cut + "…").padEnd(width, fill);
}

// Keep the tail of a value, never leave half a surrogate pair after the marker,
// and pad to the exact width used by the pane.
function fitStart(value: string, width: number, fill = " "): string {
  if (width <= 0) return "";
  if (value.length <= width) return value.padEnd(width, fill);
  let start = value.length - (width - 1);
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return ("…" + value.slice(start)).padEnd(width, fill);
}

function glyph(agent: unknown): string {
  const key = text(agent);
  return HARNESS_GLYPH[key] ?? "□";
}

function harnessLabel(agent: unknown): string {
  const key = text(agent);
  return HARNESS_LABEL[key] ?? cell(agent);
}

function statusWord(status: unknown): string {
  return STATUS_WORD[text(status)] ?? cell(status);
}

function footerLegend(columns: number): string {
  const fullHarness =
    " " +
    glyph("claude") +
    " Claude  " +
    glyph("opencode") +
    " OpenCode  " +
    glyph("codex") +
    " Codex  " +
    glyph("omp") +
    " OMP";
  if (fullHarness.length <= columns - 2) return fullHarness;

  const iconHarness =
    " " + glyph("claude") + "  " + glyph("opencode") + "  " + glyph("codex") + "  " + glyph("omp");
  return iconHarness;
}

function age(iso: unknown, now: number): string {
  if (typeof iso !== "string") return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** Stable elapsed-time text for a card detail line. */
export function elapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const paddedSeconds = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${paddedSeconds}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${paddedSeconds}s`;
}

function cardElapsed(row: Partial<PaneRow>, now: number): string {
  if (typeof row.createdAt !== "string") return "";
  const createdAt = Date.parse(row.createdAt);
  if (!Number.isFinite(createdAt)) return "";

  const live = LIVE.has(row.status ?? "") || WAIT.has(row.status ?? "");
  const endAt = live
    ? now
    : typeof row.updatedAt === "string"
      ? Date.parse(row.updatedAt)
      : Number.NaN;
  if (!Number.isFinite(endAt)) return "";
  return elapsed(endAt - createdAt);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function detailLine(model: unknown, effort: unknown, status: string, when: string, width: number): string {
  const state = status ? `${status}${when ? ` · ${when}` : ""}` : "";
  const suffix = [text(effort).trim() ? `${cell(effort)} effort` : "", state]
    .filter(Boolean)
    .join(" · ");
  const modelWidth = width - 3 - suffix.length - (suffix ? 3 : 0);
  const modelText = text(model).trim() && modelWidth > 0 ? fit(cell(model), modelWidth).trimEnd() : "";
  return `   ${[modelText, suffix].filter(Boolean).join(" · ")}`;
}

// How old a row looks for eviction: an unparseable timestamp is the oldest
// possible age, matching how compareRows parks such rows at the end of the
// display. The orchestrator pins itself to +Infinity so it is the very last
// card to leave when the pane shrinks.
function rowAge(iso: unknown): number {
  const then = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(then) ? Number.NEGATIVE_INFINITY : then;
}

// One card of the lineage tree. `children` holds only the cards drawn under
// it; finished leaves go to the history section instead of the tree.
type Card = {
  id: string;
  age: number;
  body: (inner: number) => string[];
  parent: Card | undefined;
  children: Card[];
};

function roleLabel(role: unknown): string {
  const clean = cell(role);
  return clean === EMPTY_CELL ? "" : clean.charAt(0).toUpperCase() + clean.slice(1);
}

// One drawing pass, with the widths derived from the column budget. Kept inside
// its own function so formatPane can wrap the whole thing in one guard.
// `limit` is the usable body height in rows, or undefined for unbounded.
//
// The body is a tree: every card hangs from the session that dispatched it,
// so a reviewer a worker started is drawn under that worker rather than under
// the run root. A child card joins its parent through an elbow on the card's
// first body line; the parent's bottom edge carries a tee where the trunk
// leaves it.
function draw(snapshot: PaneSnapshot, columns: number, limit: number | undefined): string[] {
  const source = (snapshot ?? {}) as Partial<PaneSnapshot>;
  const rows = (Array.isArray(source.rows) ? source.rows : []).map(
    (row) => (row ?? {}) as Partial<PaneRow>,
  );
  const orchestrator =
    source.orchestrator && typeof source.orchestrator === "object"
      ? (source.orchestrator as Partial<{ agent: string; model: string; effort: string; role: string }>)
      : undefined;
  const hidden = count(source.hidden);
  const total = count(source.total);

  // Rule 10: nothing to draw when there is neither a card nor an orchestrator.
  if (rows.length === 0 && orchestrator === undefined) return [];

  const workerTotal = rows.length + hidden;
  const isLive = (row: Partial<PaneRow>) => LIVE.has(row.status ?? "") || WAIT.has(row.status ?? "");
  const working = rows.filter((row) => LIVE.has(row.status ?? "")).length;
  const waiting = rows.filter((row) => WAIT.has(row.status ?? "")).length;
  // The overflow is reported by count only, its statuses are not in the
  // snapshot, so it is folded into "finished": the most recently touched
  // sessions are the live ones and stay inside the budget.
  const finished = Math.max(0, workerTotal - working - waiting);

  const W = Math.trunc(columns);
  const IN = W - 2;
  const now = Date.now();

  // Everything routed through frame* is exactly W wide.
  const frameRow = (s: string) => "│" + fit(s, IN) + "│";
  const frameSep = () => "├" + "─".repeat(IN) + "┤";
  const frameBot = () => "└" + "─".repeat(IN) + "┘";
  const frameTop = (label: string) =>
    "┌" + fit(("─ " + label + " ").replace(CONTROL, " "), IN, "─") + "┐";

  // Lineage. A row whose parent is not in the snapshot hangs from the root;
  // a parent chain that loops is cut there, so every row is reachable once.
  const byId = new Map<string, Partial<PaneRow>>();
  for (const row of rows) if (typeof row.id === "string" && !byId.has(row.id)) byId.set(row.id, row);
  const declared = (row: Partial<PaneRow>): Partial<PaneRow> | undefined => {
    const id = typeof row.parentId === "string" ? row.parentId : undefined;
    return id !== undefined && id !== row.id ? byId.get(id) : undefined;
  };
  // A row on a parent loop hangs from the root instead.
  const onLoop = (row: Partial<PaneRow>): boolean => {
    const seen = new Set<Partial<PaneRow>>();
    for (let up = declared(row); up !== undefined && !seen.has(up); up = declared(up)) {
      if (up === row) return true;
      seen.add(up);
    }
    return false;
  };
  const parentOf = (row: Partial<PaneRow>): Partial<PaneRow> | undefined =>
    onLoop(row) ? undefined : declared(row);
  const ancestors = (row: Partial<PaneRow>): Partial<PaneRow>[] => {
    const chain: Partial<PaneRow>[] = [];
    const seen = new Set<Partial<PaneRow>>([row]);
    for (let up = parentOf(row); up !== undefined && !seen.has(up); up = parentOf(up)) {
      seen.add(up);
      chain.push(up);
    }
    return chain;
  };

  // A card for every live row and for every ancestor of one, finished or
  // not, so a live reviewer never floats free of the worker that started it.
  const carded = new Set<Partial<PaneRow>>();
  for (const row of rows) {
    if (!isLive(row)) continue;
    carded.add(row);
    for (const up of ancestors(row)) carded.add(up);
  }
  const historyRows = rows.filter((row) => !carded.has(row));

  const workerBody = (row: Partial<PaneRow>) => (inner: number): string[] => {
    const role = roleLabel(row.role);
    const status = row.status ?? "";
    const path =
      typeof row.path === "string" && row.path !== ""
        ? "   " + fitStart(displayPath(cell(row.path)), Math.max(0, inner - 3))
        : undefined;
    return [
      ` ${glyph(row.agent)} ${cell(row.id)}  ${role ? `${role} · ` : ""}${harnessLabel(row.agent)}`,
      `   ${cell(row.name)}`,
      detailLine(row.model, row.effort, statusWord(status), cardElapsed(row, now), inner),
      ...(path === undefined ? [] : [path]),
    ];
  };

  const root: Card | undefined =
    orchestrator === undefined
      ? undefined
      : {
          id: "",
          age: Number.POSITIVE_INFINITY,
          parent: undefined,
          children: [],
          body: (inner) => [
            ` ${glyph(orchestrator.agent)} ${roleLabel(orchestrator.role) || "Orchestrator"}`,
            `   ${harnessLabel(orchestrator.agent)} · ${workerTotal} agents`,
            ...(text(orchestrator.model).trim() || text(orchestrator.effort).trim()
              ? [detailLine(orchestrator.model, orchestrator.effort, "", "", inner)]
              : []),
          ],
        };

  // Rows arrive newest first, so siblings keep that order.
  const cards = new Map<Partial<PaneRow>, Card>();
  for (const row of rows) {
    if (!carded.has(row)) continue;
    cards.set(row, { id: cell(row.id), age: rowAge(row.updatedAt), body: workerBody(row), parent: undefined, children: [] });
  }
  const tops: Card[] = root ? [root] : [];
  for (const row of rows) {
    const card = cards.get(row);
    if (!card) continue;
    const chain = ancestors(row);
    const up = chain.length > 0 ? cards.get(chain[0]) : undefined;
    card.parent = up ?? root;
    if (card.parent) card.parent.children.push(card);
    else tops.push(card);
  }

  // Card width at a depth: capped at MAX_CARD_COLUMNS, shrinking as the tree
  // indents, never so narrow the frame cannot clip it cleanly.
  const cardWidth = (depth: number) => Math.max(10, Math.min(IN - 4 - 4 * depth, MAX_CARD_COLUMNS));

  // A finished worker kept as a card for a live child is not history.
  const historyCount = historyRows.length + hidden;
  const historyLines = (): string[] => {
    if (historyCount === 0) return [];
    const preview = historyRows.slice(0, HISTORY_PREVIEW_ROWS);
    const lines = [`  ─ HISTORY · ${historyCount} finished`];
    for (const row of preview) {
      const when = age(row.updatedAt, now);
      const up = parentOf(row);
      lines.push(
        `   ${glyph(row.agent)} ${cell(row.id)}  ${cell(row.name)}` +
          (up ? ` ← ${cell(up.id)}` : "") +
          (when === "" ? "" : ` · ${when}`),
      );
    }
    const older = historyCount - preview.length;
    if (older > 0) lines.push(`   +${older} earlier`);
    return lines;
  };

  // Draw the kept part of the tree. `kept` holds the cards still on screen;
  // an evicted card's children were evicted before it, so the tree stays
  // connected.
  const render = (kept: Set<Card>, withHistory: boolean, hiddenTotal: number): string[] => {
    const out: string[] = [];
    // `rails[k]` says whether the ancestor at depth k+1 has a later sibling,
    // which keeps its vertical rail running past this card.
    const walk = (card: Card, depth: number, rails: boolean[], last: boolean) => {
      const width = cardWidth(depth);
      const inner = width - 2;
      const shown = card.children.filter((child) => kept.has(child));
      const lines = [
        "┌" + "─".repeat(inner) + "┐",
        ...card.body(inner).map((line) => "│" + fit(line, inner) + "│"),
        shown.length > 0
          ? "└─┬" + "─".repeat(Math.max(0, inner - 2)) + "┘"
          : "└" + "─".repeat(inner) + "┘",
      ];
      lines.forEach((line, i) => {
        let prefix = rails.map((rail) => (rail ? "  │ " : "    ")).join("");
        let body = line;
        if (depth > 0) {
          if (i === 0) prefix += "  │ ";
          else if (i === 1) {
            prefix += last ? "  └─" : "  ├─";
            body = "┤" + line.slice(1);
          } else prefix += last ? "    " : "  │ ";
        }
        out.push(frameRow("  " + prefix + body));
      });
      shown.forEach((child, i) =>
        walk(child, depth + 1, depth > 0 ? [...rails, !last] : rails, i === shown.length - 1),
      );
    };
    for (const top of tops) if (kept.has(top)) walk(top, 0, [], true);
    const history = withHistory ? historyLines() : [];
    if (history.length > 0 && out.length > 0) out.push(frameRow(""));
    out.push(...history.map(frameRow));
    if (hiddenTotal > 0) out.push(frameRow(`  +${hiddenTotal} hidden agents`));
    return out;
  };

  // These frame lines are always drawn when the pane has content.
  const head = [
    frameTop(`Run canvas ${cell(source.runId)}`),
    frameRow(` ${total} sessions · ${working} working`),
    frameRow(` ${waiting} waiting for you · ${finished} finished`),
    frameSep(),
    frameRow(""),
  ];
  const tail = [frameSep(), frameRow(footerLegend(W)), frameBot()];
  const fixed = head.length + tail.length;

  const all = new Set<Card>();
  const collect = (card: Card) => {
    all.add(card);
    card.children.forEach(collect);
  };
  tops.forEach(collect);

  let kept = all;
  let withHistory = true;
  let dropped = 0;
  let hiddenTotal = 0;
  if (limit !== undefined) {
    // Rule 7: the frame alone does not fit, so nothing is drawn at all.
    if (limit < fixed) return [];
    const needed = () => fixed + render(kept, withHistory, 0).length;
    // History leaves first, then cards oldest first, and only a card with no
    // child left on screen, so the tree never loses a link. The root carries
    // +Infinity and is the last to go. The hidden count follows sessions,
    // not rendered lines.
    if (needed() > limit && historyLines().length > 0) {
      withHistory = false;
      dropped += historyCount;
    }
    kept = new Set(all);
    while (needed() > limit && kept.size > 0) {
      const leaves = [...kept].filter((card) => !card.children.some((child) => kept.has(child)));
      leaves.sort((a, b) => a.age - b.age || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const victim = leaves[0];
      kept.delete(victim);
      if (victim !== root) dropped += 1;
    }
    // A hidden line is useful only when it does not displace a live card.
    if (dropped > 0 && fixed + render(kept, withHistory, dropped).length <= limit) hiddenTotal = dropped;
  }

  const out: string[] = [...head, ...render(kept, withHistory, hiddenTotal)];
  if (limit !== undefined) {
    const spare = limit - out.length - tail.length;
    for (let i = 0; i < spare; i += 1) out.push(frameRow(""));
  }
  out.push(...tail);
  return out;
}

/**
 * The whole drawing, one string per line, every line exactly `columns` wide.
 * `rows` is the usable body height. When given, the result never exceeds it.
 * Returns [] when there is nothing to draw, the pane is too narrow, or the
 * height cannot hold even the frame. Never throws.
 */
export function formatPane(
  snapshot: PaneSnapshot,
  columns: number,
  rows?: number,
): string[] {
  if (typeof columns !== "number" || !Number.isFinite(columns)) return [];
  if (Math.trunc(columns) < MIN_COLUMNS) return [];
  const limit =
    typeof rows === "number" && Number.isFinite(rows) ? Math.trunc(rows) : undefined;
  try {
    return draw(snapshot, columns, limit);
  } catch {
    return [];
  }
}

/**
 * Label for the button drawn above the prompt, the one affordance that brings
 * the pane back after the engine's own close box took it away. It reports only
 * current attention states, never the historical run total. Never throws: it
 * is read inside a render hook.
 */
export function paneButtonLabel(snapshot: PaneSnapshot | undefined): string {
  if (!snapshot || typeof snapshot !== "object") return "agents";
  try {
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const workingRows = rows.filter((row) => LIVE.has(row?.status ?? ""));
    if (workingRows.length > 0) {
      return `${workingRows.length} working ${workingRows.map((row) => glyph(row?.agent)).join("")}`;
    }
    const waitingRows = rows.filter((row) => WAIT.has(row?.status ?? ""));
    return waitingRows.length > 0
      ? `${waitingRows.length} waiting for you ${waitingRows.map((row) => glyph(row?.agent)).join("")}`
      : "no active agents";
  } catch {
    return "agents";
  }
}
