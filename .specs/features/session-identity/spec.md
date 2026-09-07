# Session identity and Remote Control

## Goal

Give CodeDeck sessions useful task names, let a running worker correct its own
name, and make interactive Claude sessions start with Remote Control enabled by
default.

## Acceptance criteria

### Block A: task names and self-rename

- `codedeck run <prompt>` stores a short slug made from the raw prompt when
  `--name` is absent. A supplied `--name` is stored verbatim.
- The existing worktree slug rules are shared by session auto-naming and
  worktree branch naming.
- The daemon accepts `session.rename` with `{ id, name }`, updates the stored
  session, and returns a success response. `codedeck rename <id> <name>` sends
  that request.
- Detached workers receive their CodeDeck session id in
  `CODEDECK_SESSION_ID`.
- Every role prompt tells a worker to rename its session after the task is clear
  with `codedeck rename "$CODEDECK_SESSION_ID" <short-task-slug>`.

### Block B: interactive Claude Remote Control

- Config supports optional `remoteControl`, defaulting to `true` when unset.
- Interactive `codedeck open` adds `--remote-control` by default and omits it
  when config disables the feature.
- Background `codedeck run` does not receive Remote Control arguments.
- The launcher documents that Remote Control requires a subscribed Claude
  account and a prior workspace-trust dialog.

## Out of scope

- Enabling Remote Control for detached or headless harness invocations.
- Changing Claude detached argument construction or adding Remote Control to
  `codedeck run`.
- Renaming native Claude sessions, changing session ids, or adding a rename
  history.
- Adding self-rename instructions to `plugin/ultra.md`.
