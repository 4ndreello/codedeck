# Sessions that name themselves from the first prompt

## Goal

An interactive session opened by CodeDeck should carry the name of the task it
is doing, everywhere the harness shows a session name — the `/resume` picker
and the Claude app included — instead of the launch-time `CodeDeck · <project>
· <role>` that every session on a repo shares.

## Why a pty

Measured against Claude Code 2.1.263:

- `-n/--name` writes the session's custom title, which is what the app lists.
  It is fixed at launch, before any prompt exists.
- Claude Code does derive a title from the first prompt with Haiku, and pushes
  it to the Remote Control bridge, but only when
  `!disabled && !sessionTitle && !aiSessionTitle && !agentTitle`. CodeDeck
  blocks it twice over: `-n` sets the session title and `--agent` sets the
  agent title.
- `rename_session` exists as a control request, and is reachable only from an
  SDK stdin (`--input-format stream-json`) or a device-signed Remote Control
  bridge. A hook has neither.
- The title is persisted in the transcript as `{"type":"custom-title", ...}`,
  but the reader runs on re-stamp (start, resume, compaction) rather than
  watching the file, so an external append does not rename a live session.

`/rename` typed into the TUI is the only path left, which means the wrapper has
to own the terminal.

## Acceptance criteria

### Block A: the pty

- `codedeck open` runs the harness under a pty it owns, with `script(1)` as the
  allocator and no native dependency added to the package.
- The harness sees a tty, the terminal's real size, and every keystroke,
  Ctrl+C included, with the fidelity of a direct launch. Its exit status
  reaches `open` unchanged.
- A resize of the terminal reaches the harness while the session runs.
- The pty is dropped, and the session opens exactly as before, when: the config
  or `--no-pty` says so, the platform is Windows, `script(1)` is absent, the
  process is not attached to a terminal, the launch is non-interactive, the
  shim is missing, or the harness declares no command worth typing.

### Block B: the injection

- What may be typed is declared per harness in one table, one entry per
  harness, so adding a harness does not touch the launcher.
- Claude Code declares `/rename`. The other three declare nothing until their
  command is probed the way `/rename` was, and therefore get no pty.
- The name comes from `plugin/hooks/session-name.sh`, which already writes the
  first prompt's slug next to the session file. The wrapper types it once.
- A name is sanitised before it is typed: control characters become spaces and
  the length is capped, so nothing in a prompt can submit a second line or
  move the cursor.
- WHEN a name arrives and no key has been typed since the last submit (or
  since the session started) and no key has arrived for QUIET_MS, THEN the
  wrapper SHALL type the rename at once.
- IF a key other than a submit was typed since the last submit, THEN the
  wrapper SHALL hold the name and SHALL NOT type it.
- WHEN a held name exists and the user submits (Enter) and then no key arrives
  for QUIET_MS, THEN the wrapper SHALL type the rename once.
- IF the user types again within QUIET_MS after a submit, THEN the held name
  SHALL stay held until the next submit plus QUIET_MS of quiet.
- A `\r` inside a bracketed paste (between `ESC[200~` and `ESC[201~`) SHALL
  NOT count as a submit. A `\r` immediately preceded by `\` (Claude Code's
  line continuation) or `ESC` (Alt/Option+Enter) SHALL NOT count as a submit.
- WHEN Enter (`\r`) arrives while the current token (characters typed since
  the last space, tab, newline, or submit) starts with `@`, THEN the gate SHALL
  keep the box dirty and SHALL NOT release a held rename. The gate SHALL clear
  the tracked token so a following Enter can submit the remaining prompt.
- IF a tab arrives while the current token starts with `@`, THEN the gate SHALL
  retain the mention guard because Tab may accept an autocomplete suggestion.
- IF a backspace arrives after a token separator, or an unrecognised editing
  control or escape sequence arrives, THEN the gate SHALL hold the next Enter
  conservatively because the edit may have changed text before the cursor.
- WHEN a backspace (`0x7f` or `0x08`) arrives, THEN the gate SHALL remove the
  last character from the current token, so `@x` followed by two backspaces
  and then `ok` + Enter counts as a submit.
- WHEN Enter arrives and the current token does not start with `@`, THEN
  existing submit rules SHALL apply unchanged (paste, `\` continuation,
  ESC/Alt+Enter).
- Terminal focus reports (`ESC[I`, `ESC[O`, sent as whole chunks) SHALL NOT
  mark the box dirty.
- The rename SHALL be typed at most once per session, and a held name SHALL be
  dropped when the session is disposed (no timer fires after dispose).

`QUIET_MS` is 300.

### Block C: the evidence

- `scripts/pty-gate.sh`, which the test job runs on every supported Node
  version, drives the real `open` path against a stand-in harness and asserts
  the tty, the size, that the pty path was taken rather than the fallback, that
  the rename was typed, and that keys typed after it still arrive. No
  credential, no network.
- `scripts/rename-gate.sh` drives a real Claude Code session, submits a first
  prompt and asserts the transcript carries the matching `custom-title` — the
  half only Claude Code can answer, which is that a queued `/rename` executes
  as a command rather than reaching the model as a prompt.

## Out of scope

- `codedeck run` and any other non-interactive launch: there is no TUI to type
  into, and those sessions already carry the prompt's slug.
- Renaming the CodeDeck session record, which `codedeck rename` already does.
- Typing anything other than the rename. The contract has room for it; nothing
  else has been probed.
