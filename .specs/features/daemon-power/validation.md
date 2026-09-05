# Validation: daemon-power (independent)

- **Date**: 2026-09-05
- **Verifier**: PowerVerifier (independent; did not participate in implementation; all conclusions re-derived from code/tests, not inherited from authors)
- **Scope**: `git log origin/main..HEAD` = 12 commits `c674b2c..46fafa2` (11 feature + 1 bookkeeping `46fafa2 chore(power): record daemon-power execution`), plus `tests/power-*.test.ts`.
- **Method**: evidence-or-zero per AC (assertion text + `file:line` compared to the spec's stated outcome; payload/conjunction rule applied — value/state asserted, not just "was called"); behavior-fault discrimination sensor in scratch copies; gates executed.
- **Tree state note**: `M src/cli/commands/ps.ts` (MODEL column) is uncommitted and out of scope for this feature. Observation: it does not affect any feature test — `tests/power-ps.test.ts` asserts containment only (`toContain("⏻")`, `toContain("interrupted")`, `not.toContain("dead")`), no exact-header/payload assertion; the full suite is green with this working-tree change present.
- **Result**: PASS (transcribed from ## Verdict below; verifier's stated verdict, not altered)

## Verdict: **PASS** (with spec-precision / coverage gaps documented, ranked below)

All 10 requirements (PWR-01..PWR-10) have their observable outcomes implemented and asserted at value level; build and full suite are green; the sensor kills the core fault injections (6/8 distinct faults, incl. a compound). Survivors localize to two structural coverage gaps (signal wiring; defense-in-depth redundancy), not to implementation defects.

## Gates

| Gate | Command | Exit | Result |
| ---- | ------- | ---- | ------ |
| Build | `npm run build` (tsc) | 0 | clean |
| Feature tests | `npx vitest run` on 10 `tests/power-*.test.ts` | 0 | 10 files / **45 tests passed** (matches tasks.md Execution Record per-task counts 4+4+2+9+4+5+4+2+6+5=45) |
| Full suite | `npm test` | 0 | 26 files / **144 tests passed** |

## Commit range verified

`origin/main..HEAD` → `c674b2c` (T1 interrupted status) → `6a27aae` (T2) → `1de1eff` (T3) → `e0d4a3a` (T9) → `887890f` (T10) → `55bc1ef` (T11 docs) → `942bc9c` (T4) → `4910540` (T5) → `2e4dc13` (T6) → `4f5ff85` (T7) → `d948427` (T8) → `46fafa2` (bookkeeping). Diff: 23 files, +1916/−34.

## AC-by-AC traceability

Legend: ✅ covered (asserted value == spec outcome) · ⚠️ partial / spec-precision gap · ❌ not covered by test (code evidence only).

### PWR-01 — P1 shutdown graceful (story P1 #1)

| AC | Assertion | Spec outcome | Covered |
| -- | --------- | ------------ | ------- |
| 1. SIGTERM → sync `shuttingDown` + `handleShutdown("SIGTERM")` exactly once | `tests/power-shutdown.test.ts:101` `expect(events.list("s-race", 100)).toHaveLength(1)`; `:102` status `interrupted` — under concurrent `handleShutdown("SIGTERM"/"SIGTERM"/"SIGINT")` | exactly-once drain; ONE event | ✅ (exactly-once via shared `shutdownPromise`, daemon.ts:841-847). Wiring itself untested → gap #1/#7 |
| 2. WHILE `shuttingDown` reject with `SERVICE_UNAVAILABLE` | `tests/power-shutdown.test.ts:113` `expect(JSON.parse(writes[0]).error).toMatchObject({ code: "SERVICE_UNAVAILABLE" })` | rejection with that exact code | ✅ (sensor M7 killed) |
| 3. ONE `session.failed` `{code:SHUTDOWN, blame:infra, retryable:true}` + `setStatus(interrupted)` per active session | `tests/power-shutdown.test.ts:70-75`: status `toBe("interrupted")`, `failure` `toMatchObject({code:"SHUTDOWN",blame:"infra",retryable:true})`, `list` `toHaveLength(1)`, type `session.failed`, event `failure` same matchObject; 2 seeded sessions both asserted | value-level payload + status per session | ✅ (sensor M1 killed ×6). Gap: `sessionLocks` acquisition itself not directly asserted (mechanism unobserved; terminal-frame effect covered by :177-179) |
| 4. `killTree(graceMs=1500, expectedStartTime=<known pidStartTime>)`, parallel, PID-bearing sessions only | `tests/power-shutdown.test.ts:86-87` `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(424242, 1500, "tick-9")` (pid-less row skipped) | exact args incl. identity | ✅ (sensor M2 killed). Gap: `Promise.allSettled` parallelism / "5+ sessions <5s" edge unasserted |
| 5. `wal_checkpoint(PASSIVE)` before kill, `TRUNCATE` after, before `db.close()` | `tests/power-shutdown.test.ts:150-151`: `passive ≥ 0`, `truncate > passive` (exec-call order spy); TRUNCATE-before-close implicitly via reopen in other tests | order PASSIVE → kill → TRUNCATE → close | ⚠️ partial: PASSIVE<TRUNCATE pinned; kill-in-between and TRUNCATE-before-`db.close()` not directly asserted (code order daemon.ts:853-871) |
| 6. Repeated signals ignored without restarting flush | `tests/power-shutdown.test.ts:101` (SIGTERM+SIGTERM+SIGINT concurrent → 1 event) | single drain | ✅ for cross-signal repeats. ⚠️ spec-precision: AC9 mandates `process.once`, so a repeated *same* signal after listener consumption hits the default disposition (process death mid-drain) — untested; internal tension AC6 vs AC9 (P3) |
| 7. Open `BEGIN` → ROLLBACK/COMMIT before close, never close mid-transaction | `tests/power-shutdown.test.ts:162`: seeded `BEGIN` then drain → status `interrupted` persisted | durable writes despite stale BEGIN | ✅ (`ROLLBACK` best-effort first, daemon.ts:853) |
| 8. `handleShutdown` testable without systemd/logind | exercised by every test in `power-shutdown`/`power-inhibit` (direct method calls, no socket/systemd) | method-level testability | ✅ |
| 9. `process.on("exit")` removed; SIGTERM/SIGINT/SIGHUP via `process.once` | — (no test) | code evidence only | ❌ test gap: daemon.ts:87-89 registers `process.once` ×3, no `exit` handler (P3) |

### PWR-04 — SIGHUP + SQLite pragmas (story P1 #2)

| AC | Assertion | Spec outcome | Covered |
| -- | --------- | ------------ | ------- |
| 1. SIGHUP → same `handleShutdown("SIGHUP")` | — (no test) | code evidence: daemon.ts:89 `process.once("SIGHUP", () => this.onSignal("SIGHUP"))` → same `onSignal` → `handleShutdown` (daemon.ts:800-805) | ❌ test gap (sensor M6 survived; P2) |
| 2. `PRAGMA busy_timeout=5000` in `migrate()` | `tests/power-database.test.ts:19` `expect(Object.values(busy)[0]).toBe(5000)` | 5000 | ✅ |
| 3. concurrent writers wait ≤5s instead of `SQLITE_BUSY` | `tests/power-database.test.ts:19-23`: busy_timeout 5000, synchronous 1 (NORMAL), wal_autocheckpoint 1000 | no-`SQLITE_BUSY` under concurrency | ⚠️ spec-precision: pragma-level only; the spec's independent two-process concurrency test was not implemented |

### PWR-06 — pós-reboot honesto (story P2 #1)

| AC | Assertion | Spec outcome | Covered |
| -- | --------- | ------------ | ------- |
| 1. `ps` lists `interrupted` with `⏻` distinct from `failed` | `tests/power-ps.test.ts:59-60` `toContain("⏻")` + `toContain("interrupted")`; `:65-66` pid long gone → still `⏻`, `not.toContain("dead")` | symbol + label, liveness-stable | ✅ (impl `ps.ts:52`) |
| 2. `show --json`: `status=interrupted` + `failure.code=SHUTDOWN` | `tests/power-ps.test.ts:93` `expect(JSON.parse(json).session.failure.code).toBe("SHUTDOWN")` | payload-level code in JSON | ✅ |
| 3. `wait <id>` returns immediately, exit 3 | `tests/power-ps.test.ts:74-76`: status `interrupted`, `subscribeCount === 0`, `exitCodeForOutcome(session) === 3`; exact rendering `:80` `"✗ Session a83f interrupted [infra, retryable]"`; unit root `power-shutdown-code.test.ts:6-9` | immediate terminal exit 3 (infra) | ✅ (impl `wait.ts:12`, `errors.ts:157-160`) |
| 4. `doctor` Power section: service unit existence + `systemd-inhibit` via `which`, no root | `tests/power-doctor.test.ts:13-18` (daemon payload passthrough both-true/false), `:23-24` (fallback booleans), `:31` (missing unit → false), `:40-42` (renders `Power`/`inhibit`/`systemd-inhibit not found` w/o crash), `:47-48` (✓ when installed); daemon-side `power-shutdown.test.ts:188-189` | section with both booleans | ✅ (impl `doctor.ts:15-35,82,133`; daemon `daemon.ts` doctor case `power:{...}`). ⚠️ minor: `inhibitAvailable=true` via a real `which` hit not exercised end-to-end (rendering asserted only) |
| 5. `run --help` documents poweroff→`interrupted`→`send` in ≤3 lines | `tests/power-ps.test.ts:104-105` `toContain("interrupted")`, `toContain("codedeck send")` | ≤3-line doc | ⚠️ spec-precision: content asserted; the ≤3-line bound is not asserted (impl adds exactly 2 lines, `run.ts:34-35`) |

### PWR-08/09 — Resume manual via send (story P2 #2)

| AC | Assertion | Spec outcome | Covered |
| -- | --------- | ------------ | ------- |
| 1. resume with `nativeSessionId` + `resume:true` + no live identity → new turn with resume identity, same cwd/worktree | `tests/power-send.test.ts:139-143`: `error` undefined, `sent[0].message === "continue"`, `sent[0].session.nativeSessionId === "n-3"`, status `working` — past a recycled PID (start mismatch) | resume proceeds with native id | ✅ at the daemon↔driver seam. ⚠️ spec-precision: the literal `--resume <nativeId>` argv and cwd/worktree propagation live below the seam (driver layer) and are not asserted here |
| 2. no `nativeSessionId` OR `resume:false` → `CAPABILITY_NOT_SUPPORTED` before liveness | `tests/power-send.test.ts:90-91` (no native id); `:107-108` (**live matching PID** seeded, driver `resume:false` → still CAPABILITY first, `sent` empty) | precedence over liveness | ✅ |
| 3. live `processAlive(pid)` ∧ `processStartTime(pid)=pidStartTime` → `SESSION_BUSY` even when `interrupted` | `tests/power-send.test.ts:123-124` `SESSION_BUSY`, `sent` empty; `:158-159` non-interrupted `working` busy check unchanged | identity-checked busy | ✅ |

### PWR-10 — Delay-lock best-effort (story P3)

| AC | Assertion | Spec outcome | Covered |
| -- | --------- | ------------ | ------- |
| 1. exact argv `systemd-inhibit --what=shutdown:sleep --who=CodeDeck --why="flush sessions" --mode=delay sleep infinity`; child dies after TRUNCATE, before close | `tests/power-inhibit.test.ts:92-95` exact argv string equality; `:116` `inhibitChild === null` after drain; `:124` `deathAt >= truncateAt`; `:125` status `interrupted` | argv + kill-after-TRUNCATE ordering | ✅ |
| 2. absent binary → silent no-op, shutdown unchanged | `tests/power-inhibit.test.ts:136` `inhibitChild === null` with PATH lacking binary; `:141` status `interrupted` after drain | silent no-op | ✅ |
| 3. flush exceeding `InhibitDelayMaxSec` still leaves `interrupted` persisted | — (no timing simulation) | persisted-before-kill | ⚠️ partial: `markInterrupted` loop (daemon.ts:858-863) runs before `killTree` (daemon.ts:865-869) in code, but persist-before-kill ordering is not asserted by any test (P3) |

### Edge cases (spec section)

| Edge | Assertion | Covered |
| ---- | --------- | ------- |
| SIGKILL mid-flush → PASSIVE + `interrupted` already done | `power-shutdown.test.ts:150-151` (PASSIVE first) | ⚠️ partial — see PWR-10-3 |
| Truncated `.ndjson` line dropped on shutdown drain only | `power-tailer.test.ts:34-39` (`["whole"]`, `consumedOffset 6`), `:47-51` (partial-only file → `[]`), `:62-63` (complete lines still delivered); normal `flush()` unchanged `:71-75` (`["whole","frag"]`) | ✅ (sensor M5 killed) |
| PID reused → `failed` `reason=pid_reused`, stranger never signaled | `power-recover.test.ts:97-99`: status `failed`, `failure` `toMatchObject({code:"HARNESS_CRASH", reason:"pid_reused"})`, last event `session.failed` | ✅ (recover never signals; `killTree` only in shutdown drain) |
| 5+ sessions drain in parallel <5s (`Promise.allSettled`, never sequential) | — (no test) | ❌ P3 (impl uses `Promise.allSettled`, daemon.ts:865-869) |
| FS gone (`EROFS`/`EIO`) → abort flush, exit 0 | — (no test) | ❌ P3 (`safeListActive()` catch → `[]`, daemon.ts:876-884, untested) |
| `daemon.stop` via IPC → same `handleShutdown` | `power-shutdown.test.ts:126-127`: status `interrupted` + `exitSpy` called with 0; routed at daemon.ts:610-612 | ✅ |
| Surviving harness → next `recover()` ignores `interrupted` row | `power-recover.test.ts:72-74` (live pid: status kept, 0 events, 0 attaches), `:85-87` (dead pid) | ✅ at outcome level; sensor nuance below |

## Discrimination sensor (scratch copies, discarded)

Faults injected via `sed` into scratch copies (`git archive HEAD` → `/tmp/power-sensor/*`, `node_modules` symlinked; **no real-tree mutation**). Command: `npx vitest run` over the feature test files; killed = ≥1 feature test fails.

| Mutation | Fault | Result | Killer assertion(s) |
| -------- | ----- | ------ | ------------------- |
| M1 | `markInterrupted` persists `failed` instead of `interrupted` (daemon.ts:921) | **KILLED** (6 failed / 35) | `power-shutdown.test.ts:70` `status === "interrupted"`, plus 5 others (inhibit ×2, exactly-once, daemon.stop, rollback) |
| M2 | `killTree` drops `expectedStartTime` (daemon.ts:868) | **KILLED** (1 failed) | `power-shutdown.test.ts:87` `toHaveBeenCalledWith(424242, 1500, "tick-9")` |
| M3 | `exitCodeForOutcome` interrupted+infra returns 0 (errors.ts:158) | **KILLED** (2 failed) | `power-shutdown-code.test.ts:6-9` and `power-ps.test.ts:76` (`expected +0 to be 3`) |
| M4 | remove recover guard `if (s.status === "interrupted") continue` (daemon.ts:116) | **SURVIVED** | `listActive()` SQL filter (`sessions.ts:171`, `status IN ('starting','working','needs_input','idle')`) is the second enforcement layer |
| M4b | `listActive()` includes `'interrupted'` (sessions.ts:171) | **SURVIVED** | daemon-side guard (daemon.ts:116) is the second layer |
| M4c | **both** layers broken (M4+M4b compound) | **KILLED** (2 failed) | `power-recover.test.ts:72` `'orphaned' ≠ 'interrupted'`, `:85` `'failed' ≠ 'interrupted'` |
| M5 | `drainForShutdown` emits leftover via `finishPartial()` instead of dropping (tailer.ts:76) | **KILLED** (2 failed) | `power-tailer.test.ts:38` `['whole','frag'] ≠ ['whole']`, `:51` `['half-written'] ≠ []` |
| M6 | remove `process.once("SIGHUP", …)` wiring (daemon.ts:89) | **SURVIVED** | no test drives signal wiring (`onSignal` untested) — gap for PWR-01-AC1/AC9 and PWR-04-AC1 |
| M7 | remove `SERVICE_UNAVAILABLE` guard (daemon.ts:216-219) | **KILLED** (1 failed) | `power-shutdown.test.ts:113` |

**Sensor conclusion**: 6 of 8 distinct faults killed (9 injections incl. 2 single-layer variants of the recover fault). Both survivors are structural, not silent product bugs: the recover fault needs *both* layers broken to manifest (compound killed — defense-in-depth holds and is discriminated), and signal wiring has zero test coverage. Requested minimum of ≥5 fault injections satisfied.

## Ranked gaps (all non-blocking; product behavior verified correct)

1. **P2 — signal wiring untested** (PWR-01-AC1/AC9, PWR-04-AC1): nothing drives `onSignal`/`process.once`; sensor M6 proves a removed `SIGHUP` wiring survives. Suggest a seam test calling `onSignal("SIGHUP")` and asserting the drain.
2. **P3 — `SQLITE_BUSY` concurrency AC** covered only at pragma level; no two-process writer test (spec's independent test not implemented).
3. **P3 — persist-before-kill ordering** (`markInterrupted` before `killTree`) unasserted; only PASSIVE<TRUNCATE is pinned. The "SIGKILL mid-flush" edge relies on unobserved code order.
4. **P3 — parallelism** (`Promise.allSettled`, 5+ sessions <5s) unasserted.
5. **P3 — `EROFS`/`EIO` abort path** (`safeListActive`) untested.
6. **P3 — below-the-seam precision**: `--resume <nativeId>` argv, cwd/worktree propagation, `run --help` ≤3-line bound not asserted.
7. **P3 — spec-internal tension**: AC9 mandates `process.once`, so a repeated same-signal after listener consumption falls through to the default disposition (process death mid-drain); AC6's "ignore repeated signals" holds only for cross-signal repeats (TERM→INT/HUP). Untested; worth a spec clarification or a self-re-registering handler in a future hardening pass.

## Tree integrity

- No writes to code/tests; scratch copies under `/tmp/power-sensor/` deleted after the sensor run.
- Only file created by this validation: `.specs/features/daemon-power/validation.md` (untracked).
- Pre-existing uncommitted change `M src/cli/commands/ps.ts` untouched (see observation above).
