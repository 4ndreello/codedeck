// Parse layer of the orchestrator agents band.
//
// Turns the raw stdout of `codedeck ps --all --json` into rows the band can
// render. The engine draws the whole band in one pass, so a throw here would
// take the band down with it: every failure path returns undefined instead.

import type { SessionRow } from "./types.js";

// Raw stdout to rows. Returns undefined for anything that is not a JSON array,
// which is how a failed or truncated command is reported. Never throws.
export function parseRows(stdout: string): SessionRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const rows: SessionRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    // id is the one field the band cannot render without, so an entry without
    // a non-empty string id is dropped rather than passed through.
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    rows.push(entry as SessionRow);
  }
  return rows;
}
