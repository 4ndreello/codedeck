# Orchestrator agents band

## Goal

Draw the orchestrator's own workers as an ASCII panel above the prompt, inside
the Claude Code session that dispatched them. What `codedeck web --open` shows
in a browser for every run, scoped to this run alone, in the terminal, for
free.

The orchestrator dispatches workers and then goes blind: it has to call
`codedeck ps` and read a 100-row table to learn what its own four workers are
doing. The band closes that loop without leaving the prompt and without
spending a token.

## Verified ground

Every fact below was confirmed by running the thing, not by reading docs.

### The run link already exists

- `codedeck open` sets `CODEDECK_RUN_ID` in the session environment. Confirmed
  live: `CODEDECK_RUN_ID=f5fd` in the orchestrator session that wrote this spec.
- Every dispatched worker carries `runId` equal to the orchestrator's session
  id. Confirmed from `codedeck run --bg --json` output: workers `c774`, `1f57`,
  `2109`, `1c23` all returned `"runId":"f5fd"`.
- `codedeck ps --all --json` returns a flat array; each row carries `id`,
  `runId`, `origin`, `name`, `agent`, `model`, `status`, `repository`, `cwd`,
  `createdAt`, `updatedAt`.
- Filtering that array on `runId === CODEDECK_RUN_ID` returned exactly the 9
  sessions of this run: 8 workers plus the orchestrator itself, which is the
  only row with `origin === "open"`.
- `plugin/statusline.sh` already uses this exact scoping (`CODEDECK_RUN_ID` plus
  `codedeck usage <runId> --json`) to print the `N agents` field. The band is
  the same idea with rows instead of a count.

### The engine can do this

Extracted from the compiled `claude` binary (2.1.273) and, where marked,
confirmed in a live PTY session:

- `$.process.run(argv, init?)` is a real capability, both arguments positional. Default timeout 30000ms,
  output capped at 4MB, child spawned under cgroup class `plugin`, stdout and
  stderr captured. This is the data transport: no web server has to be running.
- A hooks module can draw directly in `ui.render` with the table
  `$.ui.resolve(e, ...)` returns: `Box, Text, Button, Input, Select, Link, Code,
  Client, Raster, Svg`. **Confirmed live**: a `Box` holding a `Text` and a
  `Button` drew above the prompt and the button rendered as `[ twenty48 ]`.
- `ui.render` must return exactly one tree element. Engine check, verbatim:
  `check: (e) => ne(e) && typeof e.type === "string" ? void 0 : "something that
  is not a tree element"`. An array is rejected and the whole drawing is dropped.
- `ui.render` fires per component. Known names: `AbovePrompt`, `Pane`,
  `UserMessage`, `ToolUse`, `ToolResult`. Drawing for all of them paints the
  panel over every message row.
- A `Button` must carry `onPress`; the engine names the spelling itself:
  `<Button key label onPress>`.
- Intrinsic tag names are capitalized and there are two: `const INTRINSIC =
  { Box: 'Box', Text: 'Text' }`.
- `$.command.register` takes `{ name, description, argumentHint?, immediate? }`
  and rejects a missing description.

### The trap this design walks around

A `Client` surface module is the engine's mechanism for keyboard and pointer
interactivity, and it owns its own state through `surface.setState`. In the
arcade port that state never persisted: after 16 keypresses the board still
drew 2 tiles and score 0, with tile positions changing between frames, which is
a fresh `initialTwenty48State()` on every render. The engine's own guard text
points at the cause: *"set its state again after each of N renders, nothing
heard between; set state on a pointer or key event, a tick, a press or new
props, and let a render settle"*, and the board seeds its state by calling
`surface.setState` during render. That bug is unsolved.

**The band therefore mounts no Client.** It is a read-only drawing produced by
the hooks module, whose state is ordinary closure state in `register.tsx`, which
is proven to work. The one interactive affordance this spec allows is a
`Button`, whose `onPress` is a hooks-module closure and which is proven to work.

## Acceptance criteria

### Drawing

- AC1: WHEN a terminal session starts with function hooks enabled and
  `CODEDECK_RUN_ID` set in its environment, THEN the mod SHALL draw a band above
  the prompt listing the sessions whose `runId` equals that value.
- AC2: The band SHALL exclude the row whose `origin` is `open`, which is the
  orchestrator's own session.
- AC3: WHERE `CODEDECK_RUN_ID` is absent from the environment, the mod SHALL
  draw nothing and SHALL return `next(e)` unchanged.
- AC4: WHEN the run has zero worker rows, THEN the mod SHALL draw nothing rather
  than an empty frame.
- AC5: The mod SHALL draw only when `e.component` is `AbovePrompt` and
  `e.surface` is `terminal`, and SHALL return `next(e)` unchanged for every
  other event.
- AC6: The `ui.render` handler SHALL return exactly one tree element, never an
  array.
- AC7: The mod SHALL NOT mount a `Client` surface module.

### Rows

- AC8: Each worker row SHALL carry the session id, the status, the harness, and
  the slice name.
- AC9: A row SHALL occupy exactly one terminal line, with the slice name
  truncated rather than wrapped.
- AC10: Rows SHALL be ordered by `updatedAt`, most recent first.
- AC11: WHEN the run holds more worker rows than the row budget, THEN the band
  SHALL draw the first rows up to the budget and SHALL end with a line stating
  how many rows were left out.
- AC12: The band SHALL never exceed its row budget in drawn lines, header and
  overflow line included.

### Refresh

- AC13: WHEN a turn completes, THEN the mod SHALL start a data refresh.
- AC13a: WHEN a tool call completes, THEN the mod SHALL start a data refresh,
  subject to the throttle in AC16a.
- AC16a: The mod SHALL NOT start a refresh within the throttle interval of the
  previous refresh returning. A `turn.complete` refresh SHALL ignore the
  throttle, since a finished turn is the moment the band is read.
- AC14: WHEN a refresh returns data that differs from the drawn snapshot, THEN
  the mod SHALL call `$.ui.invalidate("ui.render")` exactly once for that
  refresh.
- AC15: WHILE a refresh is in flight, the band SHALL keep drawing the last good
  snapshot.
- AC16: The mod SHALL NOT start a refresh while one is already in flight.

### Faults

- AC17: IF the data command exits non-zero, times out, or returns output that
  does not parse as an array, THEN the mod SHALL keep the last good snapshot and
  SHALL NOT throw.
- AC18: IF no refresh has ever succeeded, THEN the mod SHALL draw nothing.
- AC19: IF a row is missing a field the band draws, THEN that field SHALL render
  as a placeholder and the row SHALL still draw.

### Cost and isolation

- AC20: The mod SHALL add nothing to the model's prompt and SHALL consume zero
  model tokens.
- AC21: The mod SHALL read session metadata only. It SHALL NOT read worker
  transcripts, diffs, or prompts.

## Decisions, settled

1. **The arcade does not ship.** Decided by the human, option B. The 93 line
   plumbing stays (the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` default, the
   `modules` declaration, the CI pin to 2.1.270, the version bump, the docs
   page). The 783 line game goes: `plugin/mods/arcade/`,
   `plugin/hooks/boards/`, `tests/mods-arcade/`. The game is removed because it
   does not work, not because the plumbing is wrong, and it stays recoverable
   from the branch history.
2. **Always on**, whenever the run has worker rows, with `/agents` toggling it
   off and on. Assumed from the recommendation, cheap to reverse.
3. **Row budget: 8**, then the overflow line. Assumed, cheap to reverse.
4. **Columns: `id  status  agent  name`.** Deliberately not model, cwd, or
   token counts: the statusline already carries those. Assumed, cheap to
   reverse.
5. **Refresh on `turn.complete` and on `tool.call`, throttled, no timer.**
   This overrides the earlier `turn.complete` only recommendation. The band's
   whole value is watching workers *while* the orchestrator works, and
   `turn.complete` fires only after that window closes, so the band would be
   stale exactly when it matters. `tool.call` fires throughout a working turn
   and needs no timer, which keeps the subprocess count tied to real activity
   instead of to the clock. The throttle in AC16a bounds the cost.
6. **Monochrome ASCII** for the first cut. Colour is additive and can follow
   once the band earns its place.

## Out of scope

- Any interactive control of workers from the band: no stop, no send, no
  resume. Read-only.
- Worker output, diffs, logs, or transcripts in the band.
- Any run other than the current one.
- Desktop, mobile, and headless rendering. Terminal only, by engine constraint.
- Replacing or changing `codedeck web`, `codedeck ps`, or the statusline.
- Fixing the `Client` surface state bug. The band avoids Clients entirely;
  the bug stays open and unowned by this work.
- Any dependency install, fetch, or vendoring.

## Verification

Scoped runs only. Never the full suite.

- `npm run build`
- `npx vitest run tests/mods-agents`
- `claude plugin validate plugin/.claude-plugin/plugin.json`
- `claude plugin validate .`
- The PTY probe, which is the only check that proves drawing. It reproduced
  every arcade defect and is known to discriminate:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 timeout 40 \
  script -qec "claude --plugin-dir <repo>/dist/plugin" /dev/null > probe.txt 2>&1
sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' probe.txt | tr -d '\r' > probe-clean.txt
grep -c "hook skipped\|is not an element" probe-clean.txt   # must be 0
```

A PASS needs the error count at zero AND the band's own text present in the
capture. Zero errors alone is not a pass: a hook that draws nothing also scores
zero errors.

## Stop conditions

- Never invent an engine API. Every `$` call and every element prop used must
  trace to a contract quoted in this spec or extracted from the binary the same
  way.
- If the band cannot be drawn without a `Client`, stop and report. Do not mount
  one: its state path is a known open bug.
- If `$.process.run` is refused at runtime, stop and report the exact message.
  Do not fall back to requiring `codedeck web`.
