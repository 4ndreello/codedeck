# web-daemon validation report (round 3)

**Date**: 2026-09-24
**Spec**: `.specs/features/web-daemon/spec.md`
**Diff range**: `main..feat/web-daemon` (73dc835..7bddffa, 19 commits; round 3 re-verifies fix commit 7bddffa, T18)
**Verifier**: independent sub-agent (author is not the verifier)

**Result**: PASS. All 50 ACs have discriminating evidence. Round 3 injected 19 mutants: the 4 round-2 survivors (M18b, M27, M31, M32), 4 new variants aimed at the new tests, and the 11 round-2 kills re-run. All 19 were killed. A re-run sample of 8 round-1 mutants was also killed.

7bddffa changes only tests and `tasks.md`. `src/` is identical to round 2 (`git diff ffeaf8a..HEAD --stat -- src/` is empty), so the behavior verified in rounds 1 and 2 stands.

---

## Task completion

| Task | Status | Notes |
| --- | --- | --- |
| T1 to T16 | Done | Feature tasks. |
| T17 | Done | Round-1 fix task (ffeaf8a). |
| T18 | Done | Round-2 fix task (7bddffa). Its Done-when (M18b, M27, M31, M32 each break a test) is confirmed below. |

---

## Gap history

| Gap | Round found | Fixed in | Round-3 evidence |
| --- | --- | --- | --- |
| WD-44 `WEB_START_FAILED` fallback (M10) | 1 | ffeaf8a | `tests/web-launch.test.ts:111` |
| WD-07/WD-11 daemon.log wiring (M8) | 1 | ffeaf8a | `tests/daemon-web.test.ts:86`-`:90` |
| WD-06 5000 ms default and both edges (M6, M21) | 1 | ffeaf8a | `tests/web-supervisor.test.ts:110`, `:115` |
| WD-41 3000 ms default (M7) | 1 | ffeaf8a | `tests/web-supervisor.test.ts:205`, `:213` |
| WD-40 child build computation (M18) | 1 | ffeaf8a | `tests/web-child.test.ts:95` |
| WD-01 default entry (M22) | 1 | ffeaf8a | `tests/web-supervisor.test.ts:244` |
| WD-12 CLI default entry (M32) | 2 | 7bddffa | `tests/web-launch.test.ts:59` - `params.entry toBe(path.join(REPO_ROOT, "src", "web", "child.js"))` |
| WD-12 CLI default build (M31) | 2 | 7bddffa | `tests/web-launch.test.ts:69`/`:70` - `computeBuildId toHaveBeenLastCalledWith(path.join(REPO_ROOT, "src"))`, `build: "tree-build"` |
| WD-40 child default dist root (M18b) | 2 | 7bddffa | `tests/web-child.test.ts:103`/`:104` - called with `<repo>/src`, handshake `build toBe("own-tree")` |
| WD-28 bare side-effect imports (M27) | 2 | 7bddffa | `tests/web-supervisor.test.ts:287` regex now matches `import "..."`; `:304` |

Correction to the round-2 report: its gap 3 said the child's default dist root resolves to the repo root. From `src/web/child.ts`, `distRootFor` (two directories above the module file) gives `<repo>/src`, and `<dist>` in a build. The T18 tests assert `<repo>/src`, which is correct.

---

## Spec-anchored acceptance criteria

PASS = the assertion targets the spec outcome and a mutant (or direct reading) shows it discriminates. NOTE = covered, with a caveat that does not fail the AC.

### P1: Daemon supervises one web server

| AC | Spec-defined outcome | Evidence (`file:line` - assertion) | Result |
| --- | --- | --- | --- |
| WD-01 | spawn from `entry`, or own `dist/web/child.js`; return `{ baseUrl, port, token }` | `tests/web-supervisor.test.ts:61`, `:151`, `:244` | PASS (M22 killed) |
| WD-02 | same entry+build reuses, no spawn | `tests/web-supervisor.test.ts:74`, `:77` | PASS (M1 killed) |
| WD-03 | concurrent requests share one spawn | `tests/web-supervisor.test.ts:73`, `:77` | PASS (M3 killed) |
| WD-04 | default 3100 busy: OS port | `tests/web-child.test.ts:113`; `tests/web-server.test.ts:258`; `tests/web-supervisor.test.ts:62` | PASS (composition) |
| WD-05 | `WEB_LISTEN_FAILED`, message, `details { port }` | `tests/web-child.test.ts:127`; `tests/web-supervisor.test.ts:86`-`:89`; `tests/daemon-web.test.ts:48` | PASS (M5, M9 killed) |
| WD-06 | exit, 5000 ms timeout, invalid line: kill + `WEB_START_FAILED` | `tests/web-supervisor.test.ts:100`, `:110`/`:111`/`:115`, `:139`/`:140` | PASS (M4, M6, M21, M29 killed) |
| WD-07 | exit after handshake: stopped, `web child exited code=<code>` in daemon log, respawn | `tests/daemon-web.test.ts:83`, `:87`, `:90`; `tests/web-supervisor.test.ts:192`/`:193` | PASS (M8, M20 killed) |
| WD-08 | child serves the `createUiRoutes` table | `tests/web-child.test.ts:82`; `tests/web-cli.test.ts:178`-`:204` | PASS |
| WD-09 | stdin end or SIGTERM: stop, close connections, exit 0 | `tests/web-child.test.ts:152`/`:153`/`:154` | PASS (M17 killed) |
| WD-10 | shutdown sends SIGTERM without waiting | `tests/daemon-web.test.ts:61`/`:62`; `tests/web-supervisor.test.ts:256`/`:257` | PASS (M23 killed) |
| WD-11 | `web listening port=<port>` in daemon log, no token | `tests/daemon-web.test.ts:86`/`:88`/`:89`; `tests/web-supervisor.test.ts:223`/`:224` | PASS (M8 killed) |

### P1: Web commands delegate to the daemon

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-12 | `ui` ensures daemon, calls `web.ensure` with its local build and entry, opens `/?t=` | `tests/web-cli.test.ts:94`; `tests/web-launch.test.ts:57`-`:59`, `:69`/`:70` | PASS (M31, M31b, M32, M32b killed) |
| WD-13 | `/review?repo=<cwd>&t=` | `tests/review-command.test.ts:42`; `tests/web-launch.test.ts:52`/`:54` | PASS |
| WD-14 | `/setup?t=` without a TTY | `tests/setup-cli-contract.test.ts:708`-`:719` | PASS |
| WD-15 | `/setup?refresh=1&t=` | `tests/setup-cli-contract.test.ts:727`/`:728` | PASS |
| WD-16 | usage filters, `by`, `interval`, no empty keys | `tests/usage-cli.test.ts:318`; `tests/web-cli.test.ts:239` | PASS |
| WD-17 | `<title> on <url>`, exit 0 | `tests/web-launch.test.ts:53`/`:55` | PASS |
| WD-18 | `--no-open` | `tests/web-launch.test.ts:76`/`:78`/`:79` | PASS |
| WD-19 | `Could not open a browser, visit <url> manually.` | `tests/web-launch.test.ts:85`/`:87` | PASS |
| WD-20 | explicit port sent, omitted not sent | `tests/web-launch.test.ts:96`/`:97`; `tests/web-cli.test.ts:105` | PASS |
| WD-21 | `CodeDeck web is already running on port <port>` first | `tests/web-launch.test.ts:98`/`:99` | PASS (M12 killed) |
| WD-22 | `Failed to listen on 127.0.0.1:<port>: <message>`, exit 1 | `tests/web-launch.test.ts:105`/`:107`/`:108` | PASS |
| WD-23 | invalid `--port`: error, exit 1, no IPC | `tests/web-cli.test.ts:116`-`:118`; `tests/review-command.test.ts:61`/`:62`; `tests/setup-cli-contract.test.ts:740`; `tests/usage-cli.test.ts:333` | PASS |

### P1: Web failures stay isolated

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-24 | sync throw: 500 `{ error }` | `tests/web-server.test.ts:196`/`:197` | PASS |
| WD-25 | rejection: 500 `{ error }` | `tests/web-server.test.ts:203`/`:204` | PASS (M24 killed) |
| WD-26 | late failure: end, keep serving | `tests/web-server.test.ts:211`, `:214` | PASS |
| WD-27 | setup handlers return promises | `tests/setup-web.test.ts:280`/`:281`/`:283` | PASS (M19 killed) |
| WD-28 | daemon never imports `src/web/server.ts` or opens HTTP | `tests/web-supervisor.test.ts:287`, `:291`-`:304` | PASS (M27, M27b, M28 killed). The only listener in the daemon is the Unix socket at `src/daemon/daemon.ts:356`. |

### P1: Long-lived server authentication

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-29 | API without matching cookie: 403 `forbidden` before the handler | `tests/web-security.test.ts:175` | PASS (M13, M14 killed) |
| WD-30 | page without credentials: 403 `open this page with codedeck ui` | `tests/web-security.test.ts:140`, `:150` | PASS |
| WD-31 | valid `t`: cookie + 303 keeping the query | `tests/web-security.test.ts:115`/`:117`, `:130`/`:131` | PASS |
| WD-32 | Host and POST Origin checks kept | `tests/web-security.test.ts:96`, `:188`-`:198` | PASS |

### P1: Review reads the requested repository

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-33 | load from `repo` | `tests/review.test.ts:229` | PASS |
| WD-34 | 400 `repo query parameter is required` | `tests/review.test.ts:249` | PASS |
| WD-35 | 400 `repo must be an absolute path` | `tests/review.test.ts:256` | PASS (M15 killed) |
| WD-36 | 404 with the git error | `tests/review.test.ts:241`/`:242` | PASS |
| WD-37 | page forwards `repo` | `tests/review.test.ts:310` | PASS |
| WD-38 | no `repo`: message, no request | `tests/review.test.ts:316`/`:317` | PASS |
| WD-39 | draft key includes `repo` | `tests/review.test.ts:326`/`:328` | PASS (M16 killed) |

### P2: Web child restarts on build change

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-40 | child computes its build at start (newest `.js` mtime under the dist root) and sends it | `tests/web-child.test.ts:95`, `:103`/`:104`; `tests/build-id.test.ts:32`/`:37`/`:42` | PASS (M18, M18b, M18c killed) |
| WD-41 | SIGTERM, 3000 ms, SIGKILL, spawn, new result | `tests/web-supervisor.test.ts:205`/`:206`/`:212`/`:213`, `:176`-`:178` | PASS (M2, M7, M30 killed) |
| WD-42 | no `build`: reuse | `tests/web-supervisor.test.ts:75`/`:76` | PASS (M1 killed) |
| WD-43 | sessions untouched | `tests/daemon-web.test.ts:119` | PASS (NOTE: row equality only; the session process is not observable in the test) |

### P2: In-process fallback

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-44 | any non-listen error: notice, full routes, URLSearchParams query, ephemeral fallback | `tests/web-launch.test.ts:111`, `:116`, `:118`-`:126`, `:135`-`:137` | PASS (M10, M11 killed) |
| WD-45 | daemon start failure notice | `tests/web-launch.test.ts:145`-`:147` | PASS |
| WD-46 | in-process keeps running until SIGINT/SIGTERM | `tests/web-launch.test.ts:143`/`:147`; `tests/web-server.test.ts:133` | PASS (NOTE: compositional) |

### Edge cases

| AC | Spec-defined outcome | Evidence | Result |
| --- | --- | --- | --- |
| WD-47 | `interval` with the existing normalization | `tests/usage-web.test.ts:96` | PASS (M25 killed) |
| WD-48 | one `POST /api/setup/catalog/refresh` | `tests/setup-page.test.ts:609`, `:619` | PASS |
| WD-49 | `WEB_BAD_ENTRY`, nothing spawned | `tests/web-supervisor.test.ts:161`, `:162` | PASS |
| WD-50 | stderr appended to `logs/web-child.log` | `tests/web-supervisor.test.ts:277` | PASS |

**Status**: all 50 ACs covered with discriminating evidence. No spec-precision gap. Three NOTEs (WD-43, WD-46, WD-04 by composition) do not fail their ACs.

---

## Discrimination sensor

Scratch: a detached worktree at `<scratchpad>/verify-wt` on HEAD (a290498 in round 1, ffeaf8a in round 2, 7bddffa in round 3), with `node_modules` symlinked. Each mutation is an exact-string replace guarded by a count of 1 (the two append mutants add a line at the end of `src/config/paths.ts`). Each run uses one test file per vitest invocation, restores the file after the mutant, and removes the worktree with `git worktree remove --force`. After each round the real worktree's `git status --porcelain` matched its baseline: clean in round 1, and in rounds 2 and 3 only this report and the `.specs` lessons files, untracked.

### Round 3 (HEAD 7bddffa)

| # | File:line | Fault | Killed? |
| --- | --- | --- | --- |
| M31 | `src/cli/web-launch.ts:45` | CLI default build replaced by `"0"` | Killed (`web-launch` "sends the build id of its own dist root...") |
| M31b | `src/cli/web-launch.ts:45` | CLI build computed over the module's own directory (one level too shallow) | Killed (same test) |
| M32 | `src/cli/web-launch.ts:46` | CLI default entry `../../web/child.js` | Killed (`web-launch` "opens the daemon page...") |
| M32b | `src/cli/web-launch.ts:46` | CLI default entry `../daemon/daemon.js` | Killed (same test) |
| M18b | `src/web/child.ts:28` | default dist root replaced by a fixed path | Killed (`web-child` "computes its build identity from its own dist root by default") |
| M18c | `src/web/child.ts:28` | child ignores the `distRoot` seam | Killed (`web-child` "computes its build identity from its dist tree...") |
| M27 | `src/daemon/web-supervisor.ts:1` | bare `import "../web/server.js"` in the supervisor | Killed (`web-supervisor` import boundary, both entries) |
| M27b | `src/config/paths.ts` (end) | bare `import "../web/server.js"` in a transitively reached module | Killed (same, both entries) |
| M6, M7, M8, M10, M18, M21, M22, M26, M28, M29, M30 | as in round 2 | round-2 kills re-run | All killed |

Round-1 sample re-run at 7bddffa: M1, M3, M5, M9, M13, M16, M17, M23, all killed.

**Round 3 tally**: 19 injected, 19 killed, 0 survived (plus 8 of 8 in the round-1 sample).
**Cumulative**: round 1 had 25 injected with 18 killed; round 2 had 15 with 11 killed; round 3 had 19 with 19 killed. Every survivor from an earlier round is now killed.
**Sensor depth**: expanded (auth and process supervision are critical paths).

---

## Code quality

| Check | Status |
| --- | --- |
| Minimum code, no scope creep | OK. The fix rounds added two one-field seams (`DaemonOptions.spawnWebChild`, `RunWebChildOptions.distRoot`) and otherwise touched only tests. |
| Surgical changes | OK. |
| Matches patterns | OK. The `vi.mock` partial mock keeps the real `computeBuildId` and stubs a single call, so tests do not walk the repo tree. |
| Spec-anchored outcome check | All ACs match the spec outcome. |
| Every test maps to a requirement | OK. Fix-round tests map to WD ids via T17 and T18. |
| Guidelines | `CLAUDE.md` (scoped vitest runs, Conventional Commits). Followed. |

Observations that are not gaps:

- The wait after SIGKILL (`src/daemon/web-supervisor.ts:139`) caps the worst case for one `web.ensure` at 11 s, which stays under the 15 s IPC timeout (`src/daemon/ipc.ts:71`).
- While a start is in flight, a request with a different entry or build receives that in-flight start (`src/daemon/web-supervisor.ts:105`). The spec does not cover this case, and the design accepts it.
- A non-`WebEnsureError` throw is mapped to `WEB_START_FAILED` (`src/daemon/daemon.ts:1384`) and has no test. It is not a spec requirement.

---

## Gate check

- **Typecheck**: `npx tsc --noEmit` exit 0 at 7bddffa.
- **Round 3 runs** (one vitest per file): web-launch 12, web-child 8, web-supervisor 21, daemon-web 5, web-cli 10, build-id 3, all passed.
- **Unchanged since round 2** (`src/` identical, test files untouched by 7bddffa): web-security 8, web-server 13, setup-web 18, setup-page 19, review 21, review-command 7, usage-web 17, usage-cli 25, setup-cli-contract 38, setup-wizard 83, power-shutdown 11, all passed in round 2.
- **Total**: 318 tests across 17 files, 0 failed, 0 skipped. The count went from 310 in round 1 to 316 in round 2 and 318 in round 3. No test was removed.

---

## Requirement traceability update

| Requirement | Round 2 | Round 3 |
| --- | --- | --- |
| WD-12, WD-28, WD-40 | Needs fix (tests) | Verified |
| All other WD ids | Verified | Verified |

---

## Summary

**Overall**: ready. The behavior matches the spec, and every spec-defined value (the timeouts, error codes, log lines, messages, defaults and the import boundary) is pinned by a test that a fault breaks.

**Spec-anchored check**: 50/50 ACs matched the spec outcome.
**Sensor (round 3)**: 19/19 killed.
**Gate**: 318 passed, tsc clean.

**Next step**: the orchestrator commits this report (and `.specs/lessons.json` and `.specs/LESSONS.md` from rounds 1 and 2).
