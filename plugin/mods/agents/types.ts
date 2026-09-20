// Shared shapes for the orchestrator agents band.
//
// Owned by the interface, not by any one slice: parse, select and format are
// written against this file and none of them may change it.
//
// SessionRow mirrors one element of `codedeck ps --all --json`. Every field
// past `id` is optional on purpose: the band reads a CLI it does not version
// with, so a missing field degrades one cell rather than the whole row.

export interface SessionRow {
  id: string;
  runId?: string;
  origin?: string | null;
  name?: string;
  agent?: string;
  status?: string;
  updatedAt?: string;
}

/**
 * One agent card in the pane. The canvas draws a glyph per harness and an age,
 * so the raw harness id and the timestamp survive here rather than being
 * flattened into a label.
 */
export interface PaneRow {
  id: string;
  status: string;
  agent: string;
  name: string;
  updatedAt?: string;
}

/** Everything one drawing of the pane needs, already narrowed to one run. */
export interface PaneSnapshot {
  runId: string;
  /** The orchestrator's own row, the only one whose origin is "open". */
  orchestrator: { agent: string } | undefined;
  rows: PaneRow[];
  /** Rows that matched the run but fell outside the budget. */
  hidden: number;
  /** Every row of the run, including the orchestrator and the hidden ones. */
  total: number;
}
