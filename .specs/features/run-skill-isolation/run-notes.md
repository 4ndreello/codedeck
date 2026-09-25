# Run notes: run-skill-isolation

Append-only. One entry per decision or blocker.

- 2026-09-24 23:05 | decision: suppress host skills on the `run` path only; `open` keeps the human's skills and plugins | bucket 1 | open is interactive with the human, run is headless dispatch.
- 2026-09-24 23:05 | decision: deliver CodeDeck skills by absolute path in the run prompt, not by installing into `~/.codex/skills` or the target repo | bucket 1 | codex `skills.config` cannot add a skill from an arbitrary path (probe A: 0), a `CODEX_HOME` swap still loads `~/.agents/skills`, and writing into `<cwd>/.agents/skills` would pollute the worker's diff.
- 2026-09-24 23:05 | decision: leave the target repo's project skills enabled on codex | bucket 1 | they belong to the repo being worked on, same standing as its AGENTS.md.
- 2026-09-24 23:05 | decision: no config knob to re-allow a host skill | bucket 1 | nobody asked for one; easy to add later.
- 2026-09-24 23:10 | decision: slice by ownership into W1 drivers (e138) and W2 run prompt (169d), both `general` in fresh worktrees from 8407a75 | bucket 1 | disjoint files, parallel.
- 2026-09-24 23:53 | blocker: e138 and 169d went silent at 23:15 (4s CPU in 42 min, no log events) after the laptop slept | stopped both and resumed the same threads with `codedeck send`, so the partial work survived.
- 2026-09-25 00:14 | blocker: resumed codex turns ran with a restricted sandbox (`.git` read-only EROFS, daemon socket EPERM), so neither worker could commit or dispatch its reviewer | integrated both slices myself by copying the owned files onto the branch and re-running their tests and gates outside the sandbox.
- 2026-09-25 00:14 | observation: both resumed sessions ended `failed` (`UNKNOWN`, blame harness) although the log shows `turn.completed`; 169d's failure detail is a codex stderr ERROR line for a rejected `rm -rf` tool call | recorded as a separate CodeDeck bug, not fixed in this run.
- 2026-09-25 00:26 | decision: act on all six reviewer findings in one remediation slice (64c8) | bucket 1 | all reversible code, test, and doc edits.
- 2026-09-25 00:36 | decision: `/autonomous` invoked; the orchestrator writes these notes directly because it runs as an edit-capable harness | bucket 1.
- 2026-09-25 00:39 | decision: accept 64c8 (commit b6e5c6a, cherry-picked as 4ad0b94) after reading the diff and re-running its tests outside the sandbox | bucket 1.
- 2026-09-25 00:39 | decision: update `tests/run-role.test.ts` ("sends the prompt untouched without the flag") myself to pin RSI-12 | bucket 1 | the old assertion pinned the behaviour RSI-12 deliberately changes; the session name still comes from the raw prompt (its own test passes).
- 2026-09-25 00:41 | observation: my first end-to-end count regex skipped namespaced skills (`plugin:skill`); corrected count is 148 entries without flags, 0 with the built driver's args.
- 2026-09-25 00:42 | decision: one review of the correction round (eb91), per the delivery loop | bucket 1.
- 2026-09-25 00:44 | decision: leave eb91's two parser notes (`>2` / `> # c` block headers, multi-line single-quoted descriptions) unfixed | bucket 1 | notes, not should-fix; the only shipped skill parses correctly; recorded under Not covered.
- 2026-09-25 00:44 | deferred: push the branch and open a PR | bucket 2 | publishing commits needs the human.
