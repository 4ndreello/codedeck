# Agents pane: live elapsed timer

## Goal

Every worker card in the codedeck agents pane (`/band`, `plugin/mods/agents/`)
shows how long that worker has been running, and the number counts up on
screen once per second while the worker is live, the way Claude Code shows the
elapsed time of a running turn.

Today the detail line reads `Working · 3m`, and that `3m` is the age of the
last update (`updatedAt`), not the run time, and it only moves when a
`tool.call` or `turn.complete` happens to refresh the pane.

## Ground

- `codedeck ps --all --json` already returns `createdAt` (ISO string) on every
  row. Verified 2026-09-25 against the installed CLI. No daemon or CLI change
  is needed.
- `formatPane` already reads `Date.now()` at draw time, so a redraw alone
  advances a clock computed from `createdAt`. A tick does not need a
  subprocess.
- Unknown and load bearing: whether a hooks module can schedule work on a
  clock (`setInterval` / `setTimeout` in the module realm, or an engine timer
  API). The realm has no `process` global (docs/mods.md), so timers are not a
  safe assumption. Resolved by the probe in T1 before any code is written.

## Acceptance criteria

Elapsed text format (`elapsed(ms)`):

- AC1. WHEN the elapsed time is under 60 seconds THEN the text SHALL be whole
  seconds with an `s` suffix, e.g. `0s`, `42s`.
- AC2. WHEN the elapsed time is at least 60 seconds and under 1 hour THEN the
  text SHALL be `<m>m <ss>s` with seconds zero padded, e.g. `3m 07s`.
- AC3. WHEN the elapsed time is at least 1 hour THEN the text SHALL be
  `<h>h <mm>m <ss>s` with minutes and seconds zero padded, e.g. `1h 02m 07s`.
- AC4. IF the elapsed time is negative (clock skew) THEN the text SHALL be
  `0s`.
- AC5. IF the start timestamp is missing or unparseable THEN the card SHALL
  draw no elapsed text, and the rest of the card SHALL draw unchanged.

Card content:

- AC6. WHILE a worker is live (`working`, `starting`, `needs_input`) its card
  detail line SHALL show `elapsed(now - createdAt)` in place of the
  last-update age.
- AC7. WHEN a worker kept as a card is finished (any other status) THEN its
  detail line SHALL show the frozen duration `elapsed(updatedAt - createdAt)`.
- AC8. The history preview lines SHALL keep their current last-update age
  text. Unchanged behavior.
- AC9. `selectPane` SHALL carry `createdAt` from the session row onto the pane
  row, and a non-string `createdAt` SHALL become undefined.
- AC10. Every pane line SHALL stay exactly `columns` code units wide with the
  timer present, at every width the existing width tests cover.

Tick:

- AC11. WHILE the pane is open and the snapshot holds at least one live row,
  the module SHALL invalidate `ui.render` once per second.
- AC12. WHEN the pane closes or the snapshot holds no live row THEN the tick
  SHALL stop, and no timer SHALL stay scheduled.
- AC13. A tick SHALL NOT spawn `codedeck ps`. Data refresh during a tick is
  capped: at most one `refresh` per 5 seconds while ticking, so a worker that
  finishes while the orchestrator is idle stops counting within 5 seconds.
- AC14. Starting the tick twice SHALL NOT schedule two timers.
- AC15. A throw inside a tick SHALL be caught; it SHALL NOT escape the module.

## Decisions (made by the orchestrator, cheap to reverse)

1. Format with zero padding (`3m 07s`) so the text width stays stable while it
   counts, which keeps the card from jittering once a second.
2. The timer replaces the last-update age on cards only. History keeps age.
3. The 5 second refresh while ticking overrides decision 5 of
   `orchestrator-agents-band/spec.md` ("no timer") for the ticking window
   only. Reason: a live timer on a stale status counts past the worker's end,
   which is a wrong number on screen.
4. The button above the prompt is unchanged.

## Out of scope

- Daemon, store, CLI and `codedeck web` changes.
- Timers in the statusline or the button label.
- Per-turn timing, token counts, or any new card field besides elapsed time.
- Fixing the native `✕` close desync documented in docs/mods.md.
