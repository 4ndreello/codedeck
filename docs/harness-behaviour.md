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

## An agent file with no `tools:` key is not restricted

Omitting `tools:` is not "no tools". The agent keeps `Bash`, `Edit`, `Write`
and `Agent`, every one of which a `tools:` list would have to name explicitly.
That is what `plugin/agents/general.md` relies on, and a test pins the absent
key.

The size of the inherited set is a property of the session, not of this rule.
The probe below (D) returned 12 tools on two identical runs; the same session
with no `--agent` at all listed 45, the extra being deferred tools and MCP
tools. Read D as "not restricted", never as a roster.

## Granting `Bash` silently drops `Grep` and `Glob`

Probe agents with identical bodies, differing only in frontmatter. Each was
asked to list the exact names of every tool it can call.

| Probe | `tools:` frontmatter | What it actually got |
| --- | --- | --- |
| A | `Read, Grep, Glob` | `Read`, `Grep`, `Glob` |
| B | `Read, Grep, Glob, Bash` | `Read`, `Bash` |
| C | `Grep, Glob, Bash, Read` | `Bash`, `Read` |
| E | `Read, Grep, Glob, Bash, WebFetch, WebSearch` | `Read`, `Bash`, `WebFetch`, `WebSearch` |
| F | E minus `Bash`, nothing else changed | `Read`, `WebFetch`, `WebSearch`, `Grep`, `Glob` |
| D | *(no key)* | 12 tools, `Bash` among them, no `Grep` or `Glob` |

E is the frontmatter `plugin/agents/reviewer.md` actually ships. F removes one
word from it and the two tools come back, which is the controlled contrast: the
only variable is `Bash`. B and C ask for the same four in a different order and
lose the same two, so it is not a parse order artifact either.

D is weaker evidence than it looks and is kept here only for completeness. A
bare `claude -p` in this session, with no `--agent`, also lists no `Grep` and
no `Glob`, so D inherited an already `Grep`-less set. It shows inheritance. F
is what shows the rule.

Why it happens is not measured here. `Bash` can run `rg` and `find`, so
subsuming them is a plausible reason and nothing above establishes it. What is
established is the effect.

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

The probe is a set of agent files under one throwaway plugin directory, each
body being the single line `List the exact names of every tool you can call,
one per line, nothing else.`

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

The worker used 3.6x the tokens and 1.7x the wall clock.

Three things to hold on to before quoting either number. The models differ, so
this measures the pair, not the mechanism on its own. The worker's total is
itemized and the subagent's is not, so if `subagent_tokens` excludes cache
reads while 208,266 includes 189,912 of them, the 3.6x is not like for like,
and nothing in the harness output settles that. And there is no cost ratio
here at all: only one arm reported a price.

Two things it does settle:

**A separate worker is not cold.** 189,912 of its 208,266 total tokens were
cache reads, 91%, and as a share of input alone it is 99.97%. What it pays for
is a large prompt that is mostly cached, not a re-read from scratch. The
auditor prompt's "from nothing" was wrong.

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
| U+1F000-U+1F02F, mahjong | 44 | 1, only U+1F004 |
| U+1F030-U+1F09F, domino | 100 | 0 |
| U+1F0A0-U+1F0FF, playing cards | 82 | 1, only U+1F0CF |
| U+1F100-U+1F1FF, enclosed alphanumeric | 200 | 11, U+1F18E and U+1F191-U+1F19A |
| U+1F200-U+1F2FF, squared CJK | 64 | 64 |
| **whole range** | **490** | **77** |

So 77 of the 490 assigned code points the finding names are genuinely missing
from the table, 16%, and the other 84% belong exactly where they are. The arm
that cost 3.6x returned a real gap wrapped in an over-broad claim, and the
cheap arm returned nothing to check. One sample, and the split is worth
knowing before spending on either.

Anyone writing that fix should take the counted rows and not the range: the 11
squared latin ones (🆎 through 🆚) are the easiest to hit by accident and sit
in a block that is otherwise 149 Ambiguous and 40 Neutral.

Checked with `unicodedata.east_asian_width`, skipping code points whose
category is `Cn`, since an unassigned one reports `N` and would otherwise read
as a narrow character that exists.
