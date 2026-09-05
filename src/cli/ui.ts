/**
 * Shared terminal drawing for the launcher and the first-run wizard, so the
 * two open with the same mark instead of each inventing one.
 */

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
