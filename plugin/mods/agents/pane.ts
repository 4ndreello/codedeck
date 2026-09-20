// Canvas layer of the orchestrator agents pane.
//
// The `codedeck web` canvas, drawn as ASCII boxes for a docked terminal pane.
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

const STATUS_DOT = vocab({
  working: "●",
  starting: "●",
  needs_input: "◉",
});
const STATUS_WORD = vocab({
  working: "Trabalhando agora",
  starting: "Subindo",
  needs_input: "Esperando voce",
  completed: "Concluida",
  stopped: "Em pausa",
  failed: "Falhou",
});
const HARNESS_GLYPH = vocab({
  claude: "▲",
  opencode: "■",
  codex: "◆",
  omp: "⬟",
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

function toPaneRow(row: SessionRow): PaneRow {
  const iso = typeof row.updatedAt === "string" ? row.updatedAt : undefined;
  return {
    id: row.id,
    status: row.status || EMPTY_CELL,
    agent: row.agent || EMPTY_CELL,
    name: row.name || EMPTY_CELL,
    updatedAt: iso,
  };
}

/**
 * Narrow the daemon's full session list to one run. Never throws.
 *
 * Filters to `runId`, lifts the single `origin === "open"` row out as the
 * orchestrator, orders the rest by `updatedAt` descending with a total order,
 * and cuts to `budget`. With no explicit budget every matched row is kept and
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
      ? { agent: text(orchestratorRow.agent) || EMPTY_CELL }
      : undefined;
    const workers = matching.filter((row) => row.origin !== "open");
    const ordered = [...workers].sort(compareRows);
    const kept = ordered.slice(0, limit);
    return {
      runId: text(runId),
      orchestrator,
      rows: kept.map(toPaneRow),
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

function glyph(agent: unknown): string {
  const key = text(agent);
  return HARNESS_GLYPH[key] ?? "□";
}

function harnessLabel(agent: unknown): string {
  const key = text(agent);
  return HARNESS_LABEL[key] ?? cell(agent);
}

function dot(status: unknown): string {
  return STATUS_DOT[text(status)] ?? "○";
}

function statusWord(status: unknown): string {
  return STATUS_WORD[text(status)] ?? cell(status);
}

function age(iso: unknown, now: number): string {
  if (typeof iso !== "string") return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

// How old a row looks for eviction: an unparseable timestamp is the oldest
// possible age, matching how compareRows parks such rows at the end of the
// display. The orchestrator pins itself to +Infinity so it is the very last
// card to leave when the pane shrinks.
function rowAge(iso: unknown): number {
  const then = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(then) ? Number.NEGATIVE_INFINITY : then;
}

// One drawable piece of the pane: an orchestrator card, a worker card, or a
// collapsed finished row. `size` counts the block's own lines and never the
// connector above it: only the assembled order knows where a stem hangs, so
// `build` receives `connects`, whether the bottom edge grows the stem
// junction, and `lead`, whether a stem is drawn above the block.
type Block = {
  kind: "card" | "line";
  size: number;
  age: number;
  id: string;
  build: (connects: boolean, lead: boolean) => string[];
};

// One drawing pass, with the widths derived from the column budget. Kept inside
// its own function so formatPane can wrap the whole thing in one guard.
// `limit` is the usable body height in rows, or undefined for unbounded.
function draw(snapshot: PaneSnapshot, columns: number, limit: number | undefined): string[] {
  const source = (snapshot ?? {}) as Partial<PaneSnapshot>;
  const rows = (Array.isArray(source.rows) ? source.rows : []).map(
    (row) => (row ?? {}) as Partial<PaneRow>,
  );
  const orchestrator =
    source.orchestrator && typeof source.orchestrator === "object"
      ? (source.orchestrator as Partial<{ agent: string }>)
      : undefined;
  const hidden = count(source.hidden);
  const total = count(source.total);

  // Rule 10: nothing to draw when there is neither a card nor an orchestrator.
  if (rows.length === 0 && orchestrator === undefined) return [];

  const workerTotal = rows.length + hidden;
  const working = rows.filter((row) => LIVE.has(row.status ?? "")).length;
  const waiting = rows.filter((row) => WAIT.has(row.status ?? "")).length;
  // The overflow is reported by count only, its statuses are not in the
  // snapshot, so it is folded into "finished": the most recently touched
  // sessions are the live ones and stay inside the budget.
  const finished = Math.max(0, workerTotal - working - waiting);

  const W = Math.trunc(columns);
  const IN = W - 2;
  // Rule 8: the card box caps at MAX_CARD_COLUMNS no matter how wide the dock
  // gets; the outer frame still spans the full width. The two-space inset the
  // cards have always sat at inside the frame is kept.
  const CARD = Math.min(IN - 4, MAX_CARD_COLUMNS);
  const INNER = Math.max(0, CARD - 2);
  const now = Date.now();

  // Everything routed through frame* is exactly W wide.
  const frameRow = (s: string) => "│" + fit(s, IN) + "│";
  const frameSep = () => "├" + "─".repeat(IN) + "┤";
  const frameBot = () => "└" + "─".repeat(IN) + "┘";
  const frameTop = (label: string) =>
    "┌" + fit(("─ " + label + " ").replace(CONTROL, " "), IN, "─") + "┐";

  // A node card, indented inside the frame. The stem that joins it to whatever
  // sits above is drawn by the assembly, not by the block: the first block is
  // the root and never has one.
  const stem = () => frameRow("  " + " ".repeat(Math.floor(INNER / 2) + 1) + "│");
  const cardTop = () => frameRow("  ┌" + "─".repeat(INNER) + "┐");
  const cardRow = (s: string) => frameRow("  │" + fit(s, INNER) + "│");
  const stemAt = Math.floor(INNER / 2);
  const cardBottom = (connects: boolean) =>
    connects
      ? frameRow("  └" + "─".repeat(stemAt) + "┬" + "─".repeat(INNER - stemAt - 1) + "┘")
      : frameRow("  └" + "─".repeat(INNER) + "┘");

  const cardBlock = (ageValue: number, id: string, body: string[]): Block => ({
    kind: "card",
    size: body.length + 2,
    age: ageValue,
    id,
    build: (connects, lead) => [
      ...(lead ? [stem()] : []),
      cardTop(),
      ...body.map(cardRow),
      cardBottom(connects),
    ],
  });

  const blocks: Block[] = [];

  if (orchestrator !== undefined) {
    blocks.push(
      cardBlock(Number.POSITIVE_INFINITY, "", [
        ` ${glyph(orchestrator.agent)} ● Orquestrador`,
        `   ${harnessLabel(orchestrator.agent)} · ${workerTotal} agentes`,
      ]),
    );
  }

  for (const row of rows) {
    const status = row.status ?? "";
    // Rule 4: live rows draw as full cards; everything else collapses to one
    // line naming its glyph, dot, id, name and age.
    if (LIVE.has(status) || WAIT.has(status)) {
      const when = age(row.updatedAt, now);
      const word = statusWord(status);
      blocks.push(
        cardBlock(rowAge(row.updatedAt), cell(row.id), [
          ` ${glyph(row.agent)} ${dot(row.status)} ${cell(row.id)}  ${harnessLabel(row.agent)}`,
          `   ${cell(row.name)}`,
          when === "" ? `   ${word}` : `   ${word} · ${when}`,
        ]),
      );
    } else {
      const when = age(row.updatedAt, now);
      const line = ` ${glyph(row.agent)} ${dot(row.status)} ${cell(row.id)}  ${cell(row.name)}${
        when === "" ? "" : ` · ${when}`
      }`;
      blocks.push({
        kind: "line",
        size: 1,
        age: rowAge(row.updatedAt),
        id: cell(row.id),
        build: (_connects, lead) => [...(lead ? [stem()] : []), frameRow(line)],
      });
    }
  }

  // Whether the block at index i hangs from the one above it by a stem. The
  // first block is the root and never leads with one. A card is always joined
  // to what sits above it; a collapsed line only when it opens a run, so a
  // run of one liners costs a single row per entry.
  const stemAbove = (list: Block[], i: number): boolean =>
    i > 0 && (list[i].kind === "card" || list[i - 1].kind === "card");

  // Rule 3: these ten lines are the frame. Whenever anything is drawn at all
  // they are drawn, and they are never the lines that the fit cuts.
  const head = [
    frameTop(`Canvas do run ${cell(source.runId)}`),
    frameRow(` ${total} sessoes · ${working} trabalhando`),
    frameRow(` ${waiting} esperando voce · ${finished} prontas`),
    frameSep(),
    frameRow(""),
  ];
  const tail = [
    frameRow(""),
    frameSep(),
    frameRow(" ● trabalha  ◉ te espera  ○ pronta"),
    frameRow(" ▲ Claude    ■ OpenCode    ◆ Codex    ⬟ OMP"),
    frameBot(),
  ];
  const fixed = head.length + tail.length;
  // The hidden line keeps its own stem only when it hangs off a full card;
  // after a run of one liners it extends the list and costs a single row.
  const hiddenSize = (list: Block[]): number =>
    list.length > 0 && list[list.length - 1].kind === "card" ? 2 : 1;

  let kept = blocks;
  let dropped = 0;
  if (limit !== undefined) {
    // Rule 7: the frame alone does not fit, so nothing is drawn at all.
    if (limit < fixed) return [];
    // Rule 5: collapsed lines leave first, oldest first; then full cards,
    // oldest first. The hidden count grows with every row that leaves (rule 6).
    const victims = [...blocks].sort(
      (a, b) =>
        Number(a.kind === "card") - Number(b.kind === "card") ||
        a.age - b.age ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const sizeOf = (list: Block[]) =>
      list.reduce((sum, block, i) => sum + block.size + (stemAbove(list, i) ? 1 : 0), 0);
    const needed = () => fixed + sizeOf(kept) + (hidden + dropped > 0 ? hiddenSize(kept) : 0);
    for (let vi = 0; needed() > limit && vi < victims.length; vi += 1) {
      kept = kept.filter((block) => block !== victims[vi]);
      dropped += 1;
    }
    // Rule 6 outranks one more agent, but the height itself outranks
    // everything: every block has left and the hidden line still does not
    // fit, so the frame stands alone. kept is empty by here: the loop only
    // runs out of victims once every block is gone.
    if (needed() > limit && kept.length === 0 && hidden + dropped > 0) {
      return [...head, ...tail];
    }
  }

  const hiddenTotal = hidden + dropped;
  const hiddenRow = frameRow(`  +${hiddenTotal} agentes ocultos`);
  const out: string[] = [...head];
  for (let i = 0; i < kept.length; i += 1) {
    const connects = i < kept.length - 1 || hiddenTotal > 0;
    out.push(...kept[i].build(connects, stemAbove(kept, i)));
  }
  if (hiddenTotal > 0) {
    if (kept.length > 0 && kept[kept.length - 1].kind === "card") out.push(stem(), hiddenRow);
    else out.push(hiddenRow);
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
 * the pane back after the engine's own close box took it away. That close is
 * invisible to this module (verified live: clicking the pane's X fires no hook
 * at all), so the label never claims to know whether the pane is open and the
 * button only ever opens. Never throws: it is read inside a render hook.
 */
export function paneButtonLabel(snapshot: PaneSnapshot | undefined): string {
  if (!snapshot || typeof snapshot !== "object") return "agentes";
  try {
    const total = count((snapshot as Partial<PaneSnapshot>).total);
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const working = rows.filter((row) => LIVE.has(row?.status ?? "")).length;
    const head = `${total} ${total === 1 ? "agente" : "agentes"}`;
    return working > 0 ? `${head} · ${working} trabalhando` : head;
  } catch {
    return "agentes";
  }
}
