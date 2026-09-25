# Worker lineage

## Goal

Show who dispatched whom. Today every session of a run shares one `runId`
(the `open` session's id), and `codedeck run` inside a worker inherits that
same `CODEDECK_RUN_ID`. The run canvas therefore draws every worker as a
direct child of a card labelled "Orchestrator", even when the root is a
`general` session and the reviewer was started by a worker, not by the root.

## Verified ground

- `SessionRuntime.spawn` already puts `CODEDECK_SESSION_ID=<worker id>` in
  every worker harness environment (`src/drivers/session-runtime.ts`).
- `open` puts `CODEDECK_RUN_ID=<open id>` in the harness environment; the open
  session row has `origin: "open"` and `runId === id`.
- `session.list` returns full session rows, so new columns reach
  `codedeck ps --json` and the agents pane without extra plumbing.

## Acceptance criteria

- AC1: A session row SHALL carry `parentId`, the session that dispatched it,
  and `role`, the CodeDeck role it was started with.
- AC2: `codedeck run` SHALL send `parentId = CODEDECK_SESSION_ID`, falling
  back to `CODEDECK_RUN_ID`, and `role = parseRole(--role)`.
- AC3: `open` SHALL set `CODEDECK_SESSION_ID` to its own id and send its role
  on `session.adopt`.
- AC4: The daemon SHALL record `parentId` only when the parent exists in the
  store, and SHALL inherit the parent's `runId` when the request has none.
- AC5: The run canvas SHALL draw a tree: each card hangs from its dispatcher.
  A parent outside the snapshot, or a legacy row with none, hangs from the root.
  A parent loop is cut at the root.
- AC6: The root card SHALL be labelled with the open session's role, falling
  back to "Orchestrator"; worker cards SHALL show their role.
- AC7: A finished worker SHALL stay drawn as a card while any descendant is
  live; history lines SHALL name the dispatcher when it is not the root.
- AC8: When the pane is short, a card SHALL be evicted only after all its
  children, so the drawn tree stays connected.

## Out of scope

- Moving reviewer dispatch from the worker prompt into the harness (CodeDeck
  starting the reviewer when a general finishes). The lineage edge written
  here is what that later change will fill from the daemon side.
- The web console canvas.
