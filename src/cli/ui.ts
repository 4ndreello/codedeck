/**
 * Shared terminal drawing for the launcher and the first-run wizard, so the
 * two open with the same mark instead of each inventing one.
 */

import { hitCount, visibleItems, type PickerState } from "./picker-state.js";

// Box-drawing letters, every row exactly 24 columns wide. Kept as three
// separate strings rather than one template so an editor cannot reflow it.
const LOGO = [
  "╔═╗╔═╗╔╦╗╔═╗╔╦╗╔═╗╔═╗╦╔═",
  "║  ║ ║║║║╠═ ║║║╠═ ║  ╠╩╗",
  "╚═╝╚═╝═╩╝╚═╝═╩╝╚═╝╚═╝╩ ╩",
];

export const INDENT = "  ";

/** The logo with an optional line of context under it. */
export function renderLogo(subtitle?: string): string {
  const lines = LOGO.map((line) => `${INDENT}${line}`);
  if (subtitle) lines.push(`${INDENT}${subtitle}`);
  return `\n${lines.join("\n")}\n`;
}

export interface Dimensions {
  rows: number;
  columns: number;
}

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  invert(s: string): string;
}

const RESET = "\x1b[0m";

/**
 * Color is a factory rather than an environment read, because the renderer has
 * to stay pure: with color off in tests, visible width is string length.
 */
export function colors(enabled: boolean): Colors {
  const paint = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}${RESET}` : s);
  return { bold: paint("1"), dim: paint("2"), invert: paint("7") };
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleWidth(text: string): number {
  return text.replace(ANSI, "").length;
}

/**
 * Cuts by visible characters and closes any escape it left open, otherwise the
 * color bleeds into the rest of the line.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;

  let out = "";
  let seen = 0;
  let painted = false;
  for (let i = 0; i < text.length; ) {
    ANSI.lastIndex = i;
    const match = ANSI.exec(text);
    if (match && match.index === i) {
      out += match[0];
      painted = match[0] !== RESET;
      i += match[0].length;
      continue;
    }
    if (seen === width) break;
    out += text[i];
    seen += 1;
    i += 1;
  }
  return painted ? `${out}${RESET}` : out;
}

const FALLBACK: Dimensions = { rows: 24, columns: 80 };

/**
 * `0` and `undefined` mean the same thing here: a terminal that did not report
 * its size. `??` would take `0` for an answer and collapse the layout, and
 * `Math.max(3, undefined - 9)` is NaN.
 */
export function readDimensions(stdout: { rows?: number; columns?: number }): Dimensions {
  return {
    rows: stdout.rows || FALLBACK.rows,
    columns: stdout.columns || FALLBACK.columns,
  };
}

/** Below this the logo costs more rows than it is worth. */
const LOGO_MIN_ROWS = 15;

function drawsLogo(dim: Dimensions): boolean {
  return dim.rows >= LOGO_MIN_ROWS;
}

/**
 * Counted, not a constant: the error line and the logo only exist sometimes,
 * and a wrong constant here silently cuts items off the list.
 */
export function chromeHeight(state: PickerState, dim: Dimensions): number {
  const logo = drawsLogo(dim) ? LOGO.length + 1 : 0;
  const header = 1;
  const error = state.screen.error ? 1 : 0;
  const filterLine = 1;
  const footer = 1;
  // One: the blank above the filter. The logo brings its own, already counted.
  const blank = 1;
  return logo + header + error + filterLine + footer + blank;
}

const PLAIN = colors(false);

/**
 * The item rows and how many items they cover. One walk answers both because
 * the group headers take rows too: budgeting by item alone grew the frame past
 * the terminal, and the redraw then moved the cursor up by fewer lines than it
 * had just printed.
 */
function itemBlock(state: PickerState, dim: Dimensions, c: Colors): { lines: string[]; shown: number } {
  const items = visibleItems(state);
  const filtering = state.filter.trim().length > 0;
  const budget = Math.max(1, dim.rows - chromeHeight(state, dim));

  const lines: string[] = [];
  let shown = 0;
  let lastGroup: string | undefined;

  for (let i = state.offset; i < items.length && lines.length < budget; i++) {
    const item = items[i];
    // Headers are dead weight once a filter is on, so the provider moves to the
    // end of each row instead.
    const group =
      !filtering && item.group && item.group !== lastGroup && !(state.screen.pinned && i === 0)
        ? item.group
        : undefined;
    if (group) {
      lastGroup = group;
      // The header is the first thing to drop on a short terminal: a list with
      // no items reads worse than one with no group labels.
      if (lines.length + 2 <= budget) {
        const count = state.screen.items.filter((candidate) => candidate.group === group).length;
        lines.push(groupHeader(group, count, dim.columns));
      }
    }
    const marker = i === state.cursor ? "› " : "  ";
    const trailer = filtering ? item.group : item.note;
    const suffix = trailer ? `  ${c.dim(trailer)}` : "";
    lines.push(`${INDENT}${marker}${item.label}${suffix}`);
    shown += 1;
  }

  return { lines, shown };
}

export function viewportHeight(state: PickerState, dim: Dimensions): number {
  return Math.max(1, itemBlock(state, dim, PLAIN).shown);
}

function groupHeader(group: string, count: number, width: number): string {
  const label = ` ${group} `;
  const tail = ` ${count} `;
  const room = Math.max(0, width - INDENT.length - label.length - tail.length - 4);
  return `${INDENT}--${label}${"-".repeat(room)}${tail}--`;
}

export function renderFrame(state: PickerState, dim: Dimensions, c: Colors): string[] {
  const width = dim.columns;
  const lines: string[] = [];

  if (drawsLogo(dim)) {
    for (const row of LOGO) lines.push(`${INDENT}${row}`);
    lines.push("");
  }

  lines.push(`${INDENT}${c.bold(`${state.screen.title}  ~  ${state.screen.counter}`)}`);
  if (state.screen.error) lines.push(`${INDENT}${c.dim(state.screen.error)}`);

  lines.push("");
  lines.push(`${INDENT}filtrar: ${state.filter}`);

  const filtering = state.filter.trim().length > 0;
  for (const line of itemBlock(state, dim, c).lines) lines.push(line);

  const footer = state.confirming
    ? `"${state.confirming}" nao esta no catalogo. Enter de novo grava assim mesmo, ^G volta`
    : filtering
      ? `${hitCount(state)} de ${state.screen.items.length}   move ^ v   Enter escolhe   ^G pula   ^C sai`
      : `move ^ v   Enter escolhe   ^G pula   ^C sai`;
  lines.push(`${INDENT}${c.dim(footer)}`);

  return lines.map((line) => truncate(line, width));
}
