# Open Role Tool Denylist Specification

## Problem Statement

`codedeck open` hands Claude every role except `general` as an agent with a
`tools:` allowlist. Claude enforces that list literally: any tool not named is
absent from the session. That removes every MCP tool, `Skill`, `ToolSearch`
and the deferred tools (`DesignSync`, ...), none of which a role ever meant to
forbid. The orchestrators already depend on one of them:
`plugin/prompts/_partials/spec-gates.md:3` tells them to activate a skill by
name, and they have no `Skill` tool.

Seen on 2026-11-03 in an `open` session running `codedeck:orchestrator-edit`:
the user's `claude_design` MCP tools were missing, and the agent blamed it on
the server being added after the session started. The tools showed up only
after Claude printed "agent 'codedeck:orchestrator-edit' ... is no longer
available ... Continuing with the default tools", that is, once the allowlist
stopped applying.

Measured on this machine (`claude 2.1.312`, `--model haiku`). The first table
asked the model to list its own tools, which is approximate (counts drift by a
few between runs). The second reads `.tools` from the `init` event of
`--output-format stream-json --verbose`, which is authoritative.

| `--agent` | frontmatter | tools (model-listed) | MCP tools | `Skill` |
|---|---|---|---|---|
| none | n/a | 63 | all (`claude_design`, Claude Docs) | yes |
| `codedeck:general` | no `tools:` key | 63 | all | yes |
| `codedeck:orchestrator-edit` | `tools: Read, Grep, Glob, Edit, Write, Bash` | 4 (`Read`, `Edit`, `Write`, `Bash`) | none | no |
| probe | `tools: Read, Edit, Write, Bash, Skill, ToolSearch, mcp__claude_design` | 6 + 23 MCP | only `claude_design` | yes |
| probe | `tools: Read, Edit, Write, Bash, Skill, ToolSearch, mcp__*` | 5 | none (wildcard not honored) | yes |

| `--agent` (init event) | tools | difference from no agent |
|---|---|---|
| none | 59 | n/a |
| probe `disallowedTools: Agent, NotebookEdit` | 57 | exactly `NotebookEdit` and `Task` |
| same, with `--dangerously-skip-permissions` (`permissionMode: bypassPermissions`) | 57 | same two |

Facts the design rests on:

- The allowlist cannot be fixed by adding names: MCP servers are the user's
  and change over time, and `mcp__*` is not honored in `tools:`.
- `disallowedTools:` keeps everything the session has and removes only what
  the role names, and it holds under bypass, which `open` turns on by default
  (`src/open/launchers/claude.ts:181`).
- `Agent` in `disallowedTools` removes the tool the `init` event names `Task`.
- `claude plugin validate --strict` on the probe plugin raised only
  manifest-level findings (README, LICENSE, icon, description, author). Whether
  it checks agent keys at all is unknown.
- Moving off the allowlist grants a restricted role every tool the session has
  that the denylist does not name. On 2.1.312 that is: `Workflow`,
  `EnterWorktree`, `ExitWorktree`, `RemoteTrigger`, `SendMessage`,
  `ListAgents`, `Monitor`, `CronCreate`, `CronDelete`, `CronList`,
  `ScheduleWakeup`, `PublishPlugin`, `PushNotification`, `TaskStop`, `LSP`,
  `WebFetch`, `WebSearch`, `Skill`, `ToolSearch`, `DesignSync`,
  `ReportFindings`, `ShareOnboardingGuide`, and every `mcp__` tool. RTD-03 denies the ones a role's prose forbids.

## Goals

- [ ] An `open` session on any role sees the user's MCP tools, `Skill`,
      `ToolSearch` and deferred tools, except what RTD-03 denies that role
- [ ] Each role still loses every tool its contract forbids, including tools
      the allowlist used to hide by accident (`Workflow`, `EnterWorktree`, ...)
- [ ] A mistyped or missing restriction key fails the build instead of
      shipping an unrestricted agent
- [ ] Docs stop describing the roles as an allowlist

## Out of Scope

| Item | Reason |
|---|---|
| `codedeck run` | `run --role` strips frontmatter and sends prose, so neither key reaches the harness. Its `--disable-slash-commands` skill suppression is deliberate (`run-skill-isolation`) |
| opencode `open` permissions | built from `OrchestratorMode` in `src/open/launchers/opencode.ts`, not from this frontmatter; not measured for MCP loss |
| the agent disappearing mid-session (the warning above) | separate cause, not measured. Suspected trigger: `/design-login` or `/design-sync` reloading plugins and dropping the `--plugin-dir` plugin |
| denying `Bash`-based edits (`sed -i`, `>`) | not enforceable by frontmatter today either; stays prose |
| denying MCP tools per role | servers are the user's; names cannot be known at build time, and `mcp__*` in `disallowedTools` is not measured |
| implementing `scout`/`consultant` | owned by `scout-consultant-roles`; this feature only amends its SC-11 (RTD-14) |

## Assumptions & Open Questions

| Decision | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| Denylist key | `disallowedTools`, comma-separated, same shape as `tools:` | measured on 2.1.312, holds under bypass | Yes (probe) |
| Native `Agent` and `Workflow` for orchestrators | denied on all three variants | today's allowlists already exclude `Task`; opencode denies `task` in every mode (`opencode.ts:37-44`); a native subagent bypasses CodeDeck session tracking | Reviewer agrees |
| `Agent` and `Workflow` for reviewer | denied | `reviewer.md:28` "No subagents ... nothing that spawns"; pinned by `plugin-manifest.test.ts:260-261` | Reviewer agrees |
| `Agent` for auditor | allowed (auditor lists `Task` today); `Workflow` denied | auditor dispatches slices through `codedeck run --role`, a workflow bypasses that | No |
| `EnterWorktree`/`ExitWorktree` | denied on every restricted role | conflicts with "No `git`" (`orchestrator.md:18`), "never edit ... the repository" (`reviewer.md:10`), "Never use `--worktree` for an audit slice" (`auditor.md:20`) | Reviewer agrees |
| `RemoteTrigger` | denied on every restricted role | assumed to start remote agents outside CodeDeck tracking; behaviour not probed | No |
| `WebFetch`/`WebSearch`/`LSP` for the dispatch orchestrator | denied, with `Read`/`Grep`/`Glob` | "you do not investigate it yourself" (`orchestrator.md:45`), it reads only worker artifacts (`orchestrator.md:50`) | Reviewer agrees |
| MCP tools that write or delete outside the repo (`claude_design__delete_files`, Docs `delete`) | allowed on every role, recorded as an accepted widening | they are the user's integrations; under bypass they run without a prompt, and role prose governs their use | Reviewer agrees |
| A new tool Claude ships later | allowed by default; the manual gate run after a claude upgrade shows the diff | the cost of a denylist; an allowlist is what caused this bug | Reviewer agrees |

## Requirements

### Role frontmatter

- **RTD-01**: Every role in `plugin/prompts/roles/` except `general` SHALL declare its restriction with `disallowedTools:` and SHALL NOT declare `tools:`.
- **RTD-02**: `general.md` SHALL declare neither `tools:` nor `disallowedTools:`.
- **RTD-03**: The denied set per role SHALL be:

  | role file | `disallowedTools` |
  |---|---|
  | `orchestrator.md` (dispatch) | `Read, Edit, Write, NotebookEdit, Grep, Glob, LSP, WebFetch, WebSearch, Agent, Workflow, EnterWorktree, ExitWorktree, RemoteTrigger` |
  | `orchestrator-read.md` | `Edit, Write, NotebookEdit, Agent, Workflow, EnterWorktree, ExitWorktree, RemoteTrigger` |
  | `orchestrator-edit.md` | `Agent, Workflow, EnterWorktree, ExitWorktree, RemoteTrigger` |
  | `reviewer.md` | `Edit, Write, NotebookEdit, Agent, Workflow, EnterWorktree, ExitWorktree, RemoteTrigger` |
  | `auditor.md` | `Edit, Write, NotebookEdit, Workflow, EnterWorktree, ExitWorktree, RemoteTrigger` |

### Plugin build

- **RTD-04**: WHEN `scripts/copy-plugin.mjs` reads a role manifest with `disallowedTools:` THEN `dist/plugin/agents/<role>.md` (the copy `open` loads, `src/core/roles.ts:11-21`) and `plugin/agents/<role>.md` SHALL carry `disallowedTools: <same value>`.
- **RTD-05**: IF a role manifest declares `tools:` THEN the build SHALL fail with an error naming the file, and IF it repeats a key THEN the build SHALL fail naming the file and the key.
- **RTD-06**: IF a role manifest frontmatter has a key outside `name`, `description`, `disallowedTools`, `includes`, or a non-blank line that is neither a key nor an `includes` item, THEN the build SHALL fail with an error naming the file and the line. (Today `parseManifest` drops unknown keys silently, so `disallowed-tools:` would ship an unrestricted agent.)
- **RTD-07**: IF a role manifest other than `general.md` lacks `disallowedTools:` THEN the build SHALL fail with an error naming the file.

### Run and non-claude open invariant

- **RTD-08**: WHEN `roleBody` (`src/core/roles.ts`, used by `composeRunPrompt`) or `resolveRoleBody` (`src/open/contract.ts`) strips role frontmatter THEN a `disallowedTools:` line SHALL NOT reach the prompt, the same as `tools:` today.

### Prose

- **RTD-09**: Each tool `orchestrator.md` says the role lacks ("You have no Read, Edit, Write, Grep, or Glob", line 19) SHALL appear in that role's `disallowedTools`.

### Docs

- **RTD-10**: `docs/harness-behaviour.md` SHALL gain a section stating that a `tools:` allowlist drops MCP, `Skill`, `ToolSearch` and deferred tools, that `mcp__*` is not honored, and that roles use `disallowedTools:`. It SHALL include the `init`-event measurement, the claude version, the full tool list a restricted role gains, and the accepted MCP widening under bypass.
- **RTD-11**: `docs/harness-behaviour.md` SHALL drop or rewrite the claims that no longer hold: lines 7-9 ("frontmatter ... lists tools that never arrive"), the `Grep`/`Glob` consequences list (lines 80-89, including "the roles allowed to dispatch list `Task`").
- **RTD-12**: `README.md` (lines 144, 153, 155, 157) SHALL describe the restriction as a denylist. The bypass claim on line 153 SHALL cite the `init`-event measurement.
- **RTD-13**: `CLAUDE.md` (lines 52 and 61) SHALL describe the restriction as a denylist.

### Related spec

- **RTD-14**: `.specs/features/scout-consultant-roles/spec.md` SC-11 (line 94) and its description at line 48 SHALL be amended to require `disallowedTools:` with the reviewer's denied set from RTD-03.

## Acceptance (manual gate)

With `npm run build` done, capture the baseline and each role's toolset from
the `init` event:

```
tools() { claude -p hi --model haiku --plugin-dir dist/plugin --output-format stream-json --verbose "$@" < /dev/null \
  | jq -r 'select(.type=="system" and .subtype=="init") | .tools[]' | sort; }
tools > /tmp/base
tools --agent codedeck:<role> > /tmp/<role>
```

For each of `orchestrator`, `orchestrator-read`, `orchestrator-edit`,
`reviewer`, `auditor`, it passes when `/tmp/<role>` equals `/tmp/base` minus
the role's RTD-03 names, reading `Agent` as `Task`, and contains `Skill`,
`ToolSearch` and every `mcp__` line of the baseline. Run it again after every
claude upgrade to see which new tools restricted roles inherit.

## Coverage matrix

| Layer | Test type | Where | Command |
|---|---|---|---|
| role manifests + generated agents (RTD-01..04, RTD-09) | unit | `tests/plugin-manifest.test.ts` (rewrite `:252-264` to assert denied names; rewrite `:266-273` to "a role whose `disallowedTools` lacks `Agent` contains `codedeck run --role`", which today goes vacuous once `tools:` is gone) | `npx vitest run tests/plugin-manifest.test.ts` |
| exact denied set per role | unit | `tests/prompt-layers.test.ts:211-220` (allowlist pin becomes denylist pin; its parser at `:35` must accept the new key) | `npx vitest run tests/prompt-layers.test.ts` |
| generated orchestrator agents | snapshot | `tests/__snapshots__/orchestrator-agents.test.ts.snap` (lines 9, 130, 229 pin `tools:`) | `npx vitest run tests/orchestrator-agents.test.ts -u`, then review the snapshot diff |
| build rejects bad manifests (RTD-05..07) | unit (tmp manifest) | `tests/prompt-layers.test.ts` (already imports `scripts/copy-plugin.mjs`) | `npx vitest run tests/prompt-layers.test.ts` |
| frontmatter stripped from prompts (RTD-08) | unit | `tests/roles.test.ts`, `tests/open-contract.test.ts` | `npx vitest run tests/roles.test.ts tests/open-contract.test.ts` |
| prose pins | unit | `tests/orchestrator-prose.test.ts` | `npx vitest run tests/orchestrator-prose.test.ts` |
| real claude toolset | manual gate | none shipped | Acceptance above |
