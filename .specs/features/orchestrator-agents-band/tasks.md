# Tasks: orchestrator agents band

Source of truth: `spec.md`. Interface: the frozen block in `design.md`.

## Coverage matrix

Confirm this before Execute. It is the authority for what counts as covered.

| Layer | Test type | Lives in | Command |
|---|---|---|---|
| `plugin/mods/agents/parse.ts` | unit | `tests/mods-agents/parse.test.ts` | `npx vitest run tests/mods-agents` |
| `plugin/mods/agents/select.ts` | unit | `tests/mods-agents/select.test.ts` | `npx vitest run tests/mods-agents` |
| `plugin/mods/agents/format.ts` | unit | `tests/mods-agents/format.test.ts` | `npx vitest run tests/mods-agents` |
| `plugin/hooks/register.tsx` | none | n/a | PTY probe, below |
| manifest | contract | n/a | `claude plugin validate .` |
| drawing, end to end | probe | `scripts/band-probe.sh` | `bash scripts/band-probe.sh` |

`register.tsx` carries test type **none** on purpose: it runs only inside the
engine sandbox, it holds no decisions by design, and a unit test of it would
test a mock rather than the engine. Its proof is the probe. This is the one
row in the matrix that may be `none`, and the rule that keeps it honest is the
design rule: any logic that appears in `register.tsx` is a design violation and
belongs in the pure layer where it is covered.

The probe is the only check that can distinguish "draws correctly" from "draws
nothing". A PASS requires zero engine errors **and** the band's text present in
the capture. Zero errors alone is not a pass.

## T0. Strip the arcade

- Requirement: spec decision 1.
- Delete `plugin/mods/arcade/`, `plugin/hooks/boards/`, `tests/mods-arcade/`.
  Reduce `plugin/hooks/register.tsx` to a valid passthrough module. Trim the
  arcade text out of `docs/mods.md`.
- Keeps untouched: `src/open/runtime.ts`, `plugin/hooks/hooks.json`,
  `plugin/.claude-plugin/plugin.json`, `.github/workflows/ci.yml`,
  `.gitignore`, `tests/open-args.test.ts`.
- Tests: none new. `npx vitest run tests/open-args` must stay green, which is
  what proves the plumbing survived the deletion.
- Gate: build green, both validates pass, PTY probe reports zero matches for
  `hook skipped`, `is not an element` and `arcade`.
- Status: dispatched as worker `adde`.

## T1. Pure layer: parse

- Requirement: AC17, AC18, AC19.
- Write `plugin/mods/agents/types.ts` and `plugin/mods/agents/parse.ts` to the
  frozen interface.
- Tests: `tests/mods-agents/parse.test.ts`, in this same task. Cases: a well
  formed array; an empty array; `stdout` that is not JSON; JSON that is an
  object rather than an array; truncated JSON; an array holding a non-object.
  Each returns rows or `undefined`, never throws.
- Gate: `npx vitest run tests/mods-agents` green.
- Status: worker `a0a9`, completed. 10 tests green.

## T2. Pure layer: select

- Requirement: AC1, AC2, AC10, AC11, AC12.
- Write `plugin/mods/agents/select.ts` to the frozen interface.
- Tests: `tests/mods-agents/select.test.ts`, in this same task. Cases: rows of
  another run are excluded; the `origin: "open"` row is excluded; ordering is
  `updatedAt` descending; a row with no `updatedAt` sorts last; exactly budget
  rows yields `hidden: 0`; budget plus three yields `hidden: 3`; an empty input
  yields no rows and `hidden: 0`.
- Gate: `npx vitest run tests/mods-agents` green.
- Status: worker `e343`, completed. 15 tests green.

## T3. Pure layer: format

- Requirement: AC8, AC9, AC11, AC19, and AC4 through the empty-array contract.
- Write `plugin/mods/agents/format.ts` to the frozen interface.
- Tests: `tests/mods-agents/format.test.ts`, in this same task. Cases: a row
  renders id, status, agent and name; a name longer than `NAME_WIDTH` is
  truncated, not wrapped; every produced line is free of `\n`; a missing field
  renders `-`; `hidden: 0` produces no overflow line; `hidden: 3` produces one
  naming three; a snapshot with no rows produces an empty array.
- Gate: `npx vitest run tests/mods-agents` green.
- Status: worker `b83f`, stopped once its artifact was green. 26 tests green,
  no drift outside `format.ts` and `format.test.ts`.

## T4. Wire the band into the hooks module

- Requirement: AC3, AC5, AC6, AC7, AC13, AC13a, AC14, AC15, AC16, AC16a, AC20,
  AC21, plus decision 2 for `/agents`.
- Owns `plugin/hooks/register.tsx` alone. Consumes T1 through T3 through the
  frozen interface and adds no logic of its own.
- Tests: none, per the coverage matrix. Its proof is T5.
- Gate: build green, both validates pass.
- Depends on: T0, T1, T2, T3.
- Also owns the `description` string in `plugin/hooks/hooks.json`, which still
  named the arcade after T0.
- Status: worker `c96f` **rejected, empty delivery**. It reported `completed
  exit 0` and wrote nothing: `git diff` on `register.tsx` was still T0's strip.
  Its log shows it spent the whole budget investigating, and died reaching for
  the claude binary to find the return shape of `$.process.run`. The briefing
  gave the call shape but not the result shape, so the gap was mine.
- Redispatched as worker `a3f7` with the full `$.process.run` contract inlined
  (`{ exitCode, stdout, stderr }` on success, throws on timeout and on failure
  to start), an explicit ban on opening the binary, and an instruction to write
  the file before investigating anything.
- `a3f7` was superseded when the design changed from a band above the prompt to
  a pane on the right. Worker `308a` rewrote the file against the pane contract:
  **accepted**, gates right, reads `e.requestId` and `e.props.bodyColumns`, and
  carries no logic of its own.
- Two defects found after acceptance, by screen capture, and fixed in place:
  1. the drawing came out shredded into vertical slivers. `Box` defaults to
     `flexDirection: "row"`, so the 51 `Text` children were laid side by side.
     Fixed with `<Box flexDirection="column">`. No error was raised anywhere:
     the module loaded, the hook ran, every validate passed, and the pane was
     garbage on screen. Nothing but a capture would have caught this
  2. the drawing was clipped at the bottom, eating the hidden count, the legend
     and the closing border. The pane reports its height as
     `props.scroll.bodyRows` (44 in a 50 row terminal) and `formatPane` was
     never told. Fixed by passing it through; making it fit is T7

## T5. The probe, written down

- Requirement: the spec's Verification section.
- Write `scripts/pane-probe.sh`: start a real session under tmux with the
  plugin, capture the screen, assert the frame is present, assert the drawing
  is column shaped rather than shredded, assert the closing border is on
  screen, assert no engine complaint, exit non-zero when any of them fails.
  Never sends a prompt: the pane draws at session start, so the probe costs no
  tokens.
- The PTY capture through `script` was the first approach and it reads badly:
  a docked pane repaints in place, so the byte stream interleaves and a grep
  for a header finds nothing even when the pane is correct. `tmux
  capture-pane` returns the settled screen and is what the assertions run on.
- Tests: the script is the test. It must be shown to discriminate: run it once
  against a deliberately broken band and show it failing, then against the real
  one and show it passing.
- Gate: the script passes on the real pane and fails on the broken one. Today
  it is expected to fail the closing border assertion, because the drawing does
  not fit yet. A probe that goes green against a known broken state is worth
  nothing.
- Depends on: T4.
- Status: **accepted**, after two failed workers and one hand finish.
  - `8555` died reading `~/.claude`, which the harness auto-rejects. It wrote
    nothing. Briefing gap: no repo boundary was stated
  - `5a23` delivered the script with the tmux driver, the polling, the trap and
    all four assertions
  - `86c2` was dispatched to fix the `shape` assertion and reported
    `completed exit 0` having changed nothing: its attempt to copy the plugin
    into `/tmp` was blocked, and it stopped there. Second false success of the
    run from the same shape of gap, a briefing that sends a worker somewhere it
    cannot write
  - the `shape` fix was finished by hand. It mattered: the assertion written to
    catch a shredded drawing reported **PASS on a shredded drawing**, because
    counting dock lines of equal width measures the dock rail, not the content.
    It now counts dock lines holding a run of 20 or more `─`, which is 8 on the
    real drawing and 0 when shredded, with the threshold at 5 because the floor
    of a legitimate drawing is 6
- Verified by hand, both directions: `VERDICT: PASS` against `dist/plugin`,
  `VERDICT: FAIL (3 assertions)` against a copy with `flexDirection` removed.

## T6. Document the engine contract

- Requirement: none in the spec. This is debt repayment, not a feature.
- Add to `docs/mods.md` the function-hooks contract extracted from the engine
  binary: the single tree element rule, the per-component `ui.render` gate, the
  `<Button key label onPress>` rule, the `<Client>` six-prop rule and its
  silent discard of anything else, the `{ Box: 'Box', Text: 'Text' }` intrinsic
  table, and `$.command.register`'s required description. Each with the engine's
  own wording quoted.
- Tests: none. It is prose.
- Gate: a reader who has never seen this run can spell a correct hooks module
  from the page alone.
- Status: dispatched as worker `55e9`.
- Note: this is the most valuable artifact of the arcade detour. None of it is
  in public documentation. Do not let it die with the game.

## Mutation probe, before delivery

Per the run contract, after T1 through T3 are green, inject one behavior fault
per pure module in a scratch copy and confirm the tests catch it:

- `select.ts`: invert the `updatedAt` comparison.
- `format.ts`: change the truncation width by one.
- `parse.ts`: return `[]` instead of `undefined` on a parse failure.

Kills and survivors both go in the closing report. A survivor becomes a fix
slice, not a footnote.

### Result: 5 injected, 5 killed, 0 survivors

Run in a scratch copy at `scratchpad/mut` holding only the four mod files, the
three test files and a minimal vitest config, with `node_modules` symlinked.
Baseline there was 51 passed, matching the repo. Scratch discarded after.

| Mutant | Fault | Outcome |
|---|---|---|
| M1 | `select.ts`, `return tb - ta` becomes `ta - tb` | killed, 2 tests |
| M2 | `format.ts`, `clip(value, NAME_WIDTH - 1)` becomes `NAME_WIDTH` | killed, 3 tests |
| M3 | `parse.ts`, failure returns `[]` instead of `undefined` | killed, 3 tests |
| M4 | `select.ts`, drop `row.origin !== "open"` | killed, 1 test |
| M5 | `format.ts`, drop the empty-rows early return | killed, 2 tests |

M4 and M5 are extra, beyond the three the plan required. They were added
because they hit the two acceptance criteria that carry the feature: AC2, the
orchestrator must not list itself, and AC4, an empty snapshot draws nothing.
Both were caught by a named test, so the suite discriminates on the behaviour
the feature is about, not only on the shape of its output.

## T7. Make the drawing fit the height it is given

- Requirement: new. The pane reports `props.scroll.bodyRows`, measured at 44 in
  a 50 row terminal, and `formatPane` returned 51 lines. The bottom 7 were
  clipped: the hidden count, the legend and the closing border all fell off.
- Owns `plugin/mods/agents/pane.ts` and `tests/mods-agents/pane.test.ts`.
- `formatPane(snapshot, columns, rows?)`, additive. With `rows` given the
  result never exceeds it, the frame and footer are never what gets cut, rows
  in a live status keep full cards, finished rows collapse to one line, and
  everything dropped counts into the hidden total.
- Deletes the `CARD_BUDGET` export. It is a real hole: a mutation from 6 to 7
  survived the whole suite, because the tests read their expectations off the
  exported constant instead of pinning a number. The fit decision belongs where
  the height is known, and the replacement tests pin literals.
- Tests: in the same task, one per rule, two of them with literal line counts.
- Gate: `npx vitest run tests/mods-agents` green, `npm run build` green, and
  the drawing fits on screen under T5's probe.
- Depends on: T4.
- Status: **accepted**, worker `d9f1`.
- Verified by hand, not by report: 46 tests green scoped to `tests/mods-agents`,
  and an independent mutation probe of 4 faults with 4 kills (fit loop off by
  one, minimum height ignored, eviction order inverted, `MAX_CARD_COLUMNS`
  56 to 60). The last one is the one that matters: the same mutation against
  the old `CARD_BUDGET` survived, and it dies now because the tests pin
  literals instead of reading the exported constant.
- `d9f1` raised its own reviewer, `bdaa`, which fuzzed the layer independently
  (36300 checks, its own mutants) and found no blocking defect. Two edges on
  the record, neither fixed:
  1. the orchestrator counts into `+N agentes ocultos` when it is itself
     evacuated, while the rest of the frame uses "agentes" for workers only.
     Reachable only in a pane of 12 to 15 lines with no drawable worker
  2. two `origin: "open"` rows in one run keep the second in `total` alone.
     Unreachable with real data, since `codedeck open` exports its own session
     id as the run id and ids are unique

## Final review over the finished scope

Worker `3216`, reviewer role, read only, over the whole uncommitted tree except
`pane.ts` and `pane.test.ts`, which `bdaa` had already fuzzed. It left the tree
byte identical, verified by `git status` before and after.

No blocking defect. It re-ran every gate itself rather than trusting the
reports: 46 pane tests, 10 setup tests, the pinned regression trio at 123, the
manifest suite at 15, `npm run build`, `claude plugin validate --strict`, and
the live pane probe at `VERDICT: PASS`. It also reverted `resolveSetupTarget`
in a scratch copy and showed 7 of the 10 setup tests failing against the old
behaviour, so those tests can actually fail.

Seven findings, all non blocking, all remediated:

1. `refresh` reads its single flight guard at line 55 and sets the flag at line
   62, with an await in between, so two interleaved firings both spawn
   `codedeck ps`. `$.env.get` also sat outside the try, so a rejection escaped
   as an unhandled rejection of a voided promise. Dispatched as `d68e`
2. `session.start` opened the dock unconditionally, so a session loading the
   plugin without `CODEDECK_RUN_ID` got a permanently empty 90 column dock,
   reproduced live by the reviewer. Dispatched as `d68e`
3. `BandRow` and `Snapshot` in `types.ts` had no importer, left over from the
   rejected band design. Deleted
4. `src/open/runtime.ts:183` and `tests/open-args.test.ts:839` still said the
   function hooks back the arcade mod, in the present tense. Renamed, and the
   CI pin comment reworded to name the module rather than the dead game
5. `scripts/pane-probe.sh` tested `${dock:0:1}` against a box character set
   right after building `dock` with a leading box character, so the guard
   could never reject anything. Deleted, along with the now orphaned constant
6. `scripts/band-mock.mjs` held a ternary with two identical branches. It was
   the three variant mock that settled the design, and the design is settled.
   File deleted
7. `docs/mods.md` told the reader to "run the plugin-types flow" with no
   command behind it: no such script exists in `package.json`. Section deleted

## T8. The connectors, and the rows they wasted

- Requirement: new, from reading a real capture. Two defects the tests could
  not see because no test looked at the shape of the tree.
- A stem hung above the orchestrator card, a connector to nothing, since the
  orchestrator is the root. And every collapsed one liner carried its own stem,
  so a finished agent cost two rows to say one line's worth: 11 rows of
  connector in a 44 row pane while 12 agents were reported hidden.
- Owns `plugin/mods/agents/pane.ts` and `tests/mods-agents/pane.test.ts`.
- Rule now: no stem above the first block ever, cards keep stems between them
  because that is what reads as a tree, and a run of collapsed lines draws with
  one stem where the run begins and none between the entries.
- Status: **accepted**, worker `8ee0`, with two test gaps closed on a second
  pass after its reviewer `e16e` found them.
- Result on screen, same pane, same 44 rows: 22 agents drawn instead of 11,
  hidden down from 12 to 3.
- Verified by hand: 52 tests green, and three injected faults all killed. The
  stem above the first block (7 failures), the stem between collapsed entries
  (6 failures), and the orchestrator losing its place as the last card to be
  evicted (2 failures). The last one only dies because `e16e` spotted that
  nothing pinned it and `8ee0` added the pin.

## T9. The way back in

- Requirement: new, from the user asking "se eu fechar como abre dnv?". The
  pane could be closed three ways (the `/band` toggle, the dock's own `✕`, or a
  desynced flag) and only one of them had a way back, a command nobody would
  guess.
- Probed first, because the design depended on facts nobody had: closing the
  pane by its `✕` fires no hook at all, so the module cannot track open state;
  a `Button`'s `onPress` is handed the press event, not `$`, so it cannot call
  the engine; a `hotkey` is swallowed by the prompt; `$.ui.open` on an open pane
  is a no-op. All four verified live under tmux with synthetic SGR clicks, and
  written into `docs/mods.md`.
- Shape that survives those facts: one button above the prompt that only ever
  opens, never toggles, so there is no state to desync. `paneButtonLabel` in the
  pure layer draws the count, the `ui.press` hook does the work and re-syncs
  `paneOpen` so a later `/band` still toggles the right way.
- Owns `plugin/mods/agents/pane.ts`, `plugin/hooks/register.tsx`,
  `tests/mods-agents/pane.test.ts`, `docs/mods.md`.
- Gated on `CODEDECK_RUN_ID`, same as the pane: verified that a plain
  `claude --plugin-dir` session with the variable unset draws neither.
- Verified live end to end in a real `codedeck open orchestrator` session:
  button renders as `[ 1 agente ]`, the `✕` closes the pane, one click brings it
  back with the drawing intact. `pane-probe.sh` still grades PASS on all four
  assertions.
- Tests 48 in `tests/mods-agents/pane.test.ts`, six of them new. Four injected
  faults, four killed: the singular collapsed into the plural, the working half
  dropped, `starting` no longer counted as working, and the defensive read of a
  mangled snapshot removed.

## Delivery state

Landed as three commits, not the four this section first planned. The arcade
removal cannot stand alone: `register.tsx` at the previous HEAD imports
`../mods/arcade/games/pet.js`, `best.js` and `../mods/arcade/index.js`, so a
commit that deletes those modules without rewriting the hooks module leaves a
tree that cannot build. Removal and replacement are one change.

1. `fix(setup)`: `src/cli/commands/setup.ts`, `tests/setup-profile-target.test.ts`,
   `.specs/fixes/`. Independent of the pane, and carried onto its own branch off
   main so the urgent fix is reviewable without the feature.
2. `feat(mods)`: the arcade deleted, the pane added. `plugin/`, `tests/mods-arcade/`
   deleted, `tests/mods-agents/`, `scripts/pane-probe.sh`,
   `.specs/features/`, plus the stale "arcade mod" comments renamed in
   `src/open/runtime.ts`, `tests/open-args.test.ts` and `.github/workflows/ci.yml`,
   which are stale the moment the arcade is gone.
3. `docs(mods)`: `docs/mods.md`, the engine contract this feature had to learn.

Gates run on the tree that was committed: `npm run build` ok,
`claude plugin validate --strict plugin/` passed, 73 tests across
`tests/mods-agents/` and `tests/plugin-manifest.test.ts`, 224 across the setup,
profile and open-args files.

## Order

T0 alone, because everything else builds on the stripped tree.
Then T1, T2, T3 in parallel: disjoint files, same frozen interface.
Then T4, then T5.
T6 any time after T0, it touches only docs.
