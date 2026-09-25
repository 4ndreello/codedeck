# Tasks: agents pane working directory

Source of truth: `spec.md` in this folder.

## Coverage matrix

| Layer | Test type | Lives in | Command |
|---|---|---|---|
| `plugin/mods/agents/pane.ts` (select, displayPath, start clip, card line) | unit | `tests/mods-agents/pane.test.ts` | `npx vitest run tests/mods-agents` |
| `plugin/mods/agents/types.ts` | none (types only) | n/a | covered by the vitest run and `npx tsc --noEmit -p .` if it includes plugin |
| `plugin/hooks/register.tsx` | none, unchanged | n/a | n/a |

## T1. Path on worker cards

- Status: complete
- Requirement: AC1 to AC14.
- Files: `plugin/mods/agents/types.ts`, `plugin/mods/agents/pane.ts`,
  `tests/mods-agents/pane.test.ts`.
- Tests: in this task. One test per AC at minimum; existing tests that pin
  card line counts are updated only where a fixture now carries a path.
- Gate: `npx vitest run tests/mods-agents` green, plus one behavior fault in a
  scratch copy (e.g. clip from the end instead of the start, or prefer `cwd`
  over `worktree`) that the new tests catch, then discarded.
