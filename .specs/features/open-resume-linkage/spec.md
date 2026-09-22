# Open resume linkage

## Goal

Resuming an interactive session with `codedeck open --resume` should revive its
existing CodeDeck row so the launcher keeps the same session and run identity.

## Requirements

- ORL-01: WHEN `session.adopt` receives a non-empty `resume` value and an open
  session matches the same agent and native session id, THEN the daemon SHALL
  reuse that row, keep its id and run id, set its status to `working`, update
  its timestamp, and refresh model, effort, name, and cwd from supplied values.
- ORL-02: WHEN multiple open rows match ORL-01, THEN the daemon SHALL select
  the row with the most recent update timestamp.
- ORL-03: IF the selected matching row has a non-terminal status and its pid is
  alive under the same process identity, THEN the daemon SHALL create a new row
  instead of taking over that live session.
- ORL-04: WHEN `resume` is absent or matches no row, THEN `session.adopt` SHALL
  create a new row with `runId` equal to its new id.
- ORL-05: WHEN the daemon revives a row, THEN it SHALL clear stale process and
  terminal state while keeping the row's worktree, branch, and base commit.
- ORL-06: WHEN `codedeck open` receives `--resume <value>` for any launcher,
  THEN it SHALL pass that value in the `session.adopt` request.
- ORL-07: WHEN a revived row is released, THEN `session.release` SHALL mark it
  terminal.
