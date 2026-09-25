# Web access Validation

**Date**: 2026-09-24
**Spec**: `.specs/features/web-access/spec.md`
**Diff range**: `0498d4d..ff8b930` (branch `feat/web-access`, 12 commits)
**Iteration**: re-verification 1 of 3, after the fix commit `ff8b930` (`test(web): Pin the forbidden body and the web child entry wiring`)
**Verifier**: independent sub-agent (author ≠ verifier)

**Verdict**: PASS

All 25 ACs are implemented and each has a `file:line` test citation. All 28 sensor mutants are killed. The first pass (against `dd7b7d9`) was FAIL because M9, M12 and M28 survived. The fix commit `ff8b930` changes only tests and spec/tasks text; `git diff dd7b7d9..ff8b930 -- src` is empty, so the implementation evidence below still holds.

---

## Task Completion

| Task | Status | Notes |
| ---- | ------ | ----- |
| T1 | ✅ Done | `src/web/web-token.ts` new, `tests/web-token.test.ts` 9 tests |
| T2 | ✅ Done | `src/web/security.ts:18,64,70,126-146` |
| T3 | ✅ Done | `src/web/server.ts:133,143`; `DEFAULT_WEB_PORT` lives in `src/config/web-port.ts:2` and is re-exported |
| T4 | ✅ Done | `src/config/web-port.ts`, `src/config/config.ts` `web?: { port?: number }` |
| T5 | ✅ Done | `src/web/child.ts:36,43-44,70-84` |
| T6 | ✅ Done | Supervisor rules covered; child entry wiring covered by `tests/web-child.test.ts:141-146` since `ff8b930` |
| T7 | ✅ Done | `src/daemon/daemon.ts:1429-1444,2022-2028` |
| T8 | ✅ Done | `src/cli/web-launch.ts:40-42,52,69,94-96` |
| T9 | ✅ Done | `review.ts:96`, `setup.ts:1304`, `usage.ts:154`, `ui.ts:58` |
| T10 | ✅ Done | `scripts/pty-gate.sh:23`, `scripts/rename-gate.sh:21`, `docs/protocol.md` |

---

## Spec-Anchored Acceptance Criteria

### P1: Bookmark survives restarts

| AC | Spec-defined outcome | Implementation | Test `file:line` + assertion | Result |
| --- | --- | --- | --- | --- |
| WA-01 | child serves with the stored token and reports it in the handshake | `src/web/web-token.ts:22-23`, `src/web/child.ts:44`, `src/web/server.ts:143` | `tests/web-token.test.ts:25-34` `expect(resolveWebToken({ dir })).toBe(TOKEN_A)`; `tests/web-child.test.ts:123-131` `expect(served.token).toBe("f".repeat(64))` and `expect(listen.mock.calls[0][0].token).toBe(...)`; `tests/web-server.test.ts:283-294` injected token served and required by cookie (`accepted.status` 200) | ✅ PASS |
| WA-02 | missing/malformed file → new 64 lowercase hex token, mode 0600, temp+link, serve the file's token | `web-token.ts:25-43,6` | `tests/web-token.test.ts:36-46` `toMatch(/^[0-9a-f]{64}$/)`, `modeOf(...)).toBe(0o600)`, `readdirSync(dir)).toEqual(["web-token"])`; `:48-63` malformed (short, uppercase, extra text, empty) → replaced, file content equals returned token | ✅ PASS |
| WA-03 | concurrent resolvers agree on the file's token | `web-token.ts:30-34` | `tests/web-token.test.ts:65-77` link seam loses the race: `expect(token).toBe(TOKEN_B)` and the file holds `TOKEN_B` | ✅ PASS (seam, not two real processes) |
| WA-04 | loose mode → 0600 before serving | `web-token.ts:54` | `tests/web-token.test.ts:79-86` 0644 → `modeOf(...)).toBe(0o600)`, token kept | ✅ PASS |
| WA-05 | in-process fallback resolves the token the same way | `src/cli/web-launch.ts:96` | `tests/web-launch.test.ts:176-185` `expect(options.token).toBe(TOKEN)`; `:187-197` same with `--port` | ✅ PASS (the default `?? resolveWebToken` is only visible by reading the code, see Observations) |
| WA-06 | 303 + `Set-Cookie: codedeck_ui_token_<port>=<token>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` | `security.ts:18,120,127` | `tests/web-security.test.ts:110-123` `status 303`, exact `set-cookie` array | ✅ PASS |
| WA-07 | valid cookie, no valid `t` → page served with the same `Set-Cookie` | `security.ts:70` | `tests/web-security.test.ts:171-183` for `/page` and `/page?t=stale-token`: `status 200` and exact `set-cookie` | ✅ PASS |
| WA-08 | 403 with body `Run "codedeck ui" once in a terminal to open CodeDeck in this browser.` | `security.ts:16,67` | `tests/web-security.test.ts:137-155` `expect(response.body).toBe(PAGE_FORBIDDEN)` (`:13` holds the exact text) | ✅ PASS |
| WA-09 | localhost page GET → 302 `Location: http://127.0.0.1:<port><pathname><search>` from a parsed URL, before token/cookie checks | `security.ts:64,132-146` | `tests/web-security.test.ts:185-201` bare, with `t` (302 instead of 303 proves the ordering) and an absolute-form target: exact `location`, `set-cookie` undefined, `calls` empty | ✅ PASS |
| WA-10 | foreign Host, bad POST and `/api/*` without cookie → 403 `forbidden` | `security.ts:46-59,149` | API: `tests/web-security.test.ts:203-221` `status 403` + `:210` `body "forbidden"`. Host: `:97-108` status 403 + `:104,106` `expect(missing.body).toBe("forbidden")`, `expect(foreign.body).toBe("forbidden")`. POST: `:223-260` status 403 + `:245` `expect(response.body).toBe("forbidden")` for all 6 cases | ✅ PASS (fixed in `ff8b930`; M9, M28 now killed) |

### P1: Console answers while the daemon runs

| AC | Spec-defined outcome | Implementation | Test `file:line` + assertion | Result |
| --- | --- | --- | --- | --- |
| WA-11 | after `start()` resolves, one unawaited `web.ensure` with the resolved preferred port and no port | `daemon.ts:1438-1444,2022-2023` | `tests/daemon-web.test.ts:143-152` `toHaveBeenCalledTimes(1)`, `toHaveBeenCalledWith({ preferredPort: 7788 })`; `:189-194` static regex on the `--daemon` entry: `d.start().then(() => d.autostartWeb(), ...)` | ✅ PASS |
| WA-12 | failure → `web autostart failed: <message>` in `daemon.log`, IPC keeps serving | `daemon.ts:1443` | `tests/daemon-web.test.ts:154-166` log line regex with the exact message; a later `ensure({})` returns the host result | ✅ PASS |
| WA-13 | requests during a start wait, re-check with their own params, repeat while a start is in flight; at most one start | `web-supervisor.ts:110-123` | `tests/web-supervisor.test.ts:283-313` three concurrent requests: each resolves to its own port, spawn args in order, `aliveAtSpawn` `[0,0,0]` | ✅ PASS |
| WA-14 | `Daemon.start()` starts no web child | `daemon.ts` (`start()` untouched) | `tests/daemon-web.test.ts:179-187` `expect(host.ensure).not.toHaveBeenCalled()` after `await daemon.start()` | ✅ PASS |

### P2: Fixed, configurable port

| AC | Spec-defined outcome | Implementation | Test `file:line` + assertion | Result |
| --- | --- | --- | --- | --- |
| WA-15 | `web.port` when an integer in 1-65535, else 7777 | `src/config/web-port.ts:16-23` | `tests/web-port.test.ts:5-10` absent → 7777; `:12-14` 7788, 1, 65535; `:16-24` `"7788"`, 0, 65536, 7.5 → `{ port: 7777, invalid }` | ✅ PASS |
| WA-16 | no `--port` → `preferredPort` sent, no `port` | `web-launch.ts:52` | `tests/web-launch.test.ts:95-106` `toMatchObject({ preferredPort: 7788 })`, `not.toHaveProperty("port")`; explicit case has no `preferredPort`; `:108-114` default 7777 | ✅ PASS |
| WA-17 | `CodeDeck web is running on port <actual> instead of <asked>` before the page line | `web-launch.ts:42,69` | `tests/web-launch.test.ts:116-129` exact `logs` array, notice first, for `--port` and preferred; `:131-138` no notice when equal | ✅ PASS |
| WA-18 | supervisor passes `--preferred-port <n>`; child listens there, OS port on any listen error | `web-supervisor.ts:161-165`; `child.ts:36,43`; `server.ts:133` | `tests/web-supervisor.test.ts:236-242` args `["--web-child","--preferred-port","7777"]`; `tests/web-child.test.ts:109-121` `[7788, true]`; `tests/web-child.test.ts:133-139` `parseWebChildArgs`; `tests/web-child.test.ts:141-146` entry block matches `/runWebChild\(\{\s*\.\.\.parseWebChildArgs\(process\.argv\)/`; `tests/web-server.test.ts:262-281` EACCES → other port | ✅ PASS (entry check added in `ff8b930`; M12 now killed; runtime check below) |
| WA-19 | `preferredPort` without `port` restarts a child not started for that preferred port | `web-supervisor.ts:142-143,155-160` | `tests/web-supervisor.test.ts:244-259` for another preferred port, an explicit port and no port: SIGTERM, new child, args `--preferred-port 7788`; `:261-269` same preferred port → reuse, even after fallback | ✅ PASS |
| WA-20 | `port` + matching entry/build → reuse whatever the child was started for | `web-supervisor.ts:142` | `tests/web-supervisor.test.ts:271-281` (`{ port: 8000 }`) `resolves.toEqual(first)`, `spawns` length 1 | ✅ PASS |
| WA-21 | in-process without `--port` → preferred port, OS port on any listen error | `web-launch.ts:94`, `server.ts:133` | `tests/web-launch.test.ts:176-185` `options.port` 7788, `fallbackToEphemeral` true; `tests/web-server.test.ts:262-281` for any-error fallback | ✅ PASS |
| WA-22 | CLI prints `Ignoring invalid web.port in config: <JSON value>` to stderr; daemon appends it to `daemon.log` | `web-launch.ts:41`, `daemon.ts:1440`, `web-port.ts:25-27` | `tests/web-launch.test.ts:140-147` `errors` equals the exact line once; `tests/daemon-web.test.ts:168-177` log regex with `"7788"`; `tests/web-port.test.ts:26-29` JSON rendering | ✅ PASS |
| WA-23 | `--port` help reads `port for a new console (default: web.port from config, else 7777)` | the four command files | `tests/web-cli.test.ts:300-313` exact `option.description` for review, setup, usage, ui | ✅ PASS |
| WA-24 | child with neither flag → 7777, OS port on any listen error | `child.ts:36,43` | `tests/web-child.test.ts:109-121` `[7777, true]` | ✅ PASS |
| WA-25 | neither `port` nor `preferredPort` + matching entry/build → reuse | `web-supervisor.ts:142` | `tests/web-supervisor.test.ts:271-281` (`{}`) reuse, 1 spawn; `:65-78` reuse on `{}` | ✅ PASS |

**Status**: ✅ All ACs covered. No spec-precision gaps: every AC fixes an exact value.

---

## Edge Cases

- [x] Token file with anything other than 64 lowercase hex plus optional newline is replaced: `tests/web-token.test.ts:48-63`.
- [x] A child restart keeps the cookie valid: follows from WA-01 + WA-07. The author's smoke saw a 200 with the old cookie after a daemon restart. My runtime check below saw two children share one token.
- [x] No notice when the console is on the preferred port: `tests/web-launch.test.ts:131-138`.
- [x] `?t=` survives the localhost 302: `tests/web-security.test.ts:190,197`.
- [x] A `--port 8000` child is restarted by a later request without `--port`: `tests/web-supervisor.test.ts:244-259` ("an explicit port" row).
- [x] Unbindable preferred port falls back and prints the notice: `tests/web-server.test.ts:262-281` (EACCES) + `tests/web-launch.test.ts:116-129`.

---

## Supersedes Check (web-daemon)

| web-daemon item | Replacement verified |
| --- | --- |
| lazy child start | WA-11: `daemon.ts:2022-2023`, lazy `webHost()` kept for `web.ensure` (`daemon.ts:1429-1432`) |
| preferred port 3100, WD-04 | `DEFAULT_WEB_PORT` 7777 (`web-port.ts:2`); `grep 3100 src docs/protocol.md` finds nothing |
| token not persisted | WA-01..04 |
| WD-21 `already running on port` | gone from `src`; WA-17 text at `web-launch.ts:69` |
| WD-30 `open this page with codedeck ui` | gone from `src` and `docs`; WA-08 text at `security.ts:16` |
| `web.ensure` params | `preferredPort` added in `src/daemon/protocol.ts` and `docs/protocol.md` |
| WD-02, WD-42 reuse | port rule applied after entry/build (`web-supervisor.ts:136-143`); the old reuse tests still pass (`tests/web-supervisor.test.ts:65-78`) |
| WD-03 shared start | replaced by the serialized wait (`web-supervisor.ts:110`); same-params requests still get one spawn (`tests/web-supervisor.test.ts:65-72`) |
| WD-44 EADDRINUSE-only fallback | any error (`server.ts:133`); the `EADDRINUSE` literal is gone from `src` |

The tests the spec listed as pinning old values were all updated: `web-security.test.ts:141,151`, `web-launch.test.ts` 3100→7777, `web-server.test.ts:45-46`, `review-command.test.ts:11-12`, `docs/protocol.md:35-95`.

---

## Discrimination Sensor

Scratch: `git worktree add --detach <scratchpad>/verify-wt HEAD`, `node_modules` symlinked. Each mutant was applied with an exact single-match replacement, its test file run alone, and the file restored. The scratch was removed with `git worktree remove --force`.

| # | File:line | Mutation | Result |
| --- | --- | --- | --- |
| M1 | `src/web/web-token.ts:54` | drop the chmod of a loose file | ✅ Killed by `web-token.test.ts:79` |
| M2 | `src/web/web-token.ts:34` | ignore the race winner, always rename | ✅ Killed by `web-token.test.ts:65` |
| M3 | `src/web/web-token.ts:6` | accept uppercase hex | ✅ Killed by `web-token.test.ts:48` (uppercase) |
| M4 | `src/web/web-token.ts:41` | leave the temp file behind | ✅ Killed by `web-token.test.ts:36,65` |
| M5 | `src/web/security.ts:70` | no cookie renewal on a page served with the cookie | ✅ Killed by `web-security.test.ts:171` (re-run on `ff8b930`) |
| M6 | `src/web/security.ts:18` | Max-Age 86400 | ✅ Killed by `web-security.test.ts:110,171` (re-run) |
| M7 | `src/web/security.ts:64-65` | canonical redirect after the token check | ✅ Killed by `web-security.test.ts:185` (re-run) |
| M8 | `src/web/security.ts:144` | `Location` built from the raw request target | ✅ Killed by `web-security.test.ts:185` (re-run) |
| M9 | `src/web/security.ts:47` | foreign Host answers with the page text instead of `forbidden` | ✅ Killed by `web-security.test.ts:97` (survived on `dd7b7d9`) |
| M10 | `src/web/server.ts:133` | fallback only on `EADDRINUSE` | ✅ Killed by `web-server.test.ts:262` |
| M11 | `src/web/child.ts:36` | child ignores `preferredPort` | ✅ Killed by `web-child.test.ts:109` (re-run) |
| M12 | `src/web/child.ts:84` | process entry passes only `port`, drops `--preferred-port` | ✅ Killed by `web-child.test.ts:141` (survived on `dd7b7d9`) |
| M13 | `src/daemon/web-supervisor.ts:143` | preferred port never restarts (`return true`) | ✅ Killed by `web-supervisor.test.ts:244,283` |
| M14 | `src/daemon/web-supervisor.ts:142` | explicit port no longer reuses | ✅ Killed by `web-supervisor.test.ts:271` |
| M15 | `src/daemon/web-supervisor.ts:110` | revert to sharing the in-flight promise (old WD-03) | ✅ Killed by `web-supervisor.test.ts:283` |
| M16 | `src/daemon/web-supervisor.ts:110` | `while` → `if` (no repeated wait) | ✅ Killed by `web-supervisor.test.ts:283` |
| M17 | `src/daemon/web-supervisor.ts:164` | no `--preferred-port` arg | ✅ Killed by `web-supervisor.test.ts:236,244` |
| M18 | `src/daemon/web-supervisor.ts:142` | a request with neither field reuses only a portless child | ✅ Killed by `web-supervisor.test.ts:271` |
| M19 | `src/daemon/daemon.ts:1443` | failed autostart swallowed without a log | ✅ Killed by `daemon-web.test.ts:154` |
| M20 | `src/daemon/daemon.ts:1440` | no invalid-`web.port` log line | ✅ Killed by `daemon-web.test.ts:168` |
| M21 | `src/daemon/daemon.ts:1442` | autostart sends `{ port }` | ✅ Killed by `daemon-web.test.ts:143,154,168` |
| M22 | `src/daemon/daemon.ts:2022` | autostart before `start()` resolves | ✅ Killed by `daemon-web.test.ts:189` |
| M23 | `src/cli/web-launch.ts:69` | notice only with `--port` | ✅ Killed by `web-launch.test.ts:116` |
| M24 | `src/cli/web-launch.ts:96` | fallback without the shared token | ✅ Killed by `web-launch.test.ts:176` |
| M25 | `src/cli/web-launch.ts:52` | preferred port sent as `port` | ✅ Killed by `web-launch.test.ts:95` |
| M26 | `src/cli/web-launch.ts:41` | no invalid-`web.port` warning | ✅ Killed by `web-launch.test.ts:140` |
| M27 | `src/config/web-port.ts:21` | accept port 0 | ✅ Killed by `web-port.test.ts:16` (zero) |
| M28 | `src/web/security.ts:52` | POST without credentials answers with the page text instead of `forbidden` | ✅ Killed by `web-security.test.ts:223` (survived on `dd7b7d9`) |

**Sensor depth**: expanded (auth boundary + concurrency), 28 manual mutants.
**Result**: 28/28 killed. PASS ✅

Re-run on `ff8b930` in a fresh scratch worktree: M5-M9, M11, M12, M28 (every mutant whose covering test file changed). The other 20 target source that did not change and test files that did not change (`git diff dd7b7d9..ff8b930 -- src` is empty; only `web-security.test.ts` and `web-child.test.ts` changed), so their first-pass kills carry over.

**Isolation**: first pass, `git status --porcelain` was empty before and after. Re-verification: the baseline was ` M .specs/LESSONS.md`, ` M .specs/lessons.json`, `?? .specs/features/web-access/validation.md` (the verifier's own outputs), and it was identical afterwards (`cmp` matched). Both scratch worktrees are gone from `git worktree list`.

---

## Runtime checks (verifier)

- `node dist/web/child.js --web-child --preferred-port 7793` twice under a temp `RUN_AGENT_DIR` (dist newer than every `src/*.ts`): the first child printed `{"port":7793,...}` and the second fell back to `{"port":36771,...}`. Both used the same token, equal to `web-token`, mode `600`. So the real entry does wire `--preferred-port` (the behavior M12 targets), and WA-01/WA-02/WA-18 hold at runtime.
- `scripts/pty-gate.sh` (worktree `dist/`): exit 0, `pty path ok: tty, 137x41, /rename corrigir-auth-do-login typed, keys still flowing`. Afterwards no `daemon.js` or `web/child.js` process from the worktree's `dist/` was left. Every running daemon belongs to `/home/andreello/dev/codedeck/dist`.
- The author's 8-step smoke against `dist/` is cited from the brief and was not re-run.

---

## Gate Check

- **Commands** (one file per run, from the worktree): `npx vitest run tests/<file>.test.ts` for each of the 10 files; `npx tsc --noEmit` (exit 0); `scripts/pty-gate.sh` (exit 0). `npm run build` was not re-run: the author saw exit 0, and `find src -newer dist/daemon/daemon.js -name '*.ts'` is empty.
- **Re-verification on `ff8b930`**: `npx vitest run tests/web-security.test.ts` passed 10/10 and `npx vitest run tests/web-child.test.ts` passed 13/13. The other 8 files did not change and were not re-run.
- **Result**: 136 passed, 0 failed, 0 skipped. web-token 9, web-security 10, web-server 16, web-port 11, web-child 13, web-supervisor 29, daemon-web 10, web-launch 17, web-cli 14, review-command 7.
- **Test count before feature** (same 8 pre-existing files at `0498d4d`, run in scratch): 84. security 8, server 13, child 8, supervisor 21, daemon-web 5, launch 12, cli 10, review 7.
- **Test count after feature**: 136 (116 in those 8 files + 20 in the 2 new files).
- **Delta**: +52. No file lost tests. One pre-existing assertion was re-targeted: `web-security.test.ts:90` now sends the LOCALHOST cookie case to `/action` instead of `/page`, because page GETs on localhost now redirect. The Host acceptance it checks is still asserted.

---

## Code Quality

| Principle | Status |
| --- | --- |
| Minimum code | ✅ |
| Surgical changes | ✅ (diff limited to the files named in tasks.md) |
| No scope creep | ✅ |
| Matches patterns | ✅ (DI seams like the existing `runWebChild`/`launchWebPage` options; static entry check like other daemon-entry tests) |
| Spec-anchored outcome check | ✅ (WA-10 body pinned on all three paths since `ff8b930`) |
| Per-layer coverage expectation | ✅ (child entry covered by `web-child.test.ts:141-146`) |
| Every test maps to a spec requirement | ✅ |
| Documented guidelines followed: `CLAUDE.md` (scoped vitest, seams keep tests off `~/.run-agent`) | ✅ every new default-path writer (`resolveWebToken`) is injected in unit tests (`web-child.test.ts:44,147,188`, `web-launch.test.ts:43-44`); the daemon tests use a temp `RUN_AGENT_DIR` (`tests/helpers/daemon-seam.ts:87`) and a temp `RUN_AGENT_CONFIG_DIR` |

---

## Fix Plans

Both fix plans from the first pass are done in `ff8b930` and verified above:

- Fix 1 (WA-10 `forbidden` body on the Host and POST rejections): `tests/web-security.test.ts:104,106,245`. M9 and M28 are now killed.
- Fix 2 (web child entry wiring, WA-18): `tests/web-child.test.ts:141-146`. M12 is now killed.

---

## Observations (not gaps)

- The default seams `(deps.resolveToken ?? resolveWebToken)` (`web-launch.ts:96`) and `(options.resolveToken ?? resolveWebToken)` (`child.ts:44`) are always injected in tests. The child default is confirmed by the runtime check. The CLI fallback default is confirmed only by reading the code; it was not run as a mutant.
- WA-11 says "with its own entry". `autostartWeb` sends no `entry`, and the supervisor falls back to `defaultEntry`, the daemon's own `dist/web/child.js` (`web-supervisor.ts:98`). This matches the spec's intent and the test asserts it (`daemon-web.test.ts:150`).
- `ff8b930` fixed the `spec.md` coverage line (now `25 mapped`) and set the `tasks.md` Status to `Done`.

---

## Requirement Traceability Update

| Requirement | Previous Status | New Status |
| --- | --- | --- |
| WA-01..WA-09 | Verified (set by author) | ✅ Verified |
| WA-10 | Needs Fix (first pass) | ✅ Verified (`ff8b930`) |
| WA-11..WA-17 | Verified (set by author) | ✅ Verified |
| WA-18 | Needs Fix (first pass) | ✅ Verified (`ff8b930`) |
| WA-19..WA-25 | Verified (set by author) | ✅ Verified |

---

## Summary

**Overall**: ✅ Ready

**Spec-anchored check**: 25/25 ACs matched to the spec outcome. 0 spec-precision gaps.
**Sensor**: 28/28 mutations killed (M9, M12 and M28 survived on `dd7b7d9` and are killed on `ff8b930`).
**Gate**: 136 passed, 0 failed; `tsc --noEmit` exit 0 and `pty-gate.sh` exit 0 (first pass; `src` has not changed since).

**What works**: persistent 0600 token with a race-safe publish, year-long renewed cookie, localhost→127.0.0.1 302, 7777 default with fallback on any listen error, supervisor port rules and serialized starts, eager autostart after `start()`, CLI `preferredPort`/notice/warning, help text, gate daemon cleanup.

**Issues found**: none open. The two first-pass gaps were closed in iteration 1.

**Next steps**: none from the verifier. The feature is ready to merge.
