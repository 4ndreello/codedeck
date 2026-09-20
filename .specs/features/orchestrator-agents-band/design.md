# Design: orchestrator agents pane

> **Revised.** The first cut drew a table above the prompt. It worked, and it
> was rejected: the ask is the `codedeck web` canvas, as ASCII, docked on the
> right. `AbovePrompt` is gone from the plan. What survives is the pure layer
> and every engine fact below, all of which were paid for.

## Pane contract, verified live

One probe module, one PTY session, dumping the render event:

```
requestId = "wide"                     // which pane is being drawn, NOT e.id
viewport  = { columns: 120, rows: 50 }
props     = { title, isFocused, bodyColumns: 89, placement: "dock", scroll, view }
```

- `$.ui.open({ id })` opens a docked pane. `{ id, width, side: "right" }` is
  also accepted. `id` is 1 to 64 of letters, digits, `_` or `-`.
- `ui.render` then fires with `e.component === "Pane"`, and the module tells
  panes apart by `e.requestId`, which carries the id passed to open.
- **`e.props.bodyColumns` is the usable content width.** The pane reports its
  own size, so the drawing adapts instead of asking. A requested `width` is
  accepted but is not what comes back.
- `e.id` is `undefined` on the render event. Reaching for it is the obvious
  mistake and it fails silently.
- **`e.props.scroll` is `{ offset, bodyRows }`**, and `bodyRows` is the usable
  height: 44 in a 50 row terminal. Anything taller is clipped at the bottom
  with no warning, which eats the footer first. Measured together in one 200
  by 50 terminal: `bodyColumns` 89, `scroll.bodyRows` 44, `viewport`
  `{ columns: 110, rows: 50 }`, so `viewport` is the space left over for the
  rest of the screen, not the terminal and not the pane.
- A requested `width` is not merely different from what comes back, it is
  **ignored**: asking for 46 still returned `bodyColumns: 89`. The engine sizes
  the dock and the module adapts, full stop.
- **`Box` lays its children out in a row.** A list of `Text` lines needs
  `<Box flexDirection="column">` or the drawing is shredded into vertical
  slivers. This cost a day: every validate passed, the module loaded, the hook
  ran, zero errors were raised, and the pane was garbage. The only instrument
  that sees it is a screen capture, which is why T5 exists.
- The pane draws from session start, as soon as one refresh has a snapshot. It
  does not wait for a turn. An early probe concluded the opposite by reading a
  PTY byte stream, where a docked pane's repaints interleave and a grep for the
  header finds nothing even when the pane is perfect. Use `tmux capture-pane`,
  which returns the settled screen.

## Old design below, kept for the pure layer and the failure posture


Source of truth: `spec.md` in this directory. Where the two disagree, the spec
wins and this file is the one that is wrong.

## Shape

Two layers, split so that everything with logic in it is testable without an
engine, and everything that needs an engine has no logic in it.

```
  plugin/mods/agents/           pure, no engine imports, unit tested
    types.ts      the row shape and the snapshot shape
    select.ts     filter to this run, drop the orchestrator, order, budget
    format.ts     one row to one line, truncation, the overflow line
    parse.ts      raw stdout to a snapshot, or a failure

  plugin/hooks/register.tsx     engine only, no logic worth testing
    ui.render     gate, resolve, draw the lines the pure layer produced
    turn.complete start a refresh
    tool.call     start a refresh, throttled
    command.run   /agents toggles visibility
```

The rule that keeps this honest: `register.tsx` may hold state and call the
engine, but it may not decide anything. Every decision, which rows, which
order, what a line says, how a fault is handled, lives in `plugin/mods/agents/`
where a unit test can reach it.

## Why no Client

Proven in a live PTY session: a hooks module drawing `Box`, `Text` and `Button`
straight from `$.ui.resolve(e, ...)` renders correctly above the prompt, and a
`Button` carrying `key`, `label` and `onPress` works.

Also proven, in the same way: a `Client` surface module's state does not
survive across renders in the arcade port, and the engine's guard text blames
setting state during render. That defect is open and unowned.

The band is read-only and needs no keyboard focus, so it needs no Client. This
is not a preference, it is the reason the band can ship while the game cannot.

## Data flow

```
tool.call / turn.complete
        |
        v
  refresh()  --- in flight? --> drop
        |
        v
  $.process.run(["codedeck", "ps", "--all", "--json"])
        |
        v
  parseSnapshot(stdout)  ->  Snapshot | undefined
        |                        |
     failure                  success
        |                        |
  keep last good          differs from drawn?
                                 |
                                yes -> $.ui.invalidate("ui.render")
```

`$.process.run` is a verified engine capability. Full contract, read out of
the engine implementation rather than inferred:

- `$.process.run(argv, init?)`. **Both arguments are positional.** `argv` is a
  string array whose first element is the command. No shell, so no quoting
  question.
- `init` is the optional second argument, `{ cwd?, env?, stdin?, timeoutMs? }`.
  `cwd` resolves against the session cwd, `env` merges over the inherited env,
  `stdin` is piped only when supplied. `timeoutMs` is a whole number, 1 to
  600000.
- default `timeoutMs` 30000, capped by an engine maximum. Each of stdout and
  stderr is captured and truncated at 4194304 characters. The child runs under
  cgroup class `plugin`.
- resolves to `{ exitCode, stdout, stderr }`. `exitCode` falls back to `1` when
  the process closes without one.
- **throws** in two cases, both of which the caller must catch: timeout or
  abort (`$.process.run(codedeck) aborted: still running after 30000ms`) and
  failure to start (`$.process.run(codedeck) failed to start: <reason>`).

Two rules that only a live session revealed, both of which cost a worker:

- Calling it the way the host-side implementation reads, `$.process.run({ argv:
  [...] })`, is **refused**: `process.run: takes argv, a non-empty list of
  strings naming the command first`. The host function does destructure
  `{ argv, init }`, but the module-side proxy packs the positional arguments
  into that object first. Reading the implementation and skipping the proxy is
  how the wrong shape got into this document in the first place.
- `$` may be passed into a helper function, verified. What is refused is pulling
  a namespace off it: `const P = $.process` fails to load the module with
  `$.process is used as a value (a noun...)`. The engine analyses the compiled
  source statically, so every engine call has to appear literally as
  `$.<namespace>.<method>(...)` at the call site.

Verified live, in a PTY session, one probe module, four shapes:

```
$.process.run(["echo","hi"])                        OK, exit 0
$.process.run(ARGV)  // module-level const          OK, so no literal rule on the array
$.process.run(["echo","hi"], { timeoutMs: 5000 })   OK, init is positional
$.process.run(["codedeck","ps","--all","--json"])   OK, exit 0, 73279 chars
$.process.run({ argv: ["echo","hi"] })              REFUSED
```

`codedeck ps --json` and `codedeck ps --all --json` return the same 100 rows and
the same 73685 bytes on this machine: `--all` changes the table, not the JSON.
`ps` has no run filter, so the band over-fetches and narrows in `select.ts`. Of
those 100 rows, 18 belonged to the run under test.

The run id comes from `CODEDECK_RUN_ID`, which `codedeck open` already sets and
which `plugin/statusline.sh` already depends on for its `N agents` field. The
band reads it the same way.

### Why not the web server

`codedeck web` serves `/api/sessions` and an SSE stream, and `$.http.fetch`
exists. Rejected: it makes the band depend on a server the user has to remember
to start, and it would show nothing with no way to say why. `$.process.run`
against the same CLI the human uses has no such precondition.

## Frozen interface

Both implementation slices are written against exactly this. Neither may change
it without the other being redispatched.

```ts
// plugin/mods/agents/types.ts
export interface SessionRow {
  id: string;
  runId?: string;
  origin?: string | null;
  name?: string;
  agent?: string;
  status?: string;
  updatedAt?: string;
}

export interface BandRow {
  id: string;
  status: string;
  agent: string;
  name: string;
}

export interface Snapshot {
  rows: BandRow[];
  hidden: number;      // rows beyond the budget
}

// plugin/mods/agents/parse.ts
// Raw stdout to rows. Returns undefined for anything that is not a JSON array,
// which is how a failed or truncated command is reported. Never throws.
export function parseRows(stdout: string): SessionRow[] | undefined;

// plugin/mods/agents/select.ts
export const ROW_BUDGET = 8;
// Filter to runId, drop origin "open", order by updatedAt descending,
// cut to budget. Missing updatedAt sorts last. Never throws.
export function selectRows(
  rows: SessionRow[],
  runId: string,
  budget?: number,
): Snapshot;

// plugin/mods/agents/format.ts
export const NAME_WIDTH = 28;
// One row to one line. Missing fields render as "-". Never throws.
export function formatRow(row: BandRow): string;
// Header plus rows plus the overflow line when hidden > 0. Empty array when
// the snapshot holds no rows, which is how "draw nothing" is expressed.
export function formatBand(snapshot: Snapshot): string[];
```

`register.tsx` consumes those four functions and nothing else from the mod.

## Drawing

One `Box` holding one `Text` per line, returned as a single element with the
downstream drawing nested as its last child:

```tsx
return (
  <Box>
    {lines.map((line) => <Text key={line}>{line}</Text>)}
    {await next(e)}
  </Box>
);
```

Contract points this satisfies, each one a bug the arcade port actually hit:

- exactly one tree element returned, never an array
- drawn only for `e.component === "AbovePrompt"` and `e.surface === "terminal"`
- capitalized tags, taken from `$.ui.resolve`, because the intrinsic table is
  `{ Box: 'Box', Text: 'Text' }`
- no `Client`, so no surface state

## State in the hooks module

Closure state in `register`, which is the path proven to work:

```
let snapshot: Snapshot | undefined   // last good, undefined until first success
let inFlight = false
let lastRefreshEndedAt = 0
let visible = true                   // /agents toggles
```

`snapshot` staying `undefined` is how AC18 is met: nothing drawn until a
refresh has succeeded once.

## Failure posture

Every fault degrades to the last good snapshot and never to a thrown hook. A
thrown hook is worse than a stale band: the engine drops the whole drawing, and
that is how the arcade port lost its picker.

| Fault | Behaviour |
|---|---|
| command exits non-zero | keep last good, no invalidate |
| command times out | keep last good, no invalidate |
| stdout is not a JSON array | keep last good, no invalidate |
| a row is missing a field | draw the row, field renders as `-` |
| no refresh has ever succeeded | draw nothing |
| `CODEDECK_RUN_ID` absent | draw nothing, pass through |

## Open risks

- ~~`$.process.run` may be refused by a permission or capability gate.~~
  Closed. The extracted implementation contains no permission or capability
  check: it resolves the command and spawns it directly, with the only guards
  being the timeout, the output cap and the `plugin` cgroup class. The residual
  risk is now just first use, which the probe slice covers.
- The band competes for vertical space with whatever else draws above the
  prompt. The row budget bounds it, but the right budget is a matter of taste
  and may need a second look once it is on screen.
