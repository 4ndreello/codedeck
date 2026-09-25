# Agents pane: working directory on worker cards

## Goal

Every worker card in the codedeck agents pane (`plugin/mods/agents/`) shows
the directory that worker runs in, so the human can `cd` into it without
running `codedeck show`. A worker started with `--worktree` shows its
worktree path; any other worker shows its `cwd`.

## Ground

- `codedeck ps --all --json` already returns `cwd` on every row, and
  `worktree` plus `branch` on rows created with `--worktree`. Verified
  2026-09-25 against the installed CLI: a worktree row carried
  `worktree: /home/andreello/.run-agent/worktrees/e81a265e/9a1f`.
- `SessionRow` (`plugin/mods/agents/types.ts`) does not declare either field
  and `toPaneRow` drops them, so the data reaches the hook and is discarded.
- The hooks realm has no `process` global (docs/mods.md), so `HOME` cannot be
  read inside `pane.ts`. Home shortening is done by pattern instead.
- No daemon or CLI change is needed.

## Acceptance criteria

Selection (`selectPane` / `toPaneRow`):

- AC1. WHEN a session row carries a non-empty string `worktree` THEN the pane
  row SHALL carry that value as `path`.
- AC2. WHEN a session row has no non-empty string `worktree` and carries a
  non-empty string `cwd` THEN the pane row SHALL carry the `cwd` as `path`.
- AC3. IF a session row has neither a non-empty string `worktree` nor a
  non-empty string `cwd` THEN the pane row `path` SHALL be undefined.

Home shortening (`displayPath`):

- AC4. WHEN a path starts with `/home/<user>` followed by `/` or the end of
  the string THEN that prefix SHALL be drawn as `~`.
- AC5. WHEN a path starts with `/Users/<user>` followed by `/` or the end of
  the string THEN that prefix SHALL be drawn as `~`.
- AC6. A path with any other prefix (for example `/tmp/x`, `/homework/x`)
  SHALL be drawn unchanged.

Card content:

- AC7. WHEN a carded worker row has a `path` THEN its card SHALL draw one
  extra body line, after the detail line, holding the shortened path indented
  like the other body lines.
- AC8. IF a carded worker row has no `path` THEN its card SHALL draw the
  same three body lines it draws today.
- AC9. WHEN the shortened path is wider than the space left on the path line
  THEN it SHALL be clipped from the start with a leading `…`, keeping the end
  of the path (the session id) visible.
- AC10. A start clip SHALL never leave a lone low surrogate as the first code
  unit after the `…`.
- AC11. Control characters in a path SHALL be drawn as spaces, the same
  sanitising every other cell gets.
- AC12. The orchestrator card and the history preview lines SHALL be
  unchanged.

Layout:

- AC13. Every pane line SHALL stay exactly `columns` code units wide with the
  path line present, at every width the existing width tests cover.
- AC14. WHEN a height limit is given THEN the output SHALL never exceed it
  with path lines present, and eviction SHALL keep its existing order
  (history first, then cards oldest first).

## Decisions (made with the human, 2026-09-25)

1. Show the path, not the branch. The path is what the human pastes into `cd`.
2. Always show a line: worktree when there is one, `cwd` otherwise.
3. Clip from the start, because the tail (`…/<hash>/<id>`) is the part that
   identifies the worker.
4. `types.ts` is documented as a frozen interface. Adding `worktree` / `cwd`
   to `SessionRow` and `path` to `PaneRow` is a deliberate exception, because
   the new card line cannot be drawn without them. The header comment is
   updated to say so.

## Out of scope

- Daemon, store, CLI and `codedeck web` changes.
- The orchestrator card's own directory.
- Showing the branch, a clickable path, or opening the directory.
- Worktree cleanup (`removeWorktree` is never called; tracked separately).
