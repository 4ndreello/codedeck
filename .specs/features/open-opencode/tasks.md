# Open multi-harness Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/open-opencode/design.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: none (`AGENTS.md`, `CONTRIBUTING.md`, lint config all absent - strong defaults applied). Provenance: `package.json` (`test: vitest run`, `build: tsc`), `vitest.config.ts` (include `tests/**/*.test.ts`), `.github/workflows` (CI runs `npm ci`, `npm run build`, `npm test`), user rule (never full suite, always scope by file).

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| `src/open/contract.ts`, `src/open/launchers/*.ts` (pure builders) | unit | 1:1 to spec ACs served; every listed edge case served has a test | `tests/open-*.test.ts` | `npx vitest run tests/<file>.test.ts` |
| `src/open/runtime.ts` (pure helpers + spawn) | unit | Pure helpers fully; spawn via injected fake child (existing `launchClaude` pattern) | `tests/open-*.test.ts` | `npx vitest run tests/<file>.test.ts` |
| Registrar wiring (`registerOpenCommand` dispatch) | unit | Dispatch per binding, warn paths, passthrough | `tests/open-*.test.ts` | `npx vitest run tests/<file>.test.ts` |
| Live probe script | integration | Script exit 0 pins `edit:false`, file absent | `scripts/probe-*.sh` | `./scripts/probe-opencode-reviewer.sh` |
| Docs / README | none | - (build gate only) | `README.md` | `npm run build` |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npx vitest run tests/<file>.test.ts` |
| Build | After phase completion or registrar/wiring tasks | `npm run build` + quick gates of touched files |
| Probe | After T8 only | `./scripts/probe-opencode-reviewer.sh` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase execute in order.

### Phase 1: Foundation

Pure moves out of `open.ts`, suite green throughout.

```
T1 → T2
T1 → T3
```

### Phase 2: Launchers

Claude moves, opencode is born, registrar dispatches.

```
T1 → T4 → T7
T1 → T5 → T6 → T7
```

### Phase 3: Proof

Live probe, record, close.

```
T7 → T8 → T9
```

---

## Task Breakdown

### T1: Extract contract module

**What**: Create `src/open/contract.ts` with new `resolveRoleContract` (composes `roleBody` + ultra) and `resolveOpenModel` (flag-beats-binding precedence), plus `effectiveModel` moved pure from `open.ts`.
**Where**: `src/open/contract.ts`
**Depends on**: None
**Reuses**: `src/core/roles.ts` (`roleBody`), `src/config/config.ts` patterns
**Requirement**: OO-02, OO-06 (model precedence), OO-18 (fail-loud contract)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `open.ts` imports the three helpers from contract, no duplication
- [x] Gate check passes: `npm run build` + `npx vitest run tests/open-contract.test.ts`
- [x] Test count: 9 tests pass (role body, ultra, precedence, missing plugin, passthrough model, fromConfig)

**Tests**: unit (new `tests/open-contract.test.ts`)
**Gate**: build

**Status**: complete

**Commit**: `refactor(open): extract contract module from open command`

---

### T2: Extract runtime module

**What**: Create `src/open/runtime.ts` with banner/boot/farewell/sigint/shim/env/spawn helpers moved pure from `open.ts`.
**Where**: `src/open/runtime.ts`
**Depends on**: T1
**Reuses**: `src/cli/ui.ts` (`renderLogo`, `renderFarewell`), current `open.ts` bodies verbatim (`installSigintGuard`, `sanitizeEnv`, `withCodedeckOnPath`, `ensureCodedeckShim`, `exitCodeFor`, `bootFrame`, `playBoot`, `renderBanner`, `resumeHint`, `renderExit`, `takeSessionId`, `finishOpenSession`, `launchClaude` as `spawnHarness`)
**Requirement**: OO-03, OO-11, OO-12, OO-22

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `open.ts` delegates, behavior identical
- [x] Gate check passes: `npm run build` + `npx vitest run tests/open-args.test.ts` + `npx vitest run tests/open-contract.test.ts`
- [x] Test count: existing suite green (71), zero expectation changes

**Tests**: unit (existing `tests/open-args.test.ts`, untouched)
**Gate**: quick

**Status**: complete

**Commit**: `refactor(open): extract runtime module from open command`

---

### T3: Split catalog verdict from fetch

**What**: Add pure `judgeModelIn(catalog, model, fromConfig)` in contract; keep `judgeModel` as one-line claude adapter so the suite stays untouched; wire claude path through the split.
**Where**: `src/open/contract.ts`
**Depends on**: T1
**Reuses**: `findClosestModel`, `modelNames` via the moved verdict
**Requirement**: OO-10, OO-15

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `judgeModel` keeps signature and behavior (adapter over `judgeModelIn` with claude catalog)
- [x] Gate check passes: `npm run build` + `npx vitest run tests/open-args.test.ts` + `npx vitest run tests/open-contract.test.ts`
- [x] Test count: 5 new tests (ok, unknown catalog, empty catalog, reject with suggestion and recovery, harness noun)

**Tests**: unit
**Gate**: build

**Status**: complete

**Commit**: `refactor(open): split pure catalog verdict from harness fetch`

---

### T4: Extract claude launcher

**What**: Create `src/open/launchers/claude.ts` with `buildOpenArgs`, `buildSettings`, `entitlementError`, `preflightModel` and the `judgeModel` adapter moved verbatim plus `resolveClaudeBinary` renamed to `resolveBinary` and `assertSystemPromptFlagSupported` renamed to `assertSupport`; `OpenFlags` moves to contract; `open.ts` delegates.
**Where**: `src/open/launchers/claude.ts`
**Depends on**: T1
**Reuses**: Current `buildSettings`/`buildOpenArgs`/judge-adapter/preflight/resolve/assert/entitlement bodies
**Requirement**: OO-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Args and settings byte-identical for all suite cases
- [x] Gate check passes: `npm run build` + `npx vitest run tests/open-args.test.ts` + `npx vitest run tests/open-contract.test.ts`
- [x] Test count: existing suites green (85), zero expectation changes

**Tests**: unit (existing suites, untouched)
**Gate**: quick

**Status**: complete

**Commit**: `refactor(open): extract claude launcher`

---

### T5: Opencode permission map

**What**: Add `rolePermission(role)` returning the explicit allow/deny object per role from the design table.
**Where**: `src/open/launchers/opencode.ts`
**Depends on**: T1
**Reuses**: Design permission table (all keys live-probed via `debug agent`)
**Requirement**: OO-14 (map half)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] All four roles return exact objects, no role relies on user defaults
- [x] Gate check passes: `npm run build` + `npx vitest run tests/open-opencode.test.ts`
- [x] Test count: 4 tests (one per role, exact object match)

**Tests**: unit (new `tests/open-opencode.test.ts`)
**Gate**: build

**Status**: complete

**Commit**: `feat(open): add opencode role permission map`

---

### T6: Opencode inline config and args builders

**What**: Add `agentName`, `buildInlineConfig`, `buildArgs`, `resolveBinary`, `preflight` to the opencode launcher, plus a test pinning the resolved permissions via `opencode debug agent` with env fixture.
**Where**: `src/open/launchers/opencode.ts`
**Depends on**: T5
**Reuses**: contract (`resolveRoleContract`, `judgeModelIn`), `detectBinary`, `getCachedOrDiscoverModels`
**Requirement**: OO-05, OO-06, OO-07, OO-09, OO-10, OO-15, OO-19, OO-21

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `buildInlineConfig` output parses as JSON with `instructions` + `codedeck-<role>` agent
- [x] `buildArgs` emits `--agent/--model/--auto/--session` and rejects non-`provider/model` before spawn
- [x] Parsed-back inline JSON carries the exact `rolePermission` objects per role (unit half of the pin; the live `debug agent` half runs in T8 where the binary exists, since CI has no opencode)
- [x] Builders perform zero filesystem writes (spy test serves `OO-19`)
- [x] Gate check passes: `npm run build` + `npx vitest run tests/open-opencode.test.ts`
- [x] Test count: 14 tests (shape, permissions ×4, no writes, args, no-auto, format ×4, binary ×2, preflight ×2)

**Tests**: unit
**Gate**: build

**Status**: complete

**Commit**: `feat(open): add opencode inline config and args builders`

---

### T7: Registrar dispatches by binding

**What**: Thin `registerOpenCommand` to contract + runtime + launcher registry; drop `harnessMismatch` for bound roles; `--worktree` warns on opencode; keep re-exports and argv.
**Where**: `src/cli/commands/open.ts`
**Depends on**: T4, T6
**Reuses**: contract, runtime, both launchers, `getInvocation`/`scanOptions` in place
**Requirement**: OO-04, OO-08, OO-11, OO-12, OO-13, OO-16, OO-20, OO-22, OO-23

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Opencode-bound role dispatches to opencode launcher; claude path byte-identical
- [x] `--worktree` + opencode warns and continues; `--no-theme` + opencode opens stock
- [x] Gate check passes: `npm run build` + all three open suites green (104)
- [x] Test count: 5 new dispatch tests; one pinned mismatch expectation updated with user approval (opencode now dispatches per OO-04)

**Tests**: unit
**Gate**: build

**Status**: complete

**Commit**: `feat(open): dispatch open by role binding`

---

### T8: Live reviewer probe and record

**What**: Add `scripts/probe-opencode-reviewer.sh` pinning `edit:false/write:false/read:false` per role via `opencode debug agent` with inline env fixture, then running non-interactive `opencode run --agent codedeck-reviewer` asking for file creation with `--auto`, asserting refusal and file absence; record the verdict in the spec assumptions table (`OO-17`).
**Where**: `scripts/probe-opencode-reviewer.sh`
**Depends on**: T7
**Reuses**: Built `dist/` CLI builders for the inline env (or documented manual env)
**Requirement**: OO-14, OO-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Script exits 0 with refusal evidence and no file created
- [x] Spec assumptions table records the verdict (mapping stands, bash hole documented like Claude)
- [x] Gate check passes: `./scripts/probe-opencode-reviewer.sh`

**Tests**: integration (script itself + spec record in same commit)
**Gate**: probe

**Status**: complete

**Commit**: `test(open): probe opencode reviewer write refusal`

---

### T9: Docs and traceability close-out

**What**: Document opencode in the README `open` section; flip all OO rows to Verified where gates passed.
**Where**: `README.md`
**Depends on**: T8
**Reuses**: Spec goals and design decisions as doc source
**Requirement**: OO-04, OO-06 (user-visible behavior)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] README shows binding-driven selection, `--auto` parity, `provider/model` format, stock TUI scope
- [ ] Traceability statuses updated in the same commit
- [ ] Gate check passes: `npm run build`

**Tests**: none (docs layer, build gate only)
**Gate**: build

**Commit**: `docs(open): document opencode launcher`

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3

Phase 1:  T1 ------→ T2
          T1 ------→ T3
Phase 2:  T1 ------→ T4 ------→ T7
          T1 ------→ T5 ------→ T6 ------→ T7
Phase 3:  T7 ------→ T8 ------→ T9
```

Execution is strictly sequential - there is no intra-phase parallelism. A single agent (or batch worker) works one task at a time, in order.

**How phase-based execution works:**

At Execute, the agent counts total tasks and packs phases into **task-budgeted batches** (~7 tasks
per worker, whole phases - the benchmarked sweet spot is ~20 tasks → ~3 workers). A **phase** is the
semantic/dependency unit; a **batch** is one or more *consecutive whole phases* assigned to one
worker. The cut only ever lands on a phase boundary - a phase is never split across workers. When
packing yields more than one batch (> ~8 tasks), the agent offers to dispatch batch sub-agents.
Batches run sequentially: each worker executes ALL its tasks in order, then reports a compact summary
before the next batch starts. This right-sizes the worker count by workload instead of by phase
count (one-per-phase is too fragmented; expensive and slow). See [sub-agents.md](sub-agents.md) for
the full model - packing algorithm, offer-then-confirm, worker payload, compact summary contract,
failure handling, and context sizing guidance.

When the whole feature fits a single batch (≤ ~8 tasks), execution happens inline in the main window
with no sub-agents spawned.

**The orchestrating agent's role during Execute:**
1. Count total tasks and pack phases into ~7-task batches - offer batch sub-agents if that yields more than one batch and the user accepts
2. Dispatch the next batch (to a worker, or execute inline)
3. Receive the compact batch summary
4. Update tasks.md with results
5. If the batch summary shows all tasks complete: proceed to the next batch
6. If a task failed: decide fix/escalate before dispatching the next batch

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Extract contract module | 1 file created | ✅ Granular |
| T2: Extract runtime module | 1 file created | ✅ Granular |
| T3: Split catalog verdict | 1 file modified | ✅ Granular |
| T4: Extract claude launcher | 1 file created | ✅ Granular |
| T5: Permission map | 1 file created | ✅ Granular |
| T6: Inline config + args | 1 file modified | ✅ Granular |
| T7: Registrar dispatch | 1 file modified | ✅ Granular |
| T8: Probe script + spec record | 1 script + 1 table row | ✅ Granular |
| T9: README + traceability | 1 doc + table statuses | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | start | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T1 | T1 → T3 | ✅ Match |
| T4 | T1 | T1 → T4 | ✅ Match |
| T5 | T1 | T1 → T5 | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |
| T7 | T4, T6 | T4 → T7, T6 → T7 | ✅ Match |
| T8 | T7 | T7 → T8 | ✅ Match |
| T9 | T8 | T8 → T9 | ✅ Match |

No dependency points to a later phase.

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | contract.ts (pure builders) | unit | unit + new test file | ✅ OK |
| T2 | runtime.ts | unit | unit, existing suite | ✅ OK |
| T3 | contract.ts | unit | unit | ✅ OK |
| T4 | launchers/claude.ts | unit | unit, existing suite | ✅ OK |
| T5 | launchers/opencode.ts | unit | unit + new test file | ✅ OK |
| T6 | launchers/opencode.ts | unit | unit | ✅ OK |
| T7 | registrar wiring | unit | unit | ✅ OK |
| T8 | probe script | integration | integration | ✅ OK |
| T9 | README docs | none | none | ✅ OK |

---

## Task Verification Standards

Every task MUST follow the `Done when` + `Tests` + `Gate` fields defined in the **Task Breakdown** template above. Each `Done when` entry must be specific, testable (binary pass/fail), and reference the gate check command from the `Gate Check Commands` section. Include the expected test count to prevent silent deletions.
