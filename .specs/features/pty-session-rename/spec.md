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
- A chunk consisting only of terminal replies (DCS, OSC, CSI replies with a
  `?` or `>` prefix) SHALL NOT mark the box dirty and SHALL NOT guard the next
  Enter.
- IF an unrecognised escape sequence (for example an arrow key) arrives, THEN
  the next Enter SHALL NOT count as a submit, because arrow navigation plus
  Enter accepts an autocomplete suggestion without submitting.
- IF an unknown control byte (below `0x20`, other than backspace, tab, LF, and
  CR) arrives, THEN the next Enter SHALL NOT count as a submit. This is
  conservative: a control may drive a suggestion menu, and the cost of a wrong
  guess is a rename that lands one prompt later.
- Terminal focus reports (`ESC[I`, `ESC[O`) SHALL NOT mark the input box dirty
  and SHALL NOT guard the next Enter, whether they arrive as a whole chunk,
  inside a longer chunk, or split across chunks after the `ESC[` prefix.
- WHEN a chunk carries a focus report followed by SGR mouse reports (as a
  terminal with focus-follows-mouse sends when the pointer enters the window),
  THEN the gate state SHALL be the same as before the chunk.
- WHEN a name is held, a focus-in plus mouse motion chunk arrives, the user
  types a line and submits it, THEN the wrapper SHALL type the rename after
  QUIET_MS of quiet.
- The kitty keyboard encoding of Esc (`ESC[27u`) SHALL keep guarding the next
  Enter, because a double Esc opens Claude Code's rewind menu, where Enter
  selects a message instead of submitting.
- An SGR mouse report (`ESC[<` followed by three digit fields separated by
  semicolons and terminated by `M` or `m`) SHALL NOT mark the input box dirty.
- An SGR mouse report SHALL NOT guard the next Enter.
- WHEN an SGR mouse report shares a chunk with typed text, THEN the typed text
  SHALL still mark the box dirty (the report alone is neutral, and the rest of
  the chunk is processed as before).
- WHEN an SGR mouse report is split across two chunks, THEN it SHALL still be
  neutral.
- IF a sequence starts with `ESC[<` but breaks the SGR mouse grammar, THEN it
  SHALL be handled like any other unrecognised escape (dirty and guard).
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

### Block D: the trace

- WHERE `CODEDECK_PTY_DEBUG` is set to a non-empty absolute path in the environment `codedeck open` runs under, the wrapper SHALL append one JSON object per line (NDJSON) to that file.
- WHEN the gate observes a stdin chunk, THEN the trace SHALL record `kind: "input"`, the chunk as lowercase hex, whether it was ignored as a focus report or terminal reply (`ignored: "focus" | "reply" | null`), and the gate state after it (`dirty`, `guard`, `pending`, `used`).
- WHEN a name is offered to the gate, THEN the trace SHALL record `kind: "offer"` with the gate state.
- WHEN the gate types the rename, THEN the trace SHALL record `kind: "inject"`.
- WHEN a quiet timer fires and the gate declines to inject, THEN the trace SHALL record `kind: "hold"` with the reason (`dirty`, `used`, `no-pending`, or `disposed`).
- WHEN the sidecar watcher delivers a name, THEN the trace SHALL record `kind: "sidecar"` with the name.
- Every trace line SHALL carry `t`, milliseconds since the pty session started.
- The trace file SHALL be created with mode 0600, because it holds every keystroke the user types.
- WHERE `CODEDECK_PTY_DEBUG` is unset or empty, no file SHALL be created and the gate SHALL behave exactly as today.
- IF writing the trace fails, THEN the session SHALL continue unaffected (a trace never costs the session).

## Out of scope

- `codedeck run` and any other non-interactive launch: there is no TUI to type
  into, and those sessions already carry the prompt's slug.
- Renaming the CodeDeck session record, which `codedeck rename` already does.
- Typing anything other than the rename. The contract has room for it; nothing
  else has been probed.
