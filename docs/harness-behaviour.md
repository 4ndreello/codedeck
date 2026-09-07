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

`plugin/agents/auditor.md` used to tell the auditor to prefer native subagents
over separate CodeDeck workers, because they share this session's context
while a worker reads everything again from nothing. Both halves were wrong,
and the cost gap that was supposed to back them is not measurable from what
the two harnesses recorded. Here is what the attempt actually produced.

One review task, dispatched two ways at the same time. Identical prompt: read
`visibleWidth`, `charWidth` and `truncate` in `src/cli/ui.ts`, report every
correctness defect with the `file:line` actually opened, edit nothing, run no
test suite, close with what was not covered.

| | Native subagent | CodeDeck worker |
| --- | --- | --- |
| Mechanism | `Agent`, general-purpose | `run --no-worktree --bg`, session `32e2` |
| Model | `claude-sonnet-5` | `claude-sonnet-4-6` |
| Input | 12 | 58 |
| Cache written | 51,147 | 46,610 |
| Cache read | 224,057 | 189,912 |
| Output | 115 | 18,296 |
| Wall clock | 189 s | 329 s |
| API calls | 6 | 7 turns |
| Reported cost | none | $0.61 |
| Findings | none | 3 |

**No cost comparison survives this.** The worker's column is one itemized
record from the CodeDeck store and it adds up: 254,876 tokens for $0.6112. The
subagent's column does not. Its completion notification reports 57,512
`subagent_tokens`; summing every `usage` object in its own output file gives
464,514; collapsing the pairs that repeat verbatim gives the 275,331 tabulated
above, whose 115 output tokens cannot be right for the report it actually
wrote. Three numbers, no way to tell which is comparable to 254,876. Anyone
who needs that ratio has to measure it again with both arms instrumented the
same way.

What the columns do carry, because they are structural rather than summed:

**Neither arm shared this session's context.** The subagent's first call was
35,334 tokens of cache creation against zero cache reads. It started from
nothing, which is what a general-purpose `Agent` does: only `subagent_type:
"fork"` inherits the parent conversation. The auditor prompt's "they share
this session's context" was wrong about the subagent type it would dispatch.

**The worker is not cold either.** 189,912 of its 236,580 prompt tokens were
cache reads, 80%. Its first request already read 35,333 from cache, the shared
static head. What it pays for is a large prompt that is mostly cached, not a
re-read from scratch, so the auditor prompt's "from nothing" was wrong too. It
was wrong about both arms in opposite directions.

**The arm that returned nothing was the subagent.** It reported no defect. It noticed
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
from the table, 16%, and the other 84% belong exactly where they are. So the
worker returned a real gap wrapped in an over-broad claim, and the subagent
returned nothing to check. One sample, on two different models, and with no
usable cost figure on one side, so it says which arm found the defect here and
nothing about which arm to reach for next time.

Anyone writing that fix should take the counted rows and not the range: the 11
squared latin ones (🆎 through 🆚) are the easiest to hit by accident and sit
in a block that is otherwise 149 Ambiguous and 40 Neutral.

Checked with `unicodedata.east_asian_width`, skipping code points whose
category is `Cn`, since an unassigned one reports `N` and would otherwise read
as a narrow character that exists.

## A live session's name can only be typed

Measured against `claude 2.1.263` on 2026-09-07, by reading the shipped
binary's strings, since none of this is documented and all of it is load
bearing for `codedeck open`.

There are four ways a session name could reach Claude Code, and three of them
are closed:

1. **`-n/--name`** writes the session's *custom title*. That is the field the
   `/resume` picker and the Claude app list, and it is fixed at launch — before
   any prompt exists, which is the whole problem.
2. **Claude Code's own Haiku title.** It does derive a title from the first
   user message and push it to the Remote Control bridge
   (`generateSessionTitle` → `saveAiGeneratedTitle` → `adoptLocalAiTitle`), but
   the gate is:

   ```js
   let {disabled, sessionTitle, aiSessionTitle, agentTitle} = titles.getSnapshot();
   if (!disabled && !sessionTitle && !aiSessionTitle && !agentTitle && !_haikuTitleAttempted) { … }
   ```

   where `sessionTitle` is the custom title and `agentTitle` is
   `scope.mainThreadAgentDefinition?.agentType`. CodeDeck trips both: `-n` sets
   the first, `--agent` sets the second. Dropping `-n` alone does not help —
   `--agent` closes it on its own, and a session with neither falls back to the
   Remote Control auto-name (`<host>-<adjective>-<colour>`).
3. **The `rename_session` control request** exists — *"Sets the user-facing
   title for the current session"* — and is reachable only from an SDK stdin
   (`--input-format stream-json`) or a Remote Control bridge with a device
   signature. Everything else is dropped with
   `[bridge:attestation] DROPPING unverified control_request`. A hook has
   neither channel.
4. **The transcript record.** The title is persisted as
   `{"type":"custom-title","customTitle":…,"sessionId":…}` in the session
   `.jsonl`, and there is code that reads it back — but inside
   `restoreSessionMetadata`/`reAppendSessionMetadata`, which runs on re-stamp
   (start, resume, compaction). It is not a watcher, so appending that line
   from outside does not rename a running session.

What is left is `/rename`, a TUI command with no CLI equivalent (`claude
agents|attach|logs|stop|rm|respawn|project` — none of them rename). So
`codedeck open` owns the pty and types it, which is what `src/open/pty.ts`
exists for.

### A slash command typed during a turn still runs as a command

The keystrokes land at `UserPromptSubmit`, while the turn Claude Code just
started is still running, so they are queued rather than executed. They are
not turned into a prompt: each queued item carries its mode
(`ve.mode === "prompt"`, `"bash"`, …), and the drain path,
`executeQueuedInput`, is handed the command registry and special-cases a value
that `.trim().startsWith("/")`. The rename therefore executes when the turn
ends.

`scripts/rename-gate.sh` is the end-to-end check for exactly this half: it
submits a first prompt to a real session and then greps the transcript for the
matching `custom-title`.

### `script(1)` hands over a pty with no size

`script` only dimensions its pty when its own stdin is a terminal. CodeDeck
feeds it a pipe, because that pipe is the injection channel, and the pty then
comes up `0 0`:

```console
$ : | script -qec "stty size" /dev/null
0 0
```

`stty` run *inside* the pty fixes it, and that is what `plugin/pty-shim.mjs`
is for — Node has no ioctl, so the size can only be set by a binary that does
the call. Writing it on the slave also raises SIGWINCH on the foreground
group, so the TUI redraws without knowing the shim is there.
