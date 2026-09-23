# web-console run notes

Append-only. One entry per decision, blocker, or event.

## 2026-09-23 00:51 -03, entry 1: autonomous mode activated

- decision: the human invoked `/codedeck:autonomous` during wave 2 (workers f44d and ea84 running). No human questions from here on.
- state at activation: PR #108 (spec) merged as 35555b6. PR #111 (T1-T9, T14) merged as afacb22 after green CI. Waves in flight: f44d (T10, T11 setup page and routes) and ea84 (T15, T16 usage route and page). Remaining after them: T12, T13, T17, T18, T19.

## entry 2: publishing web-console slices stays authorized

- decision: keep pushing, opening PRs, and squash-merging web-console slices once CI is green.
- category: bucket 2 (publishing), taken under the human's prior explicit instruction in this session: "se tudo passar bora ja mergear e continuar".
- reason: the human authorized merge and continue before activation. Anything outside the web-console slices stays deferred.

## entry 3: decisions made before activation, recorded for the report

- `codedeck setup` without a TTY keeps exit 1. Bucket 1 (spec text, reversible). Reason: an agent calling setup must not block on an HTTP server, and the existing tests stay valid.
- off-catalog models typed by hand save through the web only with an explicit per-role confirmation. Bucket 1. Reason: mirrors the wizard's second-Enter confirm.
- T8 started in parallel with T7, even though tasks.md lists T8 after T7. Bucket 1. Reason: no shared file or code dependency.
- wave 2 page tests go in `tests/setup-page.test.ts` and `tests/usage-page.test.ts` instead of `tests/web-pages.test.ts`. Bucket 1. Reason: two parallel workers would edit one file. The coverage matrix is updated at integration.

## entry 4: dependency installs in worktrees

- event: workers c301, b177, 18b3 (and likely f44d, ea84) ran `npm ci` from the lockfile in their worktrees, because worktrees have no node_modules. This happened before activation.
- category: bucket 2 (installing dependencies). It no longer happens in future briefings.
- decision going forward: new briefings symlink `node_modules` from the main checkout (`/home/andreello/dev/codedeck/node_modules`) instead of installing.

## entry 5: deferred issue for codedeck diff --stat

- finding: `codedeck diff <id> --stat` omits untracked new files. For c301 it showed 2 files and hid `src/core/usage-query.ts`, the task's main file.
- category: bucket 2 (opening a GitHub issue is a network write). Deferred. The evidence goes in the report.
- workaround in this run: verify each slice with a `git status --short` on its worktree, not only the stat.

## entry 6: issue #109 opened before activation

- the human requested it: `session.create` fails on 4-char session id collisions (seen as "UNIQUE constraint failed: sessions.id" while dispatching wave 1). The fix is not part of this run.

## entry 7: slice ea84 (T15, T16) accepted

- evidence: 4 new files only (`src/web/usage-page.ts`, `src/web/usage-routes.ts`, `tests/usage-page.test.ts`, `tests/usage-web.test.ts`). Orchestrator reran `npx vitest run tests/usage-web.test.ts tests/usage-page.test.ts tests/usage-cli.test.ts tests/web-server.test.ts tests/web-security.test.ts`: 5 files, 54 tests passed. `tsc --noEmit` exit 0.
- probes: worker: drop agent filter (killed, 2), clear last good result on error (killed, 1). Orchestrator: remove `?? []` for missing byOrigin (killed, 2, including the node:vm test).
- commit on worker branch: "feat(web): Add the usage page and usage query route".

## entry 8: slice f44d (T10, T11) accepted

- evidence: 4 new files only (`src/web/setup-page.ts`, `src/web/setup-routes.ts`, `tests/setup-page.test.ts`, `tests/setup-web.test.ts`). Orchestrator reran `npx vitest run tests/setup-page.test.ts tests/setup-web.test.ts tests/setup-plan.test.ts tests/web-security.test.ts tests/web-server.test.ts`: 5 files, 49 tests passed. `tsc --noEmit` exit 0.
- probes: worker: dry-run saves config (killed), apply accepts an off-catalog changed binding without confirmation (killed). Orchestrator: bypass the invalid-config guard `setupReadProblem` (killed; the test also asserts apply returns code 14 with saved=false, `tests/setup-web.test.ts:462,469`).
- the config read goes through the batch `SetupConfigRead` path, not `loadConfig`, so a corrupt config is never replaced by defaults.

## entry 9: wave 2 is not published on its own

- decision: no separate PR for T10, T11, T15, T16. They are unwired code until T12, T13, T17, T18 land. One PR covers waves 2 and 3 on `feat/web-console-pages`. Bucket 1.
- dispatched e041 for T12, T13, T17, T18, T19 plus removing the duplicate Host check in `dispatchRequest`. It symlinks node_modules instead of running `npm ci`.

## entry 10: slice e041 (T12, T13, T17, T18, T19) accepted

- evidence: worker batches passed (67, 122, 56 tests) and `tsc` was silent. The worker reported no commit and no drift outside the briefing. The orchestrator committed its work as d9b5e15 "feat(web): Open setup and usage in the web console".
- probes: worker: setup without a TTY no longer exits 1 (killed, `expected +0 to be 1`), `usage <run-id> --web` skips `usage.get` (killed). Orchestrator: drop the setup routes from `createUiRoutes` (killed, 2 tests in `tests/web-cli.test.ts`), restored and confirmed with `cmp`.
- known leftovers, bucket 1, left as is: `setup --refresh` wraps the `/setup` response to call `setupPage.refreshCatalog()` after the page is ready; removing the duplicate Host check in `dispatchRequest` means a bad Host with a malformed URL now answers 400 instead of 403 (the request is still refused).

## entry 11: integration of feat/web-console-pages

- integration batches on d9b5e15, one at a time: 67 tests (5 files), 122 (4), 56 (6), 126 (4: usage, usage-query, open-args, statusline). `npm run build` exit 0. Updated gates after the coverage matrix change: P4 71 tests (4 files), P5 plus web-pages 58 tests (6 files).
- the build in the main checkout also updates the installed `codedeck`, because `~/.run-agent/bin/codedeck` runs `dist/cli/index.js`. The running daemon was not restarted.

## entry 12: smoke test of the built `codedeck ui`

- `node dist/cli/index.js ui --no-open --port 3197`, checked with curl: the token URL answers 303 with `Set-Cookie: codedeck_ui_token_3197` (HttpOnly, SameSite=Strict) and `Location: /`. The home links `/review`, `/setup`, `/usage`. `/review`, `/setup`, `/usage`, `/api/setup/state`, `/api/setup/catalog`, `/api/usage?period=today` answer 200 with the cookie. Foreign Host: 403. POST without the cookie: 403. POST with the cookie and a foreign Origin: 403. POST `{}`: 400 "invalid shape". POST of the current state as a no-change selection to `/api/setup/dry-run`: 200 `unchanged`, `saved:false`, and the config file sha256 is unchanged. `frame-ancestors 'none'` is present on pages. Server stopped afterwards.
- coverage matrix and spec status updated: 66 traceability rows moved to Implemented, T10 and T16 point at `tests/setup-page.test.ts` and `tests/usage-page.test.ts`. `validate_spec` 0 errors, 0 warnings. `validate_tasks` 0 errors, 1 warning (T19 Tests none, which matches the Documentation row marked none).
- decision: open one PR for waves 2 and 3 and run the final read-only reviewer while CI runs. Merge only after review findings are handled and CI is green. Bucket 2 (publishing), under entry 2.

## entry 13: final review 52db and remediation

- PR #112 opened for feat/web-console-pages. Reviewer 52db (claude opus, read-only, worktree at f3e3597) ran 5 files, 66 tests passed.
- finding 1, blocker, confirmed by the orchestrator: `refreshCatalog` in `src/web/setup-page.ts` called `loadJson` without init, so the browser sent GET to the POST-only `/api/setup/catalog/refresh`. The page showed a JSON parse error and `setup --refresh` did nothing. The page test stub ignored the method. Fix 5320af3: `loadJson(path, init?)`, refresh passes `{ method: "POST" }`, and the test asserts `[["/api/setup/catalog/refresh", "POST"]]`. Probe: revert the method, 1 test failed (killed), restored with `cmp`. Scoped batch setup-page, setup-web, web-cli: 3 files, 38 tests passed. tsc exit 0, build exit 0.
- finding 2, minor, rejected: a missing active profile answers code 14. WEB-93 requires `resultado.code=14`, so this is the specified behavior.
- suspicion, not acted on: `usage <run-id> --web --tui` exits 2 on the flag conflict before `usage.get`. Bucket 1 reading: WEB-95 (flag conflict) wins over WEB-56. Recorded as an assumption.
- 52db left check 3 (requirement by requirement conformance for P4 and P5) undone. Re-review 9daf covers the fix and that table.

## entry 14: re-review 9daf and last fixes

- 9daf (claude opus, read-only, worktree at 5320af3) confirmed the refresh fix end to end: POST from the page, the cookie and Origin accepted by `checkWebRequest`, and the route reads no body. It found no other GET/POST mismatch across setup, usage and review. It produced the P4 and P5 conformance table: every criterion has code and a test, except WEB-82 (README text, no test by design). Batches: setup-web plus setup-page 29 tests passed; usage-web, usage-page, usage-cli, web-cli 54 tests passed.
- finding 1, minor, accepted: the browser adapter `fetcher: (url, init) => fetch(url, init)` was not covered. Dropping `init` survived every test. Fix: the node:vm test records the method and calls `refreshCatalog()`, expecting `POST /api/setup/catalog/refresh`. The same probe is now killed (1 test failed), restored with `cmp`.
- finding 2, minor, accepted: WEB-82 cited README line numbers that had drifted. It now cites the setup and usage command sections. `validate_spec` 0 errors, 0 warnings.
- suspicion, recorded, not fixed: `usage --web --days 14` pre-fills Since with a full ISO timestamp, which an `<input type="date">` shows as empty. The controller state keeps the value, and `setFilter` changes one field at a time, so the query stays correct. The issue is display only and was not checked in a real browser.
- no third review round: the only changes after 9daf are a test assertion and a spec sentence, both checked above.
