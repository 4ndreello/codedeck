# Orchestrator Usage Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Spec**: `.specs/features/orchestrator-usage/spec.md`
**Design**: `.specs/features/orchestrator-usage/design.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `AGENTS.md` and `~/.claude/CLAUDE.md` (never run the full suite, always scope by file), `vitest.config.ts` (`tests/**/*.test.ts`, `node:sqlite` shim), `.github/workflows/ci.yml` (`npm run build`, `npm test`). No coverage threshold configured, strong defaults applied.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Schema / migration (`src/store/database.ts`) | integration | new tables exist on a fresh DB and on a DB created by the previous schema; reopening is a no-op | `tests/power-database.test.ts` pattern, new file `tests/usage-schema.test.ts` | `npx vitest run tests/usage-schema.test.ts` |
| Store modules (`src/store/usage-ledger.ts`, `src/store/native-links.ts`) | integration (real SQLite via shim) | every branch; ORCH-13/14/15 and the 6-step worked example; seed path; ORCH-03 and ORCH-16 `previous` | `tests/usage-ledger.test.ts`, `tests/native-links.test.ts` | `npx vitest run tests/usage-ledger.test.ts tests/native-links.test.ts` |
| Pure core (`src/core/pricing.ts`, `src/core/usage-source.ts`, `src/core/run-usage.ts`, `src/core/claude-transcript.ts`) | unit | 1:1 to the ACs each covers, every listed edge case (bad JSON line, file above 50 MB streamed, missing file) | `tests/pricing.test.ts`, `tests/usage-source.test.ts`, `tests/usage.test.ts`, `tests/claude-transcript.test.ts` | `npx vitest run <file>` |
| Usage query (`src/store/sessions.ts` `queryUsage`) | integration | `byOrigin` buckets, orchestrator in totals, Codex repricing on read, legacy merge (P2) | `tests/usage-query.test.ts` | `npx vitest run tests/usage-query.test.ts` |
| Daemon IPC and consumer (`src/daemon/daemon.ts`, `src/daemon/protocol.ts`) | integration (daemon seam) | every new or changed method: happy path, dropped observation, replay, release with and without transcript, startup reconcile | `tests/usage-daemon.test.ts`, new `tests/orchestrator-usage-daemon.test.ts` | `npx vitest run tests/usage-daemon.test.ts tests/orchestrator-usage-daemon.test.ts` |
| Driver spawn (`src/drivers/session-driver.ts`) | integration | env with and without `run_id` | `tests/session-runtime.test.ts` pattern, new `tests/run-env.test.ts` | `npx vitest run tests/run-env.test.ts` |
| CLI commands (`src/cli/commands/usage.ts`, `src/cli/commands/usage-backfill.ts`) | integration | argv parsing, invalid `--observe` values not sent, JSON shape | `tests/usage-cli.test.ts`, `tests/usage-backfill.test.ts` | `npx vitest run <file>` |
| Open runtime (`src/open/link-watcher.ts`, `src/open/runtime.ts`, `src/cli/commands/open.ts`) | unit + integration | watcher sends each id once, retries after IPC error, `flush` before release on each exit path, `takeSessionId` returns last line | `tests/link-watcher.test.ts`, `tests/open-contract.test.ts` | `npx vitest run tests/link-watcher.test.ts tests/open-contract.test.ts` |
| Plugin shell (`plugin/hooks/session-id.sh`, `plugin/statusline.sh`) | integration (spawned bash) | hook appends and exits under 500 ms with no daemon; statusline argv, RUN-06 arithmetic, RUN-07 fallback, old-daemon fallback | `tests/session-id-hook.test.ts`, `tests/statusline.test.ts` | `npx vitest run tests/session-id-hook.test.ts tests/statusline.test.ts` |
| Type declarations only | none | build gate only | - | `npx tsc --noEmit` |

## Gate Check Commands

> Generated from codebase - confirm before Execute. The full suite (`npm test`, bare `vitest run`) is never used: every gate names its files.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | after a task whose tests are unit or store integration | `npx vitest run <the task's test files>` |
| Full | after a task that touches the daemon, CLI, open runtime or plugin | `npx tsc --noEmit && npx vitest run <the task's test files> <the matrix files of every layer the task touches>` |
| Build | at the end of each phase | `npm run build && npx vitest run <every test file named in the phase>`, one file per invocation when the list is long |

---

## Execution Plan

Phases run in order. Inside a phase, tasks run in order and arrows show real dependencies. A task may also depend on tasks from an earlier phase.

### Phase 1: Store and pure core

```
T1 -> T2
T1 -> T3
T4 -> T6
T4 -> T7
T5
```

### Phase 2: Daemon integration

```
T8 -> T9 -> T10 -> T11
T12
T13
```

### Phase 3: Clients

```
T14 -> T15
T16 -> T17
T18 -> T19
```

### Phase 4: Backfill (P2)

```
T20 -> T21
```

---

## Task Breakdown

### Phase 1: Store and pure core

### T1: Add usage ledger tables to the schema

**What**: create `usage_sources`, `usage_attributions` and `session_native_links` with the columns in the design Data Models, both FKs `ON DELETE CASCADE`, and an index on `usage_attributions(source_key)`.
**Where**: `src/store/database.ts`
**Depends on**: None
**Reuses**: `CREATE TABLE IF NOT EXISTS` block at `src/store/database.ts:44` and the index lines at 136-137
**Requirement**: ORCH-13, ORCH-15

**Done when**:

- [ ] `tests/usage-schema.test.ts` asserts the three tables and the index on a fresh DB
- [ ] the same test opens a DB created without them, reopens it, and finds them, and a second open does not throw
- [ ] gate passes: `npx vitest run tests/usage-schema.test.ts tests/power-database.test.ts`

**Tests**: integration
**Gate**: quick

---

### T2: Implement UsageLedger

**What**: `observe`, `attributionsFor` and `hasSource` per the design, including the `seed:<sessionId>` path and materialization into `sessions.usage_*`.
**Where**: `src/store/usage-ledger.ts`
**Depends on**: T1
**Reuses**: `SessionStore.update` in `src/store/sessions.ts`
**Requirement**: ORCH-13, ORCH-14, ORCH-15

**Done when**:

- [ ] `tests/usage-ledger.test.ts` replays the 6 steps of the spec worked example and asserts every cell of the table (marks, row A, row B, sum)
- [ ] a lower or equal observation leaves every attribution and the materialized columns unchanged (ORCH-13)
- [ ] an absent field changes nothing, a present field moves independently of the others
- [ ] a row with pre-existing `usage_*` and no attribution keeps its value after the first observation (seed)
- [ ] for every source in the test, `SUM(attributions.cost) = mark.cost` (ORCH-15)
- [ ] gate passes: `npx vitest run tests/usage-ledger.test.ts`

**Tests**: integration
**Gate**: quick

---

### T3: Implement the native link store

**What**: `link`, `unreconciled`, `markReconciled` and `staleOpenRows` per the design.
**Where**: `src/store/native-links.ts`
**Depends on**: T1
**Reuses**: row mapping in `src/store/sessions.ts:56`
**Requirement**: ORCH-03, ORCH-07, ORCH-16

**Done when**:

- [ ] linking two ids to one row keeps both (ORCH-03); linking the same id twice returns `created: false`
- [ ] the second link returns the first id in `previous` while it is unreconciled, and not after `markReconciled` (ORCH-16)
- [ ] `staleOpenRows` returns `interrupted` rows and `working` rows the predicate calls dead, both with an unreconciled link, and nothing else (ORCH-07)
- [ ] gate passes: `npx vitest run tests/native-links.test.ts`

**Tests**: integration
**Gate**: quick

---

### T4: Price Codex cached tokens once

**What**: add `cachedInInput` to `computeSessionCost` and export `cachedInInputFor(agent)`.
**Where**: `src/core/pricing.ts`
**Depends on**: None
**Reuses**: `resolveModelPrice`, `isUsablePrice`
**Requirement**: PRICE-01, PRICE-02, PRICE-03, PRICE-04

**Done when**:

- [ ] `gpt-5.6-luna` with input 1,000,000, cached 900,000, output 0 and `cachedInInput` prices US$ 1.00 (PRICE-01)
- [ ] a model without a cached price uses the input price for cached (PRICE-02)
- [ ] cached above input with `cachedInInput` returns `null` (PRICE-03)
- [ ] without the flag the existing formula and existing `tests/pricing.test.ts` cases still pass (PRICE-04)
- [ ] `cachedInInputFor("codex")` is `true`, `claude`, `antigravity`, `omp`, `opencode` are `false`
- [ ] gate passes: `npx vitest run tests/pricing.test.ts`

**Tests**: unit
**Gate**: quick

---

### T5: Resolve worker source keys

**What**: `workerSourceKey(session, processOrdinal)` returning the prefixed keys from the design, `undefined` for opencode.
**Where**: `src/core/usage-source.ts`
**Depends on**: None
**Reuses**: `Session` from `src/core/session.ts`
**Requirement**: SRC-01, SRC-02, SRC-03

**Done when**:

- [ ] Claude row with native id `n` gives `claude:n#1` and `claude:n#2` for ordinals 1 and 2
- [ ] Codex row gives `codex:<nativeSessionId>`, and `codex:<sessionId>` when the native id is unknown
- [ ] Antigravity and OMP give `session:<sessionId>`, opencode gives `undefined`
- [ ] gate passes: `npx vitest run tests/usage-source.test.ts`

**Tests**: unit
**Gate**: quick

---

### T6: Read Claude transcripts into one observation

**What**: `findTranscript` and `readTranscriptUsage` per the design mapping, streamed with `readline`.
**Where**: `src/core/claude-transcript.ts`
**Depends on**: T4
**Reuses**: cached rule in `src/drivers/claude/parser.ts:117`, `computeSessionCost` from T4
**Requirement**: ORCH-05, ORCH-06, ORCH-08, ORCH-09, ORCH-10, ORCH-11

**Done when**:

- [ ] fixtures under `tests/fixtures/claude-transcript/` (small, hand-made, no real conversation text) cover: two `cost-state` lines where the last wins; no `cost-state` with repeated assistant lines; an unpriced model; a line that is not JSON
- [ ] `cost-state` fixture gives cost = last `totalCostUSD` and the summed `modelUsage` tokens with cached = read + creation (ORCH-05, ORCH-06)
- [ ] no-`cost-state` fixture gives tokens deduped by `message.id` + `requestId` (ORCH-08) and the priced cost (ORCH-09)
- [ ] unpriced fixture gives no cost and state `no-price` (ORCH-10)
- [ ] `findTranscript` over a temp projects dir returns the path, and `undefined` for an absent id (ORCH-11)
- [ ] a generated file above 50 MB is read while `process.memoryUsage().heapUsed` grows by less than 50 MB (edge case)
- [ ] last timestamp and last `cwd` are returned
- [ ] gate passes: `npx vitest run tests/claude-transcript.test.ts`

**Tests**: unit
**Gate**: quick

---

### T7: Split the run aggregate into workers and orchestrator

**What**: new `aggregateRunUsage(runId, sessions, attributions, linkStates)` returning the design `RunUsageSummary`, passing `cachedInInputFor(session.agent)` to pricing.
**Where**: `src/core/run-usage.ts`
**Depends on**: T4
**Reuses**: the existing summing loop in the same file
**Requirement**: RUN-01, RUN-02, RUN-03, RUN-04, RUN-05, ORCH-10, ORCH-11

**Done when**:

- [ ] the spec Independent Test seed (`r1`, open row with `X` 3.00 and `Y` 0.80, workers 0.30 and 0.20) gives `runId` `r1`, top-level `costUsd` 0.50, `sessionCount` 2, `orchestrator.costUsd` 3.80, `total.costUsd` 4.30, `orchestrator.sources` with both ids
- [ ] a run with only the open row gives `sessionCount` 0 and `costComplete` true at the top level (RUN-05)
- [ ] a link state `missing` or `no-price` makes `orchestrator.costComplete` false and leaves the top level untouched
- [ ] NULL origin rows count as workers (RUN-02)
- [ ] existing cases in `tests/usage.test.ts` still pass with the new signature, or are updated only where the top level no longer includes the open row
- [ ] gate passes: `npx vitest run tests/usage.test.ts`

**Tests**: unit
**Gate**: quick

---

### Phase 2: Daemon integration

### T8: Route worker usage through the ledger

**What**: in `updateSessionFromEvent`, compute the process ordinal and the source key, and send non-incremental `usage.updated` to `UsageLedger.observe`; opencode deltas keep the additive path.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T2, T5
**Reuses**: dedup guard and transaction at `src/daemon/daemon.ts:1225-1236`
**Requirement**: SRC-01, SRC-02, SRC-03, SRC-04

**Done when**:

- [ ] feeding the usage events of `2e99` (two processes, 0.4661592 then 0.1616463) gives cost 0.6278055 (SRC-01); the fixture carries only the `system/init` and `result` lines needed, no prompt text
- [ ] two Codex `turn.completed` events for one thread give input 10,891,738 and cached 10,551,808 (SRC-02)
- [ ] opencode incremental events add up (SRC-03)
- [ ] replaying the same log lines leaves usage unchanged (SRC-04)
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/usage-daemon.test.ts tests/opencode-parser.test.ts`

**Tests**: integration
**Gate**: full

---

### T9: Add `session.linkNative` and `usage.get` observe

**What**: new method `session.linkNative`, optional `observe` on `usage.get`, both typed in `RequestMethod`; observations are accepted only on existing `origin = 'open'` rows; `usage.get` returns the T7 shape.
**Where**: `src/daemon/daemon.ts`, `src/daemon/protocol.ts` (one method union line)
**Depends on**: T8, T3, T7
**Reuses**: `usage.get` handler at `src/daemon/daemon.ts:944`, T3 link store, T7 aggregate
**Requirement**: ORCH-01, ORCH-03, ORCH-04, RUN-01, RUN-02, RUN-03, RUN-04

**Done when**:

- [ ] `session.linkNative` links the id to the open row, and two ids stay linked (ORCH-01, ORCH-03)
- [ ] `usage.get` with `observe { nativeId, costUsd }` records it on source `claude-open:<nativeId>` and returns the updated aggregate (ORCH-04)
- [ ] an observation for an unknown run id, or for a row whose origin is not `open`, is dropped without creating a row, and the aggregate is still returned
- [ ] negative or non-finite `costUsd` is rejected
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-daemon.test.ts`

**Tests**: integration
**Gate**: full

---

### T10: Reconcile transcripts on release and on a new link

**What**: private reconcile method on `Daemon`, called from `session.release` for Claude open rows after `setStatus`, and for `previous` ids after a link.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T9, T6
**Reuses**: release handler at `src/daemon/daemon.ts:508`, T6 reader, T3 `markReconciled`
**Requirement**: ORCH-05, ORCH-06, ORCH-11, ORCH-12, ORCH-13, ORCH-14, ORCH-15, ORCH-16

**Done when**:

- [ ] the spec Independent Test replays the worked example with fixture transcripts under a temp `HOME` and asserts row A 10.00, row B 5.00, and `usage.query` `all` orchestrator cost 15.00
- [ ] linking `Y` to a row holding `X` with a `cost-state` of 3.00 attributes 3.00 to `X` before release (ORCH-16)
- [ ] release with no transcript sets the requested `completed` or `failed` and leaves the row without cost (ORCH-11, ORCH-12)
- [ ] a reader that throws is logged, and release still replies with the status set
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/orchestrator-usage-daemon.test.ts tests/release-interrupted.test.ts tests/session-adopt.test.ts`

**Tests**: integration
**Gate**: full

---

### T11: Reconcile stale open rows at daemon start

**What**: after `recover()`, reconcile `staleOpenRows` without blocking startup.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T10, T3
**Reuses**: `recover()` at `src/daemon/daemon.ts:169`, `processAlive`, T10 reconcile method
**Requirement**: ORCH-07

**Done when**:

- [ ] an `interrupted` open row and a `working` open row with a dead pid, both with a fixture transcript, are attributed after daemon start
- [ ] a `working` row whose pid is alive with the same start time is not read
- [ ] a second daemon start does not change totals
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/orchestrator-usage-daemon.test.ts tests/power-recover.test.ts`

**Tests**: integration
**Gate**: full

---

### T12: Add the origin split to the usage query

**What**: `queryUsage` selects `origin`, adds `byOrigin`, and passes `cachedInInputFor(agent)` to pricing.
**Where**: `src/store/sessions.ts`
**Depends on**: T4
**Reuses**: `accumulate` helper in `queryUsage`
**Requirement**: RUN-08, RUN-09, PRICE-01

**Done when**:

- [ ] `byOrigin` has `orchestrator` for `open` rows and `worker` for NULL and other origins (RUN-09)
- [ ] totals include the open row cost (RUN-08)
- [ ] a Codex row with cached inside input is priced once
- [ ] gate passes: `npx vitest run tests/usage-query.test.ts`

**Tests**: integration
**Gate**: quick

---

### T13: Put the run id in worker environments

**What**: add `runId?: string` to `StartOptions`, set it where the daemon starts a driver, and merge `CODEDECK_RUN_ID` into the env in `SessionDriver.start` only when present.
**Where**: `src/drivers/session-driver.ts`
**Depends on**: None
**Reuses**: `getEnv` merge at `src/drivers/session-driver.ts:87`, env merge at `src/drivers/session-runtime.ts:141`
**Requirement**: RUN-10, RUN-11

**Done when**:

- [ ] a stub harness that prints its env shows `CODEDECK_RUN_ID=r1` for a row with run `r1` (RUN-10)
- [ ] a row with no run id gives no `CODEDECK_RUN_ID` (RUN-11)
- [ ] the daemon call site that builds `StartOptions` passes `session.runId` (named in the task report)
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/run-env.test.ts tests/session-runtime.test.ts`

**Tests**: integration
**Gate**: full

---

### Phase 3: Clients

### T14: Add `--observe` and `--by origin` to the usage CLI

**What**: parse `--observe <nativeId>=<cost>`, send it only when the id is a UUID and the cost is finite and non-negative, and add `origin` to the `--by` options.
**Where**: `src/cli/commands/usage.ts`
**Depends on**: T9, T12
**Reuses**: single-run branch at `src/cli/commands/usage.ts:103`
**Requirement**: ORCH-04, RUN-09

**Done when**:

- [ ] a valid `--observe` is sent as `usage.get` `observe`; an invalid value is not sent and the aggregate is still printed
- [ ] `--by origin --json` prints `byOrigin`
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/usage-cli.test.ts`

**Tests**: integration
**Gate**: full

---

### T15: Report cost and compute the run figure in the statusline

**What**: append `--observe <session_id>=<cost>` and compute `run $` per RUN-06, keeping today's formula when `orchestrator` is absent.
**Where**: `plugin/statusline.sh`
**Depends on**: T14
**Reuses**: `getRunUsage` and `runField` at `plugin/statusline.sh:180-235`, shim in `tests/statusline.test.ts`
**Requirement**: ORCH-04, RUN-06, RUN-07

**Done when**:

- [ ] with `session_id` `Y`, payload cost 1.00 and the RUN-03 seed response, the line shows `run $4.50` and the shim argv ends with `--observe Y=1`
- [ ] without `session_id` the argv is exactly `usage <run> --json`, as the existing test asserts
- [ ] a failing shim shows `$1.00` and no `run` (RUN-07)
- [ ] a response without `orchestrator` renders as today
- [ ] gate passes: `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts`

**Tests**: integration
**Gate**: full

---

### T16: Implement the link watcher

**What**: `startLinkWatcher` per the design.
**Where**: `src/open/link-watcher.ts`
**Depends on**: None
**Reuses**: `SESSION_ID_PATTERN` from `src/open/runtime.ts:220`
**Requirement**: ORCH-01, ORCH-03

**Done when**:

- [ ] with fake timers, an id appended to the sidecar is sent within one tick, and never sent twice
- [ ] a rejected `link` is retried on the next tick
- [ ] `flush()` sends pending ids and resolves; `stop()` clears the timer
- [ ] invalid lines are ignored
- [ ] gate passes: `npx vitest run tests/link-watcher.test.ts`

**Tests**: unit
**Gate**: quick

---

### T17: Start the watcher in `open` and flush before release

**What**: start the watcher where `runId` and `sessionFile` are known, and await `flush()` before `finishOpenSession` on each exit path (`open.ts:652`, `752`, `818`, `852`).
**Where**: `src/cli/commands/open.ts`
**Depends on**: T16, T9
**Reuses**: `client.request` already in scope at each exit path
**Requirement**: ORCH-01, ORCH-16

**Done when**:

- [ ] `tests/open-contract.test.ts` (or the open harness in `tests/helpers/open-harness.ts`) asserts `session.linkNative` precedes `session.release` on the Claude path
- [ ] the report lists each exit path and the line where `flush()` runs
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/open-contract.test.ts tests/open-pty.test.ts`

**Tests**: integration
**Gate**: full

---

### T18: Append ids in the SessionStart hook

**What**: `printf '%s\n' "$id" >> "$target"` instead of overwriting.
**Where**: `plugin/hooks/session-id.sh`
**Depends on**: None
**Reuses**: the current script
**Requirement**: ORCH-02, ORCH-03

**Done when**:

- [ ] two runs with two ids leave both lines in the file
- [ ] with `CODEDECK_RUN_ID` set and no daemon socket, the hook exits 0 in under 500 ms and writes the file (ORCH-02)
- [ ] without `CODEDECK_SESSION_FILE` it writes nothing and exits 0
- [ ] gate passes: `npx vitest run tests/session-id-hook.test.ts`

**Tests**: integration
**Gate**: full

---

### T19: Read the last id in `takeSessionId`

**What**: return the last line that matches `SESSION_ID_PATTERN`, so the resume hint names the latest session.
**Where**: `src/open/runtime.ts`
**Depends on**: T18
**Reuses**: `takeSessionId` at `src/open/runtime.ts:243`
**Requirement**: ORCH-03

**Done when**:

- [ ] a two-line sidecar gives the second id and removes both `.name` sidecars that exist
- [ ] a single-line file without a trailing newline still works
- [ ] gate passes: `npx vitest run tests/open-contract.test.ts tests/open-action.test.ts`

**Tests**: integration
**Gate**: full

---

### Phase 4: Backfill (P2)

### T20: Store legacy entries and merge them into the usage query

**What**: add the `usage_legacy` table and merge its rows into `queryUsage` totals, `byDay`, `byRepository`, `byModel`, `byAgent` (`claude`) and the `orchestrator` bucket, never `byRun`.
**Where**: `src/store/sessions.ts` (table creation in `src/store/database.ts`)
**Depends on**: T12
**Reuses**: `accumulate` and `normalizeProjectName` in `queryUsage`
**Requirement**: BF-05, BF-06, BF-07

**Done when**:

- [ ] a seeded legacy row appears under its `endedAt` date in `byDay`, under its repository in `byRepository`, and in `byOrigin` `orchestrator`
- [ ] it does not appear in `byRun` or in `session.list`
- [ ] gate passes: `npx vitest run tests/usage-query.test.ts tests/usage-schema.test.ts`

**Tests**: integration
**Gate**: quick

---

### T21: Add `codedeck usage backfill`

**What**: the backfill command per the design, one transaction per id writing the legacy row and the `claude-open:` mark.
**Where**: `src/cli/commands/usage-backfill.ts`
**Depends on**: T20, T2, T6
**Reuses**: T6 reader, T2 `hasSource`, sidecar naming from `src/cli/commands/open.ts:572`
**Requirement**: BF-01, BF-02, BF-03, BF-04, BF-08

**Done when**:

- [ ] the spec Independent Test: a fixture sessions dir with three ids, one of them a worker native id, gives two legacy entries (BF-01, BF-02, BF-04)
- [ ] an id that already has a mark is skipped (BF-03)
- [ ] a second run leaves `usage.query` `all` totals identical (BF-08)
- [ ] sidecars are read, not deleted
- [ ] gate passes: `npx tsc --noEmit && npx vitest run tests/usage-backfill.test.ts`

**Tests**: integration
**Gate**: full

---

## Phase Execution Map

```
Phase 1 -> Phase 2 -> Phase 3 -> Phase 4

Phase 1:  T1 -> T2
          T1 -> T3
          T4 -> T6
          T4 -> T7
          T5 (no dependency)
Phase 2:  T8 -> T9 -> T10 -> T11
          T12 (no in-phase dependency)
          T13 (no dependency)
Phase 3:  T14 -> T15
          T16 -> T17
          T18 -> T19
Phase 4:  T20 -> T21
```

Close of Execute: `npm run build:plugin` so the hook and statusline edits reach `dist/plugin`, then the mutation probe from the orchestrator contract.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1 | 3 tables in one schema block | ⚠️ cohesive, one file |
| T2 | 1 module | ✅ |
| T3 | 1 module | ✅ |
| T4 | 1 function plus 1 helper | ✅ |
| T5 | 1 function | ✅ |
| T6 | 2 functions, one module | ✅ |
| T7 | 1 function | ✅ |
| T8 | 1 handler branch | ✅ |
| T9 | 2 IPC methods plus their union type | ⚠️ cohesive, `protocol.ts` is one line |
| T10 | 1 method plus 2 call sites | ✅ |
| T11 | 1 call site | ✅ |
| T12 | 1 function | ✅ |
| T13 | 1 env merge plus 1 option field | ✅ |
| T14 | 1 command | ✅ |
| T15 | 1 script | ✅ |
| T16 | 1 module | ✅ |
| T17 | 1 wiring change, 4 exit paths | ✅ |
| T18 | 1 script line | ✅ |
| T19 | 1 function | ✅ |
| T20 | 1 table plus 1 query merge | ⚠️ cohesive, the table exists only for this query |
| T21 | 1 command | ✅ |

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | none | ✅ |
| T2 | T1 | T1 -> T2 | ✅ |
| T3 | T1 | T1 -> T3 | ✅ |
| T4 | None | none | ✅ |
| T5 | None | none | ✅ |
| T6 | T4 | T4 -> T6 | ✅ |
| T7 | T4 | T4 -> T7 | ✅ |
| T8 | T2, T5 (phase 1) | cross-phase | ✅ |
| T9 | T8; T3, T7 (phase 1) | T8 -> T9 | ✅ |
| T10 | T9; T6 (phase 1) | T9 -> T10 | ✅ |
| T11 | T10; T3 (phase 1) | T10 -> T11 | ✅ |
| T12 | T4 (phase 1) | cross-phase | ✅ |
| T13 | None | none | ✅ |
| T14 | T9, T12 (phase 2) | cross-phase | ✅ |
| T15 | T14 | T14 -> T15 | ✅ |
| T16 | None | none | ✅ |
| T17 | T16; T9 (phase 2) | T16 -> T17 | ✅ |
| T18 | None | none | ✅ |
| T19 | T18 | T18 -> T19 | ✅ |
| T20 | T12 (phase 2) | cross-phase | ✅ |
| T21 | T20; T2, T6 (phase 1) | T20 -> T21 | ✅ |

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Schema / migration | integration | integration | ✅ |
| T2 | Store modules | integration | integration | ✅ |
| T3 | Store modules | integration | integration | ✅ |
| T4 | Pure core | unit | unit | ✅ |
| T5 | Pure core | unit | unit | ✅ |
| T6 | Pure core | unit | unit | ✅ |
| T7 | Pure core | unit | unit | ✅ |
| T8 | Daemon consumer | integration | integration | ✅ |
| T9 | Daemon IPC | integration | integration | ✅ |
| T10 | Daemon IPC | integration | integration | ✅ |
| T11 | Daemon startup | integration | integration | ✅ |
| T12 | Usage query | integration | integration | ✅ |
| T13 | Driver spawn | integration | integration | ✅ |
| T14 | CLI commands | integration | integration | ✅ |
| T15 | Plugin shell | integration | integration | ✅ |
| T16 | Open runtime | unit + integration | unit | ✅ (watcher is pure with injected `link` and fake timers) |
| T17 | Open runtime | unit + integration | integration | ✅ |
| T18 | Plugin shell | integration | integration | ✅ |
| T19 | Open runtime | unit + integration | integration | ✅ |
| T20 | Schema + usage query | integration | integration | ✅ |
| T21 | CLI commands | integration | integration | ✅ |
