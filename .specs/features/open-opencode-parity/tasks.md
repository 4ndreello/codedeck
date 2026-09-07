# Opencode parity in open Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/open-opencode-parity/design.md`
**Status**: In Progress

**Worktree**: `/home/andreello/dev/codedeck.worktrees/open-parity` (branch `feat/open-opencode-parity`). All paths below are relative to the worktree root. Before T6, run `npm ci --ignore-scripts` in the worktree (no `node_modules` there yet). Never run the full suite locally; scope every gate to the touched file.

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `vitest.config.ts`, `package.json` (`test: vitest run`), `.github/workflows/ci.yml` (`npm ci --ignore-scripts`, `npm run build`, `npm test`, `./scripts/pty-gate.sh`), standing user rule (scoped runs only, batched per file). No `AGENTS.md`/`CONTRIBUTING.md`. Existing tests sampled: `tests/open-opencode.test.ts`, `tests/open-args.test.ts`, `tests/open-pty.test.ts` (vitest, colocated `tests/*.test.ts`, mocked binaries).

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Open launcher + injection (`src/open/`) | unit | 1:1 to touched ACs | `tests/open-*.test.ts`, `tests/opencode-*.test.ts` | `npx vitest run tests/<file>.test.ts` |
| Open registrar (`src/cli/commands/open.ts`) | unit | 1:1 to touched ACs | `tests/open-*.test.ts` | `npx vitest run tests/<file>.test.ts` |
| Live probe (interactive TUI) | manual + committed transcript | One transcript per probe topic, reviewed before its ACs count as done | `.specs/features/open-opencode-parity/probe-*.txt` | manual |
| Build / typecheck | build gate only | `tsc` clean | - | `npm run build` |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npx vitest run tests/<touched>.test.ts` (scoped, never the full suite) |
| Build | After phase completion or spec-only tasks | `npm run build` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase execute in order.

### Phase 1: Live probes

Transcripts first; every P1 AC resolves through its probe. Sequential live-TUI work.

```
T1 -> T2 -> T3 -> T4 -> T5
```

### Phase 2: P1 implementation

Builds only what the Phase 1 transcripts pin. A negative probe retires its ACs to the spec fallback instead of blocking the phase.

```
T6 -> T7 -> T8 -> T9 -> T10
```

### Phase 3: P2 and close

Worktree, effort, then traceability plus gates.

```
T11 -> T12 -> T13
```

---

## Task Breakdown

### T1: Probe opencode rename command

**What**: Run a live opencode TUI probe for the rename command and commit the transcript.
**Where**: `.specs/features/open-opencode-parity/probe-rename-2026-09-07.txt`
**Depends on**: None
**Reuses**: `open-opencode/probe-2026-09-06.txt` pattern
**Requirement**: OP-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Transcript records the exact rename command (or certified absence) with session output
- [ ] Transcript committed on the feature branch

**Tests**: manual probe transcript
**Gate**: manual

**Status**: ✅ Complete (negative probe, transcript committed)

**Commit**: `docs(specs): add opencode rename probe transcript`

---

### T2: Probe inline command channel

**What**: Probe whether `OPENCODE_CONFIG_CONTENT` carries a custom command and commit the transcript.
**Where**: `.specs/features/open-opencode-parity/probe-command-2026-09-07.txt`
**Depends on**: T1
**Reuses**: `src/open/launchers/opencode.ts` (`buildInlineConfig` shape)
**Requirement**: OP-05, OP-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Transcript records the command key (or certified absence) with `debug agent`/`debug config` output
- [ ] Transcript committed on the feature branch

**Tests**: manual probe transcript
**Gate**: manual

**Status**: ✅ Complete (positive probe, transcript committed)

**Commit**: `docs(specs): add opencode command-channel probe transcript`

---

### T3: Probe session id capture

**What**: Probe id capture via pty leading window or session list and commit the transcript.
**Where**: `.specs/features/open-opencode-parity/probe-session-id-2026-09-07.txt`
**Depends on**: T2
**Reuses**: `src/open/runtime.ts` (`PTY_SCAN_LIMIT` technique)
**Requirement**: OP-08, OP-10

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Transcript records the working capture mechanism (or certified absence) with output
- [ ] Transcript committed on the feature branch

**Tests**: manual probe transcript
**Gate**: manual

**Status**: ✅ Complete (positive via list-diff, transcript committed)

**Commit**: `docs(specs): add opencode session-id probe transcript`

---

### T4: Probe session name channel

**What**: Probe the opencode launch-time name channel and commit the transcript.
**Where**: `.specs/features/open-opencode-parity/probe-name-2026-09-07.txt`
**Depends on**: T3
**Reuses**: `src/open/launchers/claude.ts` (`sessionName` derivation rule)
**Requirement**: OP-11, OP-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Transcript records the channel and the exact `opencode session list` oracle (or certified absence)
- [ ] Transcript committed on the feature branch

**Tests**: manual probe transcript
**Gate**: manual

**Status**: ✅ Complete (negative probe, transcript committed)

**Commit**: `docs(specs): add opencode name-channel probe transcript`

---

### T5: Probe effort reader

**What**: Probe where opencode reads effort and commit the transcript.
**Where**: `.specs/features/open-opencode-parity/probe-effort-2026-09-07.txt`
**Depends on**: T4
**Reuses**: `src/open/launchers/opencode.ts` (current silent default)
**Requirement**: OP-15, OP-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Transcript records the reader key (or certified absence) with config output
- [ ] Transcript committed on the feature branch

**Tests**: manual probe transcript
**Gate**: manual

**Status**: ✅ Complete (negative probe, transcript committed)

**Commit**: `docs(specs): add opencode effort probe transcript`

---

### T6: Wire pty into opencode branch (RETIRED)

**What**: RETIRED 2026-09-07. Both consumers went negative in Phase 1
(rename: probe-rename, name channel: probe-name) and capture rides on
list-diff (probe-session-id), so the pty has no consumer. Wiring
raw-mode spawn without observable behavior fails the senior-engineer
check; re-propose only with a pinned keystroke consumer.
**Where**: `.specs/features/open-opencode-parity/tasks.md` (this record)
**Depends on**: T5
**Reuses**: Phase 1 transcripts
**Requirement**: OP-01, OP-03, OP-17 (retired with cause, see T13)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Retirement recorded here with rationale; no src touched

**Tests**: build gate only
**Gate**: build

**Status**: ⚠️ Retired (no consumer after negative probes)

**Commit**: `docs(specs): retire pty wiring task after negative probes`

---

### T7: Add opencode rename injection entry

**What**: Add the probed rename keystrokes to `HARNESS_INJECTION.opencode`.
**Where**: `src/open/injection.ts`
**Depends on**: T6
**Reuses**: `sanitizeInjectedArgument` (mandatory); transcript T1 for the shape
**Requirement**: OP-02, OP-04, OP-18

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Entry exists only as pinned by T1 (or stays empty on negative probe per OP-17)
- [ ] Empty-after-sanitize types nothing
- [ ] Gate check passes: `npx vitest run tests/open-pty.test.ts`
- [ ] No test deleted or weakened

**Tests**: unit
**Gate**: quick

**Status**: ✅ Complete (entry pinned empty by test, 38/38 green)

**Commit**: `feat(open): add opencode rename injection`

---

### T8: Deliver autonomous command to opencode

**What**: Add the command key carrying the autonomous body to the inline config.
**Where**: `src/open/launchers/opencode.ts`
**Depends on**: T7
**Reuses**: `resolveRoleContract` strip rule; transcript T2 for the key
**Requirement**: OP-05, OP-06, OP-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Body equals the md minus frontmatter; negative probe leaves the file untouched
- [ ] Gate check passes: `npx vitest run tests/open-opencode.test.ts`
- [ ] No test deleted or weakened

**Tests**: unit
**Gate**: quick

**Status**: ✅ Complete (command key live, 32/32 + 13/13 green)

**Commit**: `feat(open): deliver autonomous command to opencode`

---

### T9: Capture opencode session id for resume hint

**What**: Wire the probed capture mechanism into the opencode close path.
**Where**: `src/cli/commands/open.ts`
**Depends on**: T8
**Reuses**: `finishOpenSession` unchanged; transcript T3 for the mechanism
**Requirement**: OP-08, OP-09, OP-10, OP-19

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Farewell prints `--resume <id>` when captured, clean exit 0 otherwise
- [ ] No writes to user config besides the managed theme file
- [ ] Gate check passes: `npx vitest run tests/open-action.test.ts`
- [ ] No test deleted or weakened

**Tests**: unit
**Gate**: quick

**Commit**: `feat(open): capture opencode session id for resume hint`

---

### T10: Send session name on opencode open

**What**: Send the launch-time name through the probed channel.
**Where**: `src/open/launchers/opencode.ts`
**Depends on**: T9
**Reuses**: `sessionName` derivation rule; transcript T4 for the channel
**Requirement**: OP-11, OP-12, OP-20

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Name sent when the channel exists; banner unchanged as guaranteed surface
- [ ] Gate check passes: `npx vitest run tests/open-opencode.test.ts`
- [ ] No test deleted or weakened

**Tests**: unit
**Gate**: quick

**Commit**: `feat(open): send session name on opencode open`

---

### T11: CodeDeck-side worktree for opencode open

**What**: Build the checkout via `src/git/worktree.ts` on `--worktree` instead of warn-and-continue.
**Where**: `src/cli/commands/open.ts`
**Depends on**: T10
**Reuses**: `createWorktree`; `run --worktree` lifecycle (persist, no auto-delete)
**Requirement**: OP-13, OP-14, OP-21

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Session cwd is a fresh checkout at HEAD; creation failure aborts before spawn
- [ ] OO-20 retirement cited in code comment at the old warning site
- [ ] Gate check passes: `npx vitest run tests/open-action.test.ts`
- [ ] No test deleted or weakened

**Tests**: unit
**Gate**: quick

**Commit**: `feat(open): CodeDeck-side worktree for opencode open`

---

### T12: Map or warn effort on opencode open

**What**: Honor `--effort` through the probed reader, else print the exact warning.
**Where**: `src/cli/commands/open.ts`
**Depends on**: T11
**Reuses**: Transcript T5 for the reader; spec-pinned warning string
**Requirement**: OP-15, OP-16, OP-22, OP-23

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Mapped reader used when pinned; exact warning plus banner "default" otherwise
- [ ] Gate check passes: `npx vitest run tests/open-args.test.ts`
- [ ] No test deleted or weakened

**Tests**: unit
**Gate**: quick

**Commit**: `feat(open): map or warn effort on opencode open`

---

### T13: Traceability update and gates

**What**: Mark requirement statuses in the spec and run the closing gates.
**Where**: `.specs/features/open-opencode-parity/spec.md`
**Depends on**: T12
**Reuses**: Phase 1 transcripts for retired-vs-verified calls
**Requirement**: Success criteria

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Every OP row reads Verified or Retired-with-transcript, none left Pending without cause
- [ ] Gate check passes: `npm run build`
- [ ] Gate check passes: scoped `npx vitest run` on each touched file (batched per file, never the full suite)

**Tests**: build gate only
**Gate**: build

**Commit**: `docs(specs): mark parity requirements verified`

---

## Phase Execution Map

```
Phase 1 -> Phase 2 -> Phase 3

Phase 1:  T1 -> T2 -> T3 -> T4 -> T5
Phase 2:  T5 -> T6 -> T7 -> T8 -> T9 -> T10
Phase 3:  T10 -> T11 -> T12 -> T13
```

Execution is strictly sequential - there is no intra-phase parallelism. At Execute, phases pack into ~7-task batches (whole phases): Phase 1 (5) + Phase 3 (3) = batch 1 and 2 options aside, the natural packing is batch 1 = Phase 1, batch 2 = Phase 2, batch 3 = Phase 3, each offered as one worker.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: rename probe transcript | 1 file | ✅ Granular |
| T2: command-channel probe transcript | 1 file | ✅ Granular |
| T3: session-id probe transcript | 1 file | ✅ Granular |
| T4: name-channel probe transcript | 1 file | ✅ Granular |
| T5: effort probe transcript | 1 file | ✅ Granular |
| T6: pty key on opencode spawn | 1 call site | ✅ Granular |
| T7: injection entry | 1 table entry | ✅ Granular |
| T8: inline command key | 1 config key | ✅ Granular |
| T9: capture wiring | 1 close path | ✅ Granular |
| T10: launch-time name | 1 channel | ✅ Granular |
| T11: worktree branch | 1 flag path | ✅ Granular |
| T12: effort map-or-warn | 1 flag path | ✅ Granular |
| T13: traceability + gates | 1 file + gates | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | phase start | ✅ Match |
| T2 | T1 | T1 -> T2 | ✅ Match |
| T3 | T2 | T2 -> T3 | ✅ Match |
| T4 | T3 | T3 -> T4 | ✅ Match |
| T5 | T4 | T4 -> T5 | ✅ Match |
| T6 | T5 | T5 -> T6 via map | ✅ Match |
| T7 | T6 | T6 -> T7 | ✅ Match |
| T8 | T7 | T7 -> T8 | ✅ Match |
| T9 | T8 | T8 -> T9 | ✅ Match |
| T10 | T9 | T9 -> T10 | ✅ Match |
| T11 | T10 | T10 -> T11 via map | ✅ Match |
| T12 | T11 | T11 -> T12 | ✅ Match |
| T13 | T12 | T12 -> T13 | ✅ Match |

Ordering across phases is carried by the chains (Phase 1 completes before Phase 2 starts); transcript inputs travel via each task's `Reuses`, so every declared edge has a matching arrow.

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Live probe (new transcript) | manual + transcript | manual probe transcript | ✅ OK |
| T2 | Live probe (new transcript) | manual + transcript | manual probe transcript | ✅ OK |
| T3 | Live probe (new transcript) | manual + transcript | manual probe transcript | ✅ OK |
| T4 | Live probe (new transcript) | manual + transcript | manual probe transcript | ✅ OK |
| T5 | Live probe (new transcript) | manual + transcript | manual probe transcript | ✅ OK |
| T6 | Open registrar | unit | unit | ✅ OK |
| T7 | Launcher + injection | unit | unit | ✅ OK |
| T8 | Open launcher | unit | unit | ✅ OK |
| T9 | Open registrar | unit | unit | ✅ OK |
| T10 | Open launcher | unit | unit | ✅ OK |
| T11 | Open registrar | unit | unit | ✅ OK |
| T12 | Open registrar | unit | unit | ✅ OK |
| T13 | Spec file only | build gate only | build gate only | ✅ OK |
