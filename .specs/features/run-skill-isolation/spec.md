# Run Skill Isolation Specification

## Problem Statement

A `codedeck run` worker inherits every skill and plugin the human installed for
interactive use. On 2026-09-24 a `general` worker on codex (`gpt-6-luna`)
loaded `superpowers:brainstorming`, which told it to ask for approval of a
visual direction before implementing. It asked, ended the turn, and the
session came back `completed` with an empty diff, because nobody answers a
background run. The same task on claude did not fail only because
`superpowers` happens to be disabled in `~/.claude/settings.json` and enabled
in `~/.codex/config.toml`.

Measured on this machine (codex-cli 0.156.1, `codex debug prompt-input`):

| codex flags | skills in the model prompt | superpowers |
|---|---|---|
| none (current run path) | 122 | 15 |
| `--disable plugins` | 40 | 0 |
| `--disable plugins` + `skills.config` disabling one path | 39 | 0 |
| `--disable plugins` + host override for 64 paths | 0 host skills | 0 |

Measured on claude (headless init frame, `--model claude-haiku-4-5-20251001`):
`skills=80` with no flag, `skills=0` with `--disable-slash-commands`, run
still ends `success`.

Also measured: CodeDeck delivers none of its own skills to run workers. The
`tlc-spec-driven` a codex worker sees comes from a hand-made copy in
`~/.claude/skills/tlc-spec-driven`, which already differs from
`plugin/skills/tlc-spec-driven` (`SKILL.md` and five scripts differ).

Codex facts the design rests on (probed, not documented):

- `skills.config=[{path=...,enabled=false}]` disables a skill by `SKILL.md`
  path. `enabled=true` on an arbitrary path does NOT add a skill.
- Host skill roots: `$CODEX_HOME/skills` (default `~/.codex/skills`, includes
  `.system/`), `~/.agents/skills`. Skills are found recursively, through
  symlinks (e.g. `synced/<id>/pdf/SKILL.md`,
  `playwright-skill/node_modules/.../trace/SKILL.md`).
- Changing `CODEX_HOME` does not hide `~/.agents/skills` or system skills.
- Project roots `<cwd>/.agents/skills` and `<cwd>/.codex/skills` load too.
- `codex exec resume` accepts `-c`, `--enable`, `--disable`.

## Goals

- [ ] A run worker sees no skill or plugin skill from the human's personal
      install, on codex and on claude
- [ ] A run worker sees the skills CodeDeck ships, from CodeDeck's own copy,
      on every harness
- [ ] A run worker is told it runs headless and must not end a turn waiting
      for approval

## Out of Scope

| Item | Reason |
|---|---|
| `codedeck open` (any harness) | interactive session with the human; their skills and plugins are wanted there |
| opencode, omp, antigravity host-skill suppression | not measured yet; they get the prompt-level parts (RSI-07..RSI-10) only |
| project skills in the target repo (`<cwd>/.agents/skills`, `<cwd>/.codex/skills`, `<cwd>/.claude/skills`) | owned by the target repo; codex leaves them enabled. Claude's run flag also hides `.claude/skills`, as noted below |
| moving `skills/create-report` into `plugin/skills` so it ships | separate packaging decision; the orchestrator prompt already has a fallback when the skill is absent |
| a config knob to re-allow specific host skills | no request for it yet |

### Known divergence

Claude's `--disable-slash-commands` also hides skills in the target repo's
`.claude/skills`, while codex continues to load project skills. The Claude flag
suppresses every skill source; codex's `--disable plugins` plus host-path
overrides leaves project skills available.

## Requirements

### Codex run path

- **RSI-01**: WHEN the codex driver builds args for a new run THEN it SHALL include `--disable plugins`.
- **RSI-02**: WHEN the codex driver builds args for a resume turn THEN it SHALL include `--disable plugins`.
- **RSI-03**: WHEN the codex driver builds args THEN it SHALL add one `-c skills.config=[...]` override that sets `enabled=false` for every `SKILL.md` discovered under the host roots `$CODEX_HOME/skills` (default `~/.codex/skills`) and `~/.agents/skills`.
- **RSI-04**: Host skill discovery SHALL walk each root recursively, follow symlinks, and visit each real directory at most once, so a symlink cycle terminates.
- **RSI-05**: IF a host root does not exist or cannot be read THEN discovery SHALL skip it and still build the args.
- **RSI-06**: WHEN no host `SKILL.md` is discovered THEN the args SHALL contain no `skills.config` override.
- **RSI-06b**: Arg building SHALL stay a pure function of its inputs; discovery runs in the driver and is passed in.

### Claude run path

- **RSI-11**: WHEN the claude driver builds args for a run or a resume turn THEN it SHALL include `--disable-slash-commands`.
- **RSI-12**: WHEN `codedeck run` starts without `--role` THEN it SHALL include the headless run section and CodeDeck skill catalog before the task prompt, without reading `ultra.md`.
- **RSI-13**: WHEN the codex driver encodes a host skill path for `skills.config` THEN it SHALL encode DEL (0x7F) as `\u007f` so the override is valid TOML.

### Run prompt (all harnesses)

- **RSI-07**: WHEN `composeRunPrompt` builds a worker prompt THEN it SHALL include a run section, placed after the role body and before the task, stating that the worker runs non-interactively, that nobody answers approval or direction questions, and that it must make the call, record the assumption, and deliver instead of ending the turn to ask.
- **RSI-08**: WHEN `<pluginDir>/skills/*/SKILL.md` files exist THEN the run section SHALL list each one with its frontmatter `name`, its frontmatter `description`, and the absolute path of its `SKILL.md`, and tell the worker to read that file when the prompt asks for the skill by name.
- **RSI-09**: IF `<pluginDir>/skills` is missing or holds no `SKILL.md` THEN the run section SHALL omit the skills list.
- **RSI-10**: The open path SHALL stay unchanged: nothing in `src/open/` calls the new run section, and `buildCodexOpenArgs` gains no `--disable plugins`.

## Coverage matrix

| Layer | Test type | Where | Command |
|---|---|---|---|
| codex arg builder + host discovery | unit (tmp dirs, symlinks) | `tests/driver-args.test.ts`, `tests/codex-host-skills.test.ts` | `npx vitest run tests/driver-args.test.ts tests/codex-host-skills.test.ts` |
| claude arg builder | unit | `tests/driver-args.test.ts` | same as above |
| run prompt composition | unit (tmp plugin dir) | `tests/roles.test.ts`, `tests/prompt-layers.test.ts` | `npx vitest run tests/roles.test.ts tests/prompt-layers.test.ts` |
| real codex discovery vs real codex | manual gate | none shipped | `codex debug --disable plugins -c '<generated override>' prompt-input hi`: count of host-root skill entries is 0 |
| open path | none (invariant, covered by existing open tests) | `tests/open-*` touching codex args | `npx vitest run tests/open-codex` if such a file exists |
