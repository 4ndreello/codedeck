# Harness behaviour

Things CodeDeck depends on that no harness documents. Each one was measured,
not read off a page, and each is re-runnable. Measurements below are against
`claude 2.1.258` on 2026-09-05.

This file exists because the role frontmatter in `plugin/agents/` lists tools
that never arrive, and until now the only explanation lived in a merged pull
request body.

## `--agent` layers on top, it does not replace

Passing `--agent codedeck:reviewer` does not swap Claude's system prompt for
the agent file. It appends.

Both a bare `claude -p` and the same call with `--agent codedeck:reviewer`
report the identical first sentence of their system prompt:

```
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

Only the second one can quote its own agent body back.

Consequence: there is no "no role" mode that buys a cleaner prompt. `general`
is passed `--agent codedeck:general` like every other role, because opting out
of `--agent` removes the role contract and changes nothing else.

## An agent file with no `tools:` key inherits the whole toolset

Omitting `tools:` is not "no tools". It is "everything the parent session
has", including `Agent`, `Bash`, `Edit` and `Write`.

`plugin/agents/general.md` deliberately carries no `tools:` key, and a test
pins that.

## Granting `Bash` silently drops `Grep` and `Glob`

Four probe agents, identical bodies, differing only in frontmatter. Each was
asked to list the exact names of every tool it can call.

| Probe | `tools:` frontmatter | What it actually got |
| --- | --- | --- |
| A | `Read, Grep, Glob` | `Read`, `Grep`, `Glob` |
| B | `Read, Grep, Glob, Bash` | `Read`, `Bash` |
| C | `Grep, Glob, Bash, Read` | `Bash`, `Read` |
| D | *(no key)* | `Agent`, `Bash`, `Edit`, `ListAgents`, `Read`, `ReportFindings`, `ScheduleWakeup`, `ShareOnboardingGuide`, `Skill`, `ToolSearch`, `Workflow`, `Write` |

B and C ask for the same four tools in a different order and lose the same
two, so the drop is not a parse order artifact. D asked for nothing and still
came back without `Grep` and `Glob`, which is the same rule reaching the
inherited case: `Bash` is present, so they are gone.

Consequences for the roles that ship today:

- `reviewer` and `auditor` list `Grep` in their frontmatter and never receive
  it. Their real search path is `rg` through `Bash`.
- `orchestrator`'s prose does not say it runs without `Grep`. Anything written
  for these roles should assume shell search, not the tool.
- Asking for `Grep` costs nothing and is not an error, so the frontmatter is
  left as written intent. This table is the correction.

`Task` in frontmatter resolves to the tool named `Agent`, which is why the
roles allowed to dispatch list `Task` and the probe above reports `Agent`.

### Reproducing the allowlist probe

The probe is four agent files under one throwaway plugin directory, each body
being the single line `List the exact names of every tool you can call, one
per line, nothing else.`

```
claude -p "List the exact names of every tool you can call, one per line, nothing else." \
  --plugin-dir <dir> --agent <plugin>:<agent> --model claude-haiku-4-5-20251001
```

## What a fan-out slice costs

`plugin/agents/auditor.md` tells the auditor to prefer native subagents over
separate CodeDeck workers, on the grounds that a worker reads everything again
from nothing. Half of that was wrong, so here is the measurement.

One review task, dispatched two ways at the same time. Identical prompt: read
`visibleWidth`, `charWidth` and `truncate` in `src/cli/ui.ts`, report every
correctness defect with the `file:line` actually opened, edit nothing, run no
test suite, close with what was not covered.

| | Native subagent | CodeDeck worker |
| --- | --- | --- |
| Mechanism | `Agent`, general-purpose | `run --no-worktree --bg`, session `32e2` |
| Model | `claude-sonnet-5` | `claude-sonnet-4-6` |
| Tokens | 57,512 | 208,266 (58 in, 189,912 cached, 18,296 out) |
| Wall clock | 189 s | 329 s |
| Reported cost | not broken out | $0.61 |
| Findings | none | 3 |

The worker used 3.6x the tokens and 1.7x the wall clock. The models differ, so
this measures the pair, not the mechanism on its own.

Two things it settles:

**A separate worker is not cold.** 189,912 of its 208,266 tokens were cache
reads, 91%. What it pays for is a large prompt that is mostly cached, not a
re-read from scratch. The auditor prompt's "from nothing" was wrong.

**The cheaper arm found less.** The subagent reported no defect. It noticed
that the `WIDE` table omits the pictograph block around U+2600-U+2BFF and
declined to call it a defect, since the comment above the table disclaims
completeness. The worker made the analogous call the other way and reported
the gap at U+1F000-U+1F2FF as its top finding.

That finding needs narrowing before it becomes a fix: it claims the whole
block renders at two columns, and it does not. Counting only assigned code
points against Unicode 16.0 East Asian Width:

| Range | Assigned | Wide |
| --- | --- | --- |
| U+1F200-U+1F2FF, squared CJK | 64 | 64 |
| U+1F000-U+1F02F, mahjong | 44 | 1, only U+1F004 |
| U+1F0A0-U+1F0F5, playing cards | 82 | 1, only U+1F0CF |

So one third of what the finding names is genuinely missing from the table
and the rest is not. The arm that cost 3.6x returned a real gap wrapped in an
over-broad claim, and the cheap arm returned nothing to check. One sample, and
the split is worth knowing before spending on either.

Checked with `unicodedata.east_asian_width`, skipping code points whose
category is `Cn`, since an unassigned one reports `N` and would otherwise read
as a narrow character that exists.
