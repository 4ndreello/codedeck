# ps fit to screen

## Goal

Make interactive `ps` output fit on one terminal screen and keep the newest
session at the bottom, where the shell prompt will appear after the command.
Piped and redirected output must keep its current order and pagination-free
behavior so scripts do not change.

## Acceptance criteria

1. On an interactive terminal, `ps` reads the terminal height from
   `process.stdout.rows`. It computes `maxRows` as `max(1, rows - reserved)`.
   The reserved lines are the header, divider, optional overflow note, and one
   margin line for the shell prompt. The default view displays only the newest
   `maxRows` fetched sessions.
2. Interactive table output is bottom-anchored. If an overflow note exists it
   comes first, followed by the header, divider, and displayed sessions ordered
   oldest to newest. The newest displayed session is the last printed row.
3. When stdout is not a TTY, table output keeps the current newest-first order,
   does not use terminal height, and keeps the existing 100-row fetch cap and
   24-hour window.
4. `--json` keeps a newest-first array, does not reverse rows, and does not use
   terminal height.
5. `ps --all` on a TTY displays every fetched row, up to the existing 100-row
   cap, in reverse order so the newest row is last. It does not print an
   overflow note.
6. `--limit N` caps displayed output to the newest N fetched sessions. On a TTY
   the selected rows are still reversed. An explicit limit takes precedence
   over the height limit and cannot display more than the existing 100-row
   fetch cap. A non-positive, fractional, or non-numeric N produces a clear
   error and a non-zero exit.
7. The overflow count is `(fetchedCount - displayedCount) + hiddenOlderCount`,
   where `hiddenOlderCount` is the existing count of sessions hidden by the
   daemon's 24-hour window. The note appears only when that count is positive
   and `--all` is not set. Its wording keeps the existing form and ends with
   the configured CLI name and `ps --all`.
8. If `process.stdout.rows` is undefined or zero, interactive `ps` does not
   height-truncate. It still reverses table rows. If the terminal is smaller
   than the reserved space, it displays at least one row.

## Out of scope

Pager integration, increasing the daemon's 100-row fetch cap, changes to the
daemon or session store unless the client cannot satisfy the behavior without
them, and changes to `show` or `wait` rendering are out of scope. Shared UI
helpers may be read but must not be changed.

## Verification plan

Add pure helpers in `src/cli/commands/ps.ts` and unit tests in `tests/ps.test.ts`
for fit-to-screen counts, bottom anchoring, non-TTY ordering, `--all`,
`--limit`, overflow math, the one-row floor, and missing terminal height.
Confirm the test script in `package.json`, then run only
`npx vitest run tests/ps.test.ts`.

After the focused tests pass, use scratch copies to probe behavior-level
mutations that remove reversal, introduce an off-by-one height error, reverse
non-TTY output, or omit `hiddenOlderCount` from overflow math. Each mutation
must be killed by the focused tests. Discard the scratch copies afterward.
