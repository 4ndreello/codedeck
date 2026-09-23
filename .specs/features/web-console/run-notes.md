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
