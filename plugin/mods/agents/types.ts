// Shared shapes for the orchestrator agents band.
//
// Parse, select and format share this interface. The optional directory fields
// are a deliberate exception to the frozen interface, per the agents-pane path
// decision, so a worker's worktree or cwd can reach its card.
//
// SessionRow mirrors one element of `codedeck ps --all --json`. Every field
// past `id` is optional on purpose: the band reads a CLI it does not version
// with, so a missing field degrades one cell rather than the whole row.

export interface SessionRow {
  id: string;
  runId?: string;
  origin?: string | null;
  /** Session that dispatched this one; absent on rows older than lineage. */
  parentId?: string | null;
  role?: string | null;
  name?: string;
  agent?: string;
  model?: string;
  effort?: string;
  status?: string;
  updatedAt?: string;
  createdAt?: string;
  worktree?: string | null;
  cwd?: string | null;
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
  model?: string;
  effort?: string;
  name: string;
  updatedAt?: string;
  createdAt?: string;
  /**
   * Id of the card this one hangs from, or undefined when it hangs from the
   * run root. A parent outside the run (or a legacy row with none) is folded
   * onto the root so every row stays reachable.
   */
  parentId?: string;
  role?: string;
  path?: string;
}

/** Everything one drawing of the pane needs, already narrowed to one run. */
export interface PaneSnapshot {
  runId: string;
  /** The orchestrator's own row, the only one whose origin is "open". */
  orchestrator: { agent: string; model?: string; effort?: string; role?: string } | undefined;
  rows: PaneRow[];
  /** Rows that matched the run but fell outside the budget. */
  hidden: number;
  /** Every row of the run, including the orchestrator and the hidden ones. */
  total: number;
}
