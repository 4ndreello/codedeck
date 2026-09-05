/**
 * Shared terminal drawing for the launcher and the first-run wizard, so the
 * two open with the same mark instead of each inventing one.
 */

import { visibleItems, type PickerState } from "./picker-state.js";

// Box-drawing letters, every row exactly 24 columns wide. Kept as three
// separate strings rather than one template so an editor cannot reflow it.
const LOGO = [
  "╔═╗╔═╗╔╦╗╔═╗╔╦╗╔═╗╔═╗╦╔═",
  "║  ║ ║║║║╠═ ║║║╠═ ║  ╠╩╗",
  "╚═╝╚═╝═╩╝╚═╝═╩╝╚═╝╚═╝╩ ╩",
];

export const INDENT = "  ";

/** What to assume when the terminal reports no width, as a pty with no window size does. */
const FALLBACK_WIDTH = 80;

/** The logo with an optional line of context under it. */
export function renderLogo(subtitle?: string): string {
  const lines = LOGO.map((line) => `${INDENT}${line}`);
  if (subtitle) lines.push(`${INDENT}${subtitle}`);
  return `\n${lines.join("\n")}\n`;
}

/**
 * Lay entries out in columns that fit the terminal.
 *
 * The list used to be joined with two spaces and handed to the terminal, which
 * wrapped it wherever the edge happened to fall, splitting model ids down the
 * middle. Widths are measured here instead, and one column is always used when
 * nothing else fits, because a long line beats a mangled one.
 */
export function columnize(entries: string[], width: number, indent: string = INDENT): string[] {
  if (entries.length === 0) return [];

  const gutter = 2;
  const cellWidth = Math.max(...entries.map((entry) => entry.length)) + gutter;
  const usable = Math.max((width || FALLBACK_WIDTH) - indent.length, cellWidth);
  const columns = Math.max(1, Math.floor(usable / cellWidth));
  const rows = Math.ceil(entries.length / columns);

  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    // Column-major, so the numbers read downwards the way a printed list does.
    for (let column = 0; column < columns; column++) {
      const entry = entries[column * rows + row];
      if (entry !== undefined) cells.push(entry.padEnd(cellWidth));
    }
    lines.push(`${indent}${cells.join("").trimEnd()}`);
  }
  return lines;
}

/**
 * A heading whose note sits at the right edge of the block it introduces, not
 * of the terminal. Aligning to the terminal leaves the note stranded halfway
 * across the screen on a wide window, reading as unrelated to the list.
 */
export function headingWith(title: string, note: string, blockWidth: number, indent: string = INDENT): string {
  const room = blockWidth - title.length - note.length;
  if (room < 2) return `${indent}${title} · ${note}`;
  return `${indent}${title}${" ".repeat(room)}${note}`;
}

/** How wide the widest line of a rendered block actually is. */
export function blockWidth(lines: string[], indent: string = INDENT): number {
  if (lines.length === 0) return 0;
  return Math.max(...lines.map((line) => line.length)) - indent.length;
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
  const blanks = 2;
  return logo + header + error + filterLine + footer + blanks;
}

export function viewportHeight(state: PickerState, dim: Dimensions): number {
  return Math.max(1, dim.rows - chromeHeight(state, dim));
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

  const items = visibleItems(state);
  const viewport = viewportHeight(state, dim);
  const filtering = state.filter.trim().length > 0;
  let lastGroup: string | undefined;

  for (let i = state.offset; i < Math.min(items.length, state.offset + viewport); i++) {
    const item = items[i];
    // Headers are dead weight once a filter is on, so the provider moves to the
    // end of each row instead.
    if (!filtering && item.group && item.group !== lastGroup && !(state.screen.pinned && i === 0)) {
      lastGroup = item.group;
      const count = state.screen.items.filter((candidate) => candidate.group === item.group).length;
      lines.push(groupHeader(item.group, count, width));
    }
    const marker = i === state.cursor ? "› " : "  ";
    const trailer = filtering ? item.group : item.note;
    const suffix = trailer ? `  ${c.dim(trailer)}` : "";
    lines.push(`${INDENT}${marker}${item.label}${suffix}`);
  }

  const footer = state.confirming
    ? `"${state.confirming}" nao esta no catalogo. Enter de novo grava assim mesmo, ^G volta`
    : filtering
      ? `${items.length} de ${state.screen.items.length}   move ^ v   Enter escolhe   ^G pula   ^C sai`
      : `move ^ v   Enter escolhe   ^G pula   ^C sai`;
  lines.push(`${INDENT}${c.dim(footer)}`);

  return lines.map((line) => truncate(line, width));
}
