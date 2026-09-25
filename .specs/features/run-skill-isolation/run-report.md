# Run report: run-skill-isolation

Goal: `codedeck run` workers stop loading the human's personal skills and plugins, receive CodeDeck's own skills from CodeDeck's copy, and are told they run headless. Trigger: on 2026-09-24 a codex `general` worker (gpt-6-luna) loaded `superpowers:brainstorming`, asked for approval of a visual direction, ended its turn, and came back `completed` with an empty diff. `superpowers` was enabled in `~/.codex/config.toml` and disabled in `~/.claude/settings.json`, which is why the claude worker on the same task did not fail.

## Done

- Branch: [worktree-cosmic-churning-noodle](https://github.com/4ndreello/codedeck/tree/worktree-cosmic-churning-noodle) (local only, not pushed, so the link does not resolve yet)
- Last code commit: [b2114d8fee79ac3471abaf6ff4d7ca163bb8cb95](https://github.com/4ndreello/codedeck/commit/b2114d8fee79ac3471abaf6ff4d7ca163bb8cb95). The commit that adds this report and the run notes follows it on the same branch.
- Base: `65b1c1b` (main). Diff `65b1c1b..b2114d8`: 13 files, +620 / -24.

Commits:

| commit | what it does | produced by |
|---|---|---|
| 8407a75 | spec `.specs/features/run-skill-isolation/spec.md` (RSI-01..RSI-11, coverage matrix) | orchestrator |
| 6094aa7 | codex run and resume add `--disable plugins` plus one `-c skills.config=[{path=...,enabled=false},...]` from a recursive SKILL.md scan of `$CODEX_HOME/skills` and `~/.agents/skills` (`src/drivers/codex/host-skills.ts`); claude run and resume add `--disable-slash-commands` | worker e138, integrated by the orchestrator |
| 1ce8ea3 | `composeRunPrompt` adds a run section between the role body and the task: headless notice plus a catalog of `<pluginDir>/skills/*/SKILL.md` (name, description, absolute path) (`src/core/run-skills.ts`) | worker 169d, integrated by the orchestrator |
| 4ad0b94 | review fixes: no-role runs get the run section (RSI-12), DEL escaped in the TOML override (RSI-13), `CODEX_HOME=""` fallback, YAML block scalars and quoted values with comments, wiring and resume tests, Claude/codex divergence documented in the spec and `docs/harness-behaviour.md` | worker 64c8 (cherry-picked from b6e5c6a) |
| b2114d8 | `tests/run-role.test.ts` pins the RSI-12 shape instead of "prompt untouched" | orchestrator |

Evidence, re-run by the orchestrator on the integrated branch (not taken from worker reports):

- `npx vitest run tests/driver-args.test.ts tests/codex-host-skills.test.ts tests/roles.test.ts tests/prompt-layers.test.ts tests/run-skills.test.ts`: `Tests  109 passed (109)`
- `RUN_AGENT_DIR=/tmp/rsi-open npx vitest run tests/open-contract.test.ts tests/open-codex.test.ts`: `Tests  51 passed (51)`
- `RUN_AGENT_DIR=/tmp/rsi-open npx vitest run tests/run-env.test.ts tests/run-linkage.test.ts tests/run-role.test.ts tests/run-sandbox.test.ts tests/run-settings.test.ts`: `Tests  44 passed (44)` (1 failed before b2114d8: the old "prompt untouched" pin)
- `RUN_AGENT_DIR=/tmp/rsi-open npx vitest run tests/open-args.test.ts tests/open-sandbox.test.ts tests/usage-daemon.test.ts`: `Tests  105 passed (105)`
- `RUN_AGENT_DIR=/tmp/rsi-open npx vitest run tests/session-driver-sandbox.test.ts tests/autocompact.test.ts`: `Tests  27 passed (27)`
- `npx tsc --noEmit -p .`: exit 0. `npm run build`: ok, `dist/plugin/skills/tlc-spec-driven/SKILL.md` exists, generated `plugin/agents/*.md` unchanged.
- Real codex (codex-cli 0.156.1), args taken from the built `dist/drivers/codex/driver.js` `CodexDriver.buildArgs` and fed to `codex debug prompt-input` (renders the model prompt, no model call): 148 skill entries without flags, 0 with the built flags. Host discovery: 67 SKILL.md in 19.3 ms, override 6148 bytes.
- Real claude (haiku, headless init frame): `skills=80` without `--disable-slash-commands`, `skills=0` with it, run still `success`.
- Built no-role and `general` run prompts carry `## Run instructions` and `## CodeDeck skills` pointing at `dist/plugin/skills/tlc-spec-driven/SKILL.md`.

Mutation probes (fault injected in a scratch copy, scoped tests run, file restored and byte-compared):

| fault | run by | result |
|---|---|---|
| drop `--disable plugins` on resume | e138 | killed |
| stop following symlinks in discovery | e138 | killed |
| emit `enabled=true` | e138 | killed |
| drop the `~/.agents/skills` root | orchestrator | killed (`1 failed | 1 passed`) |
| run section after the task | 169d | killed |
| relative skill path | 169d | killed |
| drop the catalog when skills exist | 169d | killed |
| accept a SKILL.md with no `name` | orchestrator | killed (`1 failed | 3 passed`) |
| no-role returns the raw prompt | 64c8 | killed |
| remove the DEL escape | 64c8 | killed |
| revert `||` to `??` for CODEX_HOME | 64c8 | killed |

Survivors: none.

Reviews: 357b (claude/opus, whole scope) found no blocker, 2 should-fix, 4 notes, all remediated in 4ad0b94. eb91 (correction round) found no blocker and no should-fix; it cross-checked the TOML encoding with Python `tomllib`, compared the parser to PyYAML on 78 real SKILL.md files, and measured the claude project-skill divergence with claude 2.1.282.

Worker registry:

| id | role / harness | slice | final status | disposition |
|---|---|---|---|---|
| e138 | general / codex gpt-6-luna | drivers | `failed` (UNKNOWN, harness) after `turn.completed` | accepted, integrated as 6094aa7 |
| 169d | general / codex gpt-6-luna | run prompt | `failed` (UNKNOWN, harness) after the turn finished | accepted, integrated as 1ce8ea3 |
| 357b | reviewer / claude opus | review of the full scope | completed | findings remediated |
| 64c8 | general / codex gpt-6-luna | review fixes | completed | accepted, cherry-picked as 4ad0b94 |
| eb91 | reviewer / claude opus | review of the correction | completed | no action needed |

All five are stopped. `codedeck ps` shows none of them live.

## Assumptions I made

- Suppression applies to `run` only. `open` is interactive with the human and keeps their skills and plugins.
- CodeDeck skills are delivered by absolute path in the run prompt. Measured: codex `skills.config` cannot add a skill from an arbitrary path, a `CODEX_HOME` swap still loads `~/.agents/skills` and system skills, and writing into `<cwd>/.agents/skills` would pollute the worker's diff.
- On codex, the target repo's own project skills stay enabled. They belong to the repo being worked on, the same way its AGENTS.md does. Claude's flag hides them too; that divergence is documented rather than worked around.
- Every harness gets the prompt-level part (headless notice plus catalog). Only codex and claude get host-skill suppression.
- There is no config knob to re-allow a host skill. Nobody asked for one.
- Runs without `--role` also get the run section (RSI-12), since the drivers suppress skills on every run.
- After the laptop slept, the stalled e138 and 169d were stopped and resumed on the same threads instead of re-dispatched, which kept their partial work.
- Both resumed workers ran with a restricted sandbox and could not commit. I integrated their owned files onto the branch and re-ran every gate myself.
- eb91's two parser notes are left unfixed. No shipped skill uses those YAML forms.

## Deferred / waiting for you

- Pushing `worktree-cosmic-churning-noodle` and opening a PR. Publishing commits needs you; nothing has been pushed.
- The running daemon still serves the old `dist/`. The new behaviour reaches real `codedeck run` workers only after this branch is merged, built, and the daemon restarted.

## Blocked / failed

- e138 and 169d went silent at 23:15 for about 38 minutes after the laptop slept: processes alive, 4s of CPU, no log events. Recovered with `codedeck stop` then `codedeck send`.
- Resumed codex turns ran with a restricted sandbox: the shared `.git` was read-only (EROFS) and the daemon socket returned EPERM. So neither worker could commit or dispatch its own reviewer. Cause observed: `buildCodexArgs` passes no `-s` on `exec resume`, and the comment that "a resumed thread keeps its existing sandbox policy" did not hold on codex-cli 0.156.1. This is a separate CodeDeck bug and is not fixed here.
- Both resumed sessions ended `failed` (`UNKNOWN`, blame `harness`) although the log shows `turn.completed`. In 169d the failure detail is a codex stderr `ERROR` line for a rejected `rm -rf` tool call, so a tool-level rejection is being promoted to a session failure. This is a separate CodeDeck bug and is not fixed here.

## Not covered

- opencode, omp, antigravity: no host-skill suppression. Their skill discovery was not measured.
- There is no live end-to-end run through a restarted daemon with a real model turn. The model-visible prompt was proven with `codex debug prompt-input` using the built driver's args, and with claude's init frame.
- `skills/create-report` still does not ship in `plugin/skills`, so run workers no longer see it on codex. The orchestrator prompt already falls back to producing the report directly.
- Frontmatter parser limits noted by eb91: block headers with an indentation indicator or a trailing comment (`description: >2`, `description: > # c`) and multi-line single-quoted descriptions parse wrong. No shipped skill uses them.
- RSI-05's "cannot be read" branch (EACCES root) has no test. Only the missing-root case is tested.
- The codex side of the known divergence (project skills still loading under suppression) rests on the earlier probe C, not on a re-measurement with the final flags.
