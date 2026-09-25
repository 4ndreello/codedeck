# Tasks: agents pane live timer

Source of truth: `spec.md` in this folder.

## Coverage matrix

| Layer | Test type | Lives in | Command |
|---|---|---|---|
| `plugin/mods/agents/pane.ts` (elapsed, cards, select) | unit | `tests/mods-agents/pane.test.ts` | `npx vitest run tests/mods-agents` |
| `plugin/mods/agents/types.ts` | none (types only) | n/a | `npx tsc --noEmit -p .` if it covers plugin, else the vitest run |
| `plugin/hooks/pane-ticker.ts` (tick scheduler) | unit, fake timers | `tests/mods-agents/pane-ticker.test.ts` | `npx vitest run tests/mods-agents` |
| `plugin/hooks/register.tsx` | none, wiring only | n/a | live PTY probe (T3) |
| manifest | contract | n/a | `claude plugin validate plugin/` |

`register.tsx` stays wiring only. Any decision (when to tick, when to stop,
refresh cadence) lives in `pane-ticker.ts` where it is unit tested.

## T1. Probe: can a hooks module run a clock

- Status: complete

- Requirement: spec "Ground", unknown item. Blocks T2 tick work.
- In a live PTY session (tmux + `claude --plugin-dir <built plugin>` with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`), check whether `setInterval` /
  `setTimeout` exist and fire inside the hooks module realm, and whether a
  timer callback may call `$.ui.invalidate("ui.render")` with a `$` captured
  from an earlier hook.
- Tests: none, finding only. Record the result in `docs/mods.md`.
- Gate: a capture showing a value that changed across ticks with no input.

## T2. Pure layer: elapsed + cards + ticker

- Status: complete

- Requirement: AC1 to AC15.
- Tests: in this task, same files as the matrix.
- Gate: `npx vitest run tests/mods-agents` green.

## T3. Wiring + live proof

- Status: complete

- Requirement: AC6, AC11, AC12.
- Gate: two tmux captures of the open pane at least 2 seconds apart, the
  elapsed text of a live card advanced between them, no `hook skipped` text.
