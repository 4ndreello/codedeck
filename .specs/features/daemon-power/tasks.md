# Daemon Power Graceful Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: none (decisions embedded in `spec.md` Assumptions table, reviewer-validated)
**Spec**: `.specs/features/daemon-power/spec.md`
**Status**: Done

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: none (`AGENTS.md`, `CONTRIBUTING.md`, docs testing guides absent; `vitest.config.ts` sets `tests/**/*.test.ts`, node env, `node:sqlite` shim) - strong defaults applied.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Core domain (`src/core/`) | unit | All branches; 1:1 to spec ACs | `tests/*.test.ts` (co-located by feature, e.g. `tests/power-status.test.ts`) | `npx vitest run tests/<name>.test.ts` |
| Store (`src/store/`) | unit (via `tests/helpers/node-sqlite-shim.ts`) | Key query paths + pragma applied + error paths | `tests/*.test.ts` | `npx vitest run tests/<name>.test.ts` |
| Daemon (`src/daemon/daemon.ts`) | unit with fakes (drivers/stores stubbed) | Happy path + every listed edge case + error/failure paths | `tests/*.test.ts` | `npx vitest run tests/<name>.test.ts` |
| Drivers (`src/drivers/tailer.ts`) | unit | All branches; 1:1 to spec ACs; every listed edge case has a test | `tests/*.test.ts` | `npx vitest run tests/<name>.test.ts` |
| CLI (`src/cli/`) | unit with fakes (FakeWaitClient pattern in `tests/wait.test.ts`) | Happy + edge + error paths per touched command | `tests/*.test.ts` | `npx vitest run tests/<name>.test.ts` |
| Docs (`README.md`) | none | - (build gate only) | - | build gate only |

## Gate Check Commands

> Generated from codebase - confirm before Execute. No lint script exists; typecheck is `tsc` via build.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npx vitest run tests/<name>.test.ts` |
| Full | After tasks with e2e/integration tests | `npm test` |
| Build | After phase completion or config/entity-only tasks | `npm run build && npm test` |

**Mid-flight rule for parallel workers:** workers run ONLY their own task's Quick gate (`npx vitest run` on their own test file) and MUST NOT run `npm test`/`npm run build` until the integration owner signals merge. Full build+suite runs once at the end (orchestrator). Workers coordinate file ownership via `hub` (see Contracts).

---

## Cross-Worker Contracts (parallel execution)

The user overrode sequential batching: three workers run in parallel with file ownership below. These contracts are fixed upfront and MUST NOT be renegotiated mid-flight:

1. `SessionStatus` gains exactly `"interrupted"`; `isTerminalStatus` returns true for it; `isActiveStatus` unchanged (owner: Worker-Found, T1).
2. `FailureCode` gains exactly `"SHUTDOWN"`; `exitCodeForOutcome({status:"interrupted", failure:{blame:"infra"}})` returns `3` (owner: Worker-Found, T2).
3. Shutdown persists ONE `session.failed` event with `failure: {code:"SHUTDOWN", blame:"infra", retryable:true}` + `sessions.setStatus(id, "interrupted")`. No new event type, ever (owner: Worker-Daemon, T4).
4. `recover()` MUST ignore rows with `status="interrupted"` (no reattach, no status flip) — follows from `listActive()` only returning `starting|working|needs_input|idle` (owner: Worker-Daemon, T5).
5. `doctor` Power fields: `{ serviceInstalled: boolean, inhibitAvailable: boolean }` on the `doctor` IPC result (owner: Worker-CLI, T10; producer of `serviceInstalled`/`inhibitAvailable` is Worker-Daemon's doctor-handler change in T4 — field names fixed here).

Handshake: Worker-Daemon and Worker-CLI MUST wait for Worker-Found's `hub` message `TYPES_LANDED` before running any gate (types don't exist until T1+T2 commit). File ownership is exclusive — no two workers touch the same file.

---

## Execution Plan

Phases are ordered by dependency; workers run in parallel under the contracts above (user-approved deviation from strictly sequential batches).

### Phase 1: Foundation

Types, failure codes, and SQLite hardening. No dependencies.

```
T1 → T2
T3
```

### Phase 2: Daemon core

Graceful shutdown, recover, send admission, tailer drain, inhibit child. Depends on Phase 1 contracts.

```
T4 → T5 → T6 → T7 → T8
```

### Phase 3: Presentation

CLI surfaces and docs. Depends on Phase 1 contracts.

```
T9 → T10 → T11
```

---

## Task Breakdown

### T1: Add interrupted status

**What**: Add `"interrupted"` to `SessionStatus` and include it in `isTerminalStatus`.
**Where**: `src/core/session.ts`
**Depends on**: None
**Reuses**: Existing union + `isTerminalStatus`/`isActiveStatus` pattern
**Requirement**: PWR-01

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `isTerminalStatus("interrupted")` is true; `isActiveStatus("interrupted")` is false
- [ ] No other status changes behavior
- [ ] Gate check passes: `npx vitest run tests/power-status.test.ts`
- [ ] Test count: ≥3 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): add interrupted session status`

---

### T2: Add SHUTDOWN failure code and exit mapping

**What**: Add `"SHUTDOWN"` failure code and map `interrupted`+infra to exit 3.
**Where**: `src/core/errors.ts`
**Depends on**: T1
**Reuses**: `classifyFailure`/`exitCodeForOutcome` structure
**Requirement**: PWR-01

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `exitCodeForOutcome({status:"interrupted", failure:{blame:"infra"}})` returns 3
- [ ] Existing mappings (`failed`/`orphaned` branches) unchanged
- [ ] Gate check passes: `npx vitest run tests/power-shutdown-code.test.ts`
- [ ] Test count: ≥4 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): map interrupted infra outcome to exit 3`

---

### T3: Harden SQLite pragmas and checkpoint on close

**What**: Apply `busy_timeout`/`synchronous`/`wal_autocheckpoint` in `migrate()` and `wal_checkpoint(TRUNCATE)` in `close()`.
**Where**: `src/store/database.ts`
**Depends on**: None
**Reuses**: Existing `migrate()` pragma block
**Requirement**: PWR-04

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `PRAGMA busy_timeout=5000`, `synchronous=NORMAL`, `wal_autocheckpoint=1000` applied on open
- [ ] `close()` runs `wal_checkpoint(TRUNCATE)` (best-effort try/catch) before closing
- [ ] Gate check passes: `npx vitest run tests/power-database.test.ts`
- [ ] Test count: ≥2 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): harden sqlite wal handling`

---

### T4: Graceful shutdown core

**What**: Implement `handleShutdown(reason)` with sync guard flag, `once` signal wiring (`SIGTERM`/`SIGINT`/`SIGHUP`), `SERVICE_UNAVAILABLE` guard in `handleRequest`, `daemon.stop` route, parallel per-session `interrupted` persist + `killTree` (grace 1500, `expectedStartTime`), PASSIVE-then-TRUNCATE checkpoint; remove `process.on("exit")` handler.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T1, T2, T3
**Reuses**: `sessionLocks`, `killTree`, `attachDriverEvents` lock-skip at `daemon.ts:630`
**Requirement**: PWR-02

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] Double `SIGTERM` runs flush exactly once
- [ ] Each active session gets ONE `session.failed` (SHUTDOWN/infra/retryable) + status `interrupted`
- [ ] `handleRequest` during shutdown returns `SERVICE_UNAVAILABLE`
- [ ] `daemon.stop` IPC routes to `handleShutdown`
- [ ] Gate check passes: `npx vitest run tests/power-shutdown.test.ts`
- [ ] Test count: ≥6 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): add graceful shutdown on sigterm`

---

### T5: Recover ignores interrupted sessions

**What**: Ensure `recover()` never reattaches or flips rows with `status="interrupted"`; surviving processes stay untracked orphans by design.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T4
**Reuses**: `listActive()` active-status filter
**Requirement**: PWR-03

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] Seeded `interrupted` row with live PID is left untouched (no reattach, no status change)
- [ ] `pid_reused` classification for active rows unchanged
- [ ] Gate check passes: `npx vitest run tests/power-recover.test.ts`
- [ ] Test count: ≥3 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): leave interrupted rows alone in recover`

---

### T6: Send admission for interrupted sessions

**What**: Allow `session.send` on `interrupted` with `nativeSessionId` + `resume:true` driver; identity-checked liveness (`processAlive` + `pidStartTime` equality) returns `SESSION_BUSY`; missing capability returns `CAPABILITY_NOT_SUPPORTED` before liveness.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T5
**Reuses**: `stop` command `liveIdentity` check pattern
**Requirement**: PWR-08

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `send` on `interrupted` without `nativeSessionId` returns `CAPABILITY_NOT_SUPPORTED`
- [ ] `send` on `interrupted` with live matching PID returns `SESSION_BUSY`
- [ ] `send` on `interrupted` with recycled PID (start mismatch) proceeds to resume path
- [ ] Gate check passes: `npx vitest run tests/power-send.test.ts`
- [ ] Test count: ≥4 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): allow send resume from interrupted`

---

### T7: Discard truncated tail line on shutdown drain

**What**: Shutdown drain discards a trailing partial line (no `\n`) without emitting `error` or synthesized `failed`; normal `flush()` behavior unchanged.
**Where**: `src/drivers/tailer.ts`
**Depends on**: T6
**Reuses**: `flush()`/`finishPartial()` structure
**Requirement**: PWR-03

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] Shutdown-drain path drops unterminated trailing bytes silently
- [ ] Normal `flush()` still emits leftover exactly as before
- [ ] Gate check passes: `npx vitest run tests/power-tailer.test.ts`
- [ ] Test count: ≥3 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): drop truncated line on shutdown drain`

---

### T8: Best-effort systemd-inhibit child

**What**: Spawn `systemd-inhibit --what=shutdown:sleep --who=CodeDeck --why="flush sessions" --mode=delay sleep infinity` in `start()` when the binary exists; kill after `TRUNCATE`, before `db.close()`; silent no-op when absent.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T7
**Reuses**: `ensureDirs`/`getPaths` startup sequence
**Requirement**: PWR-10

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] With stubbed `PATH` containing fake `systemd-inhibit`, child spawns with exact argv and dies after `TRUNCATE`
- [ ] With `PATH` lacking it, startup and shutdown behave exactly as T4
- [ ] Gate check passes: `npx vitest run tests/power-inhibit.test.ts`
- [ ] Test count: ≥2 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): hold delay inhibitor during drain`

---

### T9: Present interrupted in ps, show, wait, help

**What**: `ps` renders `⏻ interrupted`, `show --json` includes `failure.code`, `wait` exits 3 immediately, `run --help` documents poweroff→`interrupted`→`send` in ≤3 lines.
**Where**: `src/cli/commands/ps.ts`
**Depends on**: T1, T2
**Reuses**: `wait.test.ts` FakeWaitClient pattern; existing status renderers
**Requirement**: PWR-06

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `ps` output contains `⏻` for seeded `interrupted` session
- [ ] `wait` on `interrupted` resolves without subscribing and maps to exit 3
- [ ] `show --json` output contains `failure.code="SHUTDOWN"`
- [ ] Gate check passes: `npx vitest run tests/power-ps.test.ts`
- [ ] Test count: ≥4 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): surface interrupted in cli`

---

### T10: Doctor power section

**What**: `doctor` IPC result gains `{serviceInstalled, inhibitAvailable}`; CLI prints a `Power` section via `which systemd-inhibit` + unit-file existence (no systemd calls, no root).
**Where**: `src/cli/commands/doctor.ts`
**Depends on**: T9
**Reuses**: Existing `check()` renderer and `doctor` IPC flow
**Requirement**: PWR-07

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `doctor --json` includes `power: {serviceInstalled, inhibitAvailable}` booleans
- [ ] Human output prints `Power` section without crashing when systemd is absent
- [ ] Gate check passes: `npx vitest run tests/power-doctor.test.ts`
- [ ] Test count: ≥2 tests pass (no silent deletions)

**Tests**: unit
**Gate**: quick
**Commit**: `feat(power): report power readiness in doctor`

---

### T11: Document power behavior in README

**What**: README section covering `interrupted` status, exit code 3, `send` resume, and best-effort inhibit (no setup promises).
**Where**: `README.md`
**Depends on**: T10
**Reuses**: Existing session/exit-code tables
**Requirement**: PWR-06

**Tools**:

- MCP: NONE
- Skill: tlc-spec-driven

**Done when**:

- [ ] `interrupted` row present in status documentation with resume command
- [ ] Exit-code table documents 3 for `interrupted`/infra
- [ ] Gate check passes: `npm run build && npm test`

**Tests**: none
**Gate**: build
**Commit**: `docs(power): document interrupted status and resume`

---

## Phase Execution Map

Phases run in order within each worker; workers run in parallel under Cross-Worker Contracts (user-approved).

```
Phase 1:  T1 → T2                 (Worker-Found)
Phase 1:  T3                      (Worker-Found)
Phase 2:  T4 → T5 → T6 → T7 → T8 (Worker-Daemon)
Phase 3:  T9 → T10 → T11         (Worker-CLI)
T1 → T4
T2 → T4
T3 → T4
T1 → T9
T2 → T9
```

Execution is parallel across workers, sequential within each worker. One worker owns one phase; file ownership is exclusive per Contracts. Integration owner: Worker-Daemon (merges last, runs final `npm run build && npm test` before reporting).

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: interrupted status | 1 type + 1 function | ✅ Granular |
| T2: SHUTDOWN code + exit map | 1 function + 1 branch | ✅ Granular |
| T3: SQLite pragmas | 1 file, 2 spots | ✅ Granular |
| T4: shutdown core | 1 file, 1 method + wiring | ✅ Granular |
| T5: recover skip | 1 file, 1 guard | ✅ Granular |
| T6: send admission | 1 file, 1 branch | ✅ Granular |
| T7: tailer drain discard | 1 file, 1 path | ✅ Granular |
| T8: inhibit child | 1 file, spawn + kill | ✅ Granular |
| T9: CLI surfaces | 1 file + help text | ✅ Granular |
## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | Phase 1 head | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | None | Phase 1 head | ✅ Match |
| T4 | T1, T2, T3 | T1 → T4, T2 → T4, T3 → T4 | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |
| T7 | T6 | T6 → T7 | ✅ Match |
| T8 | T7 | T7 → T8 | ✅ Match |
| T9 | T1, T2 | T1 → T9, T2 → T9 | ✅ Match |
| T10 | T9 | T9 → T10 | ✅ Match |
| T11 | T10 | T10 → T11 | ✅ Match |

No task depends on a later phase. Cross-phase deps (T4 on Phase 1, T9 on Phase 1) are satisfied by contracts + `TYPES_LANDED` handshake.

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Core domain | unit | unit | ✅ OK |
| T2 | Core domain | unit | unit | ✅ OK |
| T3 | Store | unit | unit | ✅ OK |
| T4 | Daemon | unit | unit | ✅ OK |
| T5 | Daemon | unit | unit | ✅ OK |
| T6 | Daemon | unit | unit | ✅ OK |
| T7 | Drivers | unit | unit | ✅ OK |
| T8 | Daemon | unit | unit | ✅ OK |
| T9 | CLI | unit | unit | ✅ OK |
| T10 | CLI | unit | unit | ✅ OK |
| T11 | Docs | none | none | ✅ OK |

---

## Execution Record

Executed 2026-09-05 by 3 parallel workers (file ownership exclusive, contracts upfront). Full gate after merge: `npm run build` clean, `npm test` 26 files / 144 tests green.

| Task | Commit | Tests |
| ---- | ------ | ----- |
| T1 | c674b2c `feat(power): add interrupted session status` | 4 |
| T2 | 6a27aae `feat(power): map interrupted infra outcome to exit 3` | 4 |
| T3 | 1de1eff `feat(power): harden sqlite wal handling` | 2 |
| T4 | 942bc9c `feat(power): add graceful shutdown on sigterm` | 9 |
| T5 | 4910540 `feat(power): leave interrupted rows alone in recover` | 4 |
| T6 | 2e4dc13 `feat(power): allow send resume from interrupted` | 5 |
| T7 | 4f5ff85 `feat(power): drop truncated line on shutdown drain` | 4 |
| T8 | d948427 `feat(power): hold delay inhibitor during drain` | 2 |
| T9 | e0d4a3a `feat(power): surface interrupted in cli` | 6 |
| T10 | 887890f `feat(power): report power readiness in doctor` | 5 |
| T11 | 55bc1ef `docs(power): document interrupted status and resume` | 0 (docs) |

Deviations from skill process (user-approved): workers ran in parallel instead of sequential batches; tasks.md/spec.md bookkeeping done by orchestrator in one follow-up commit instead of per-task commits (avoids same-file merge conflicts); final `npm run build && npm test` run once by orchestrator instead of per-task Build gates.
