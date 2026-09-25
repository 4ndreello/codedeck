# Web daemon tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/web-daemon/design.md`
**Status**: Draft (revised after review)

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `CLAUDE.md` (scoped vitest runs, never the full suite), `vitest.config.ts`.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Web server / security (`src/web/server.ts`, `src/web/security.ts`) | integration (real loopback listener on port 0) | Every WD AC in the task, happy + error paths | `tests/web-*.test.ts` | `npx vitest run tests/<file>` |
| Web routes and page scripts (`src/web/*-routes.ts`, `src/web/*-page.ts`, review handler) | unit (handler calls, page script in `node:vm`) | 1:1 to the task's WD ACs | `tests/review.test.ts`, `tests/usage-web.test.ts`, `tests/setup-web.test.ts`, `tests/setup-page.test.ts` | `npx vitest run tests/<file>` |
| Web child and supervisor (`src/web/child.ts`, `src/daemon/web-supervisor.ts`) | unit with injected streams / fake child | All branches; 1:1 to WD ACs | `tests/web-child.test.ts`, `tests/web-supervisor.test.ts` | `npx vitest run tests/<file>` |
| Daemon IPC handlers (`src/daemon/daemon.ts`) | unit through `tests/helpers/daemon-seam.ts` | 1:1 to the task's WD ACs | `tests/daemon-web.test.ts` | `npx vitest run tests/<file>` |
| Pure helpers (`build-id`, `web-launch`) | unit with injected fakes | All branches; 1:1 to WD ACs | `tests/<module>.test.ts` | `npx vitest run tests/<file>` |
| CLI commands (`src/cli/commands/*.ts`) | unit with injected launcher / client | 1:1 to the task's WD ACs | `tests/web-cli.test.ts`, `tests/review-command.test.ts`, `tests/setup-cli-contract.test.ts`, `tests/setup-wizard.test.ts`, `tests/usage-cli.test.ts` | `npx vitest run tests/<file>` |
| Docs | none | build gate only | - | - |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | Every task | `npx vitest run <each test file of the task>` (one run per file) + `npx tsc --noEmit` |
| Full | Last task of each phase | Quick gate over every test file touched in the phase, one file per run |
| Build | Last task | `npm run build`, `scripts/pty-gate.sh`, then a manual smoke run against `dist/` |

---

## Execution Plan

### Phase 1: Web server core

```
T1 → T2 → T3 → T4
```

### Phase 2: Page and route inputs

```
T5 → T6 → T7
```

### Phase 3: Supervised web child

```
T8 → T9 → T10 → T11
```

### Phase 4: CLI entry

```
T12 → T13 → T14 → T15 → T16
```

---

## Task Breakdown

### T1: Require credentials on API routes and page GETs

**What**: Extend `checkWebRequest` with the `api` policy and the page-credential 403; pass `api` from `dispatchRequest`.
**Where**: `src/web/security.ts`
**Depends on**: None
**Reuses**: `hasValidActionCredentials` cookie parsing
**Requirement**: WD-29, WD-30, WD-31, WD-32

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] API GET without cookie → 403 `forbidden`; with cookie → handler runs
- [x] Page GET with no `t` and no cookie → 403 body `open this page with codedeck ui`
- [x] `/review?repo=%2Fx&t=<token>` → 303 to `/review?repo=%2Fx` + `Set-Cookie`; page GET with cookie → 200
- [x] Host and POST Origin tests still pass
- [x] Tests that call API routes or pages bootstrap the cookie first: `tests/usage-web.test.ts`, `tests/setup-web.test.ts`, `tests/web-cli.test.ts`, `tests/review.test.ts`, `tests/review-command.test.ts`, `tests/web-server.test.ts`
- [x] Gate check passes: `npx vitest run tests/web-security.test.ts` and each updated file, one run per file; `npx tsc --noEmit`

**Tests**: integration
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(web): Require the session cookie on API routes`

---

### T2: Isolate route handler failures

**What**: Dispatch catches sync throws and rejected thenables: 500 JSON, or end the response when headers were sent.
**Where**: `src/web/server.ts`
**Depends on**: T1
**Reuses**: `dispatchRequest`
**Requirement**: WD-24, WD-25, WD-26

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Throwing route → 500 `{ "error": "<message>" }`
- [x] Rejecting async route → 500 `{ "error": "<message>" }`
- [x] Route that writes headers then throws → response ends, and the next request still answers
- [x] Gate check passes: `npx vitest run tests/web-server.test.ts`; `npx tsc --noEmit`

**Tests**: integration
**Gate**: quick
**Status**: ✅ Done

**Commit**: `fix(web): Answer 500 when a route handler fails`

---

### T3: Return setup route promises to the dispatcher

**What**: Replace the `void` calls in the setup API routes with `return`.
**Where**: `src/web/setup-routes.ts`
**Depends on**: T2
**Reuses**: T2 dispatch isolation
**Requirement**: WD-27

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] With injected `readConfig` and `configPath` that both throw (so `mutationRoute` rejects outside its own try/catch; a throwing `saveConfig` is already caught there), `POST /api/setup/apply` answers 500 `{ error: "path boom" }` and no `unhandledRejection` fires (listener spy)
- [x] Existing setup web tests pass
- [x] Gate check passes: `npx vitest run tests/setup-web.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `fix(setup): Return setup route promises to the web dispatcher`

---

### T4: Extract listenWebServer without signals

**What**: Add `listenWebServer` (listen, security, close, optional ephemeral fallback on `EADDRINUSE`); `startWebServer` delegates to it.
**Where**: `src/web/server.ts`
**Depends on**: T3
**Reuses**: listen/close code in `startWebServer`
**Requirement**: WD-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `listenWebServer` leaves `process.listenerCount("SIGINT")` and `("SIGTERM")` unchanged
- [x] Busy port + `fallbackToEphemeral: true` → listens on another port and reports it
- [x] Busy port without fallback → rejects with the listen error
- [x] `startWebServer({ fallbackToEphemeral: true })` on a busy port serves on another port
- [x] Existing `startWebServer` tests pass unchanged
- [x] Gate check passes: `npx vitest run tests/web-server.test.ts`, `npx vitest run tests/web-security.test.ts`, `npx vitest run tests/setup-web.test.ts`; `npx tsc --noEmit`

**Tests**: integration
**Gate**: full
**Status**: ✅ Done

**Commit**: `ref(web): Split listening from the command server lifecycle`

---

### T5: Scope review to the repo query parameter

**What**: `/api/review` requires an absolute `repo`; the in-process `review` command opens `/review?repo=<cwd>`; the page forwards `repo`, shows the no-repo message, and keys drafts by repo.
**Where**: `src/cli/commands/review.ts` and `src/web/review-page.ts` (one working slice; splitting leaves `codedeck review` broken between commits)
**Depends on**: None (previous phase complete)
**Reuses**: `createReviewHandler`, the page's `URLSearchParams(location.search)` at `src/web/review-page.ts:627`
**Requirement**: WD-33, WD-34, WD-35, WD-36, WD-37, WD-38, WD-39

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `repo=/abs/path` → loader called with `/abs/path`
- [x] Missing `repo` → 400 `repo query parameter is required`; relative → 400 `repo must be an absolute path`; `not a git repository` → 404
- [x] Page script in `node:vm` with `?repo=%2Ftmp%2Fx&ref=HEAD` fetches a URL whose `repo` is `/tmp/x`
- [x] Page script without `repo` renders `Open this page with codedeck review inside a repository.` and calls `fetch` zero times
- [x] Draft saved under repo `/tmp/x` uses a key starting `codedeck-review:/tmp/x:`, and a draft from another repo is not loaded
- [x] The in-process review command's initial path is `/review?repo=<cwd>`
- [x] Gate check passes: `npx vitest run tests/review.test.ts`, `npx vitest run tests/review-command.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(review): Scope the review page to a repo query parameter`

---

### T6: Accept interval on the usage page URL

**What**: `/usage` passes the `interval` query value to the page renderer.
**Where**: `src/web/usage-routes.ts`
**Depends on**: T5
**Reuses**: `renderUsagePage` interval normalization
**Requirement**: WD-47

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `/usage?interval=5` renders a page configured for a 5 second poll
- [ ] `/usage?interval=0` renders the normalized 2 seconds
- [ ] Gate check passes: `npx vitest run tests/usage-web.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(usage): Read the polling interval from the page URL`

---

### T7: Refresh the setup catalog from the page URL

**What**: The setup page calls `refreshCatalog()` once after the initial load when `refresh=1`.
**Where**: `src/web/setup-page.ts`
**Depends on**: T6
**Reuses**: `globalThis.setupPage.refreshCatalog`
**Requirement**: WD-48

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] With `refresh=1`, exactly one `POST /api/setup/catalog/refresh` after the initial state and catalog loads
- [ ] Without it, zero refresh POSTs
- [ ] Gate check passes: `npx vitest run tests/setup-page.test.ts`, `npx vitest run tests/review.test.ts`, `npx vitest run tests/usage-web.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: full

**Commit**: `feat(setup): Refresh the catalog when the page URL asks for it`

---

### T8: Compute the build identity

**What**: Add `distRootFor` and `computeBuildId`.
**Where**: `src/daemon/build-id.ts` (new)
**Depends on**: None (previous phase complete)
**Reuses**: none
**Requirement**: WD-40

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Newest `.js` mtime under a temp tree, nested dirs included, non-`.js` ignored; `"0"` for an empty dir
- [ ] `distRootFor("file:///x/dist/daemon/daemon.js")` → `/x/dist`
- [ ] Gate check passes: `npx vitest run tests/build-id.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(daemon): Add a build identity from the dist tree`

---

### T9: Add the web child entry

**What**: `runWebChild` listens with the UI routes, prints the handshake line, and exits on stdin EOF or SIGTERM; `--web-child` main guard.
**Where**: `src/web/child.ts` (new)
**Depends on**: T8
**Reuses**: `listenWebServer`, `createUiRoutes`, `computeBuildId`
**Requirement**: WD-04, WD-08, WD-09, WD-40

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] With a port-0 listen, stdout gets one line `{ port, token, build }` and `/`, `/review`, `/setup`, `/usage` answer 200 after the token redirect
- [ ] No port → `fallbackToEphemeral: true`; explicit port → `false`
- [ ] Listen failure → line `{ "error": { "message", "port" } }` and exit code 1
- [ ] Ending stdin closes the server (new connection refused) and calls exit with 0, even with a request still in flight (a route that never responds)
- [ ] `process.stdout` `EPIPE` does not throw
- [ ] Gate check passes: `npx vitest run tests/web-child.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(web): Add a web child process entry`

---

### T10: Add the web supervisor

**What**: `WebSupervisor.ensure` / `close` over an injected spawn: one child, shared in-flight start, handshake timeout, error codes, exit handling, build-change restart, log lines.
**Where**: `src/daemon/web-supervisor.ts` (new)
**Depends on**: T9
**Reuses**: spawn pattern from `src/daemon/ipc.ts:197-211`
**Requirement**: WD-01, WD-02, WD-03, WD-05, WD-06, WD-07, WD-11, WD-28, WD-41, WD-42, WD-49, WD-50

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] First `ensure` spawns once and resolves `{ baseUrl, port, token }` from the fake handshake
- [ ] Same build again → no spawn; no build → no spawn; two concurrent calls → one spawn, same result
- [ ] Explicit port → `--port <n>` in args; error line → `WEB_LISTEN_FAILED` with `details.port`
- [ ] Exit before handshake → `WEB_START_FAILED`; no line in `startTimeoutMs` (fake timers) → child killed and `WEB_START_FAILED`
- [ ] Handshake split across two stdout chunks parses; non-JSON first line or a line missing `token` → child killed and `WEB_START_FAILED`
- [ ] After the handshake, further stdout data is consumed (the stream is flowing)
- [ ] `entry` spawned as the script; relative entry, entry not ending in `/web/child.js`, or missing entry → `WEB_BAD_ENTRY`, no spawn
- [ ] Same build with a different `entry` → old child stopped, new child spawned from the new entry
- [ ] Default spawn opens `logs/web-child.log` in append mode for stderr (checked via the injected spawn options factory or a spawn spy)
- [ ] Child exit after handshake → log `web child exited code=<code>`; next `ensure` spawns again
- [ ] Different build → SIGTERM to the old child, SIGKILL after `stopTimeoutMs` if it has not exited, then the new child's result
- [ ] Log gets `web listening port=<port>` and never the token
- [ ] Static check: `src/daemon/web-supervisor.ts` and `src/daemon/daemon.ts` import nothing from `../web/` or `../cli/`
- [ ] Gate check passes: `npx vitest run tests/web-supervisor.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(daemon): Supervise a web child process`

---

### T11: Serve web.ensure from the daemon

**What**: Add `web.ensure` to the protocol and daemon, map supervisor errors to IPC errors, and stop the child on shutdown.
**Where**: `src/daemon/daemon.ts` (plus the types in `src/daemon/protocol.ts`)
**Depends on**: T10
**Reuses**: `WebSupervisor`, `runShutdown`
**Requirement**: WD-01, WD-05, WD-06, WD-10, WD-43

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `web.ensure` via the seam with an injected supervisor returns its result
- [ ] Supervisor `WebEnsureError` → IPC error with the same `code`, `message`, `details`
- [ ] `handleShutdown` calls `close()` on the supervisor before marking sessions
- [ ] A seeded `working` session is unchanged after `web.ensure` calls that restart the child
- [ ] Gate check passes: `npx vitest run tests/daemon-web.test.ts`, `npx vitest run tests/web-supervisor.test.ts`, `npx vitest run tests/web-child.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: full

**Commit**: `feat(daemon): Host the web console through web.ensure`

---

### T12: Add launchWebPage

**What**: The shared web entry: ensure daemon, `web.ensure` with the local build, URL build, open or print, port notice, listen failure, in-process fallback.
**Where**: `src/cli/web-launch.ts` (new)
**Depends on**: None (previous phase complete)
**Reuses**: `IpcClient`, `openBrowser`, `startWebServer`, `createUiRoutes`, `computeBuildId`
**Requirement**: WD-17, WD-18, WD-19, WD-20, WD-21, WD-22, WD-44, WD-45, WD-46

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Success → opens `<baseUrl><path>?<query>&t=<token>`, prints `<title> on <url>`, returns 0; `web.ensure` params carry `build` and an absolute `entry` ending in `/web/child.js`
- [ ] `open: false` → prints the URL line, opener not called, returns 0
- [ ] Opener false → prints `Could not open a browser, visit <url> manually.`, returns 0
- [ ] `port` given → sent; omitted → no `port` key; result on another port → `CodeDeck web is already running on port <port>`
- [ ] `WEB_LISTEN_FAILED` → `Failed to listen on 127.0.0.1:<port>: <message>`, returns 1, no fallback
- [ ] `UNKNOWN_METHOD` and `SERVICE_UNAVAILABLE` → WD-44 line with the code, `startServer` called with the full route table, `initialPath` = path + encoded query (a repo with a space and `&` round-trips; no trailing `?` for an empty query), and `fallbackToEphemeral: true` when the port was omitted
- [ ] `ensureDaemonStarted` throws → WD-45 line and `startServer` called
- [ ] Gate check passes: `npx vitest run tests/web-launch.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cli): Open web pages through the daemon`

---

### T13: Rewire ui and review to launchWebPage

**What**: `ui` opens `/`, `review` opens `/review?repo=<cwd>`; drop the `"3100"` commander defaults.
**Where**: `src/cli/commands/review.ts` and `src/cli/commands/ui.ts`
**Depends on**: T12
**Reuses**: `launchWebPage`, `parseWebPort`
**Requirement**: WD-12, WD-13, WD-20, WD-23

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `ui` → `launchWebPage` with path `/`, no port when `--port` is omitted
- [ ] `review` → path `/review`, `repo` = cwd
- [ ] Invalid `--port` → exit 1, launcher not called
- [ ] Gate check passes: `npx vitest run tests/web-cli.test.ts`, `npx vitest run tests/review-command.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cli): Open ui and review from the daemon web server`

---

### T14: Rewire setup to launchWebPage

**What**: Setup's web branch calls `launchWebPage` without a TTY requirement or a port default; `--refresh` adds `refresh=1`; delete `createSetupCommandRoutes`.
**Where**: `src/cli/commands/setup.ts`
**Depends on**: T13
**Reuses**: `launchWebPage`
**Requirement**: WD-14, WD-15, WD-20

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Non-TTY `setup` → launcher called with `/setup`, no port, exit 0
- [ ] `setup --refresh` → query `{ refresh: "1" }`
- [ ] `setup --tui` without a TTY still fails with `<cli> setup needs a terminal`
- [ ] `tests/setup-wizard.test.ts:1190-1210` moved to the `--tui` case; `tests/setup-cli-contract.test.ts` refresh-injection cases rewritten to assert the launcher query
- [ ] Batch flag tests unchanged
- [ ] Gate check passes: `npx vitest run tests/setup-cli-contract.test.ts`, `npx vitest run tests/setup-wizard.test.ts`, `npx vitest run tests/web-cli.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(setup): Open the setup page from the daemon web server`

---

### T15: Rewire usage --web to launchWebPage

**What**: `usage --web` builds the resolved filter query and calls `launchWebPage` with `/usage`.
**Where**: `src/cli/commands/usage.ts`
**Depends on**: T14
**Reuses**: `buildUsageQueryParams`, `launchWebPage`
**Requirement**: WD-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `usage --web --today --repo x --by model --interval 5` → query has `period=today`, `repo=x`, `by=model`, `interval=5`, no empty keys
- [ ] `tests/usage-cli.test.ts:300-333` rewritten against the injected launcher; run-id, backfill, and `--web --tui` tests unchanged
- [ ] Gate check passes: `npx vitest run tests/usage-cli.test.ts`, `npx vitest run tests/web-cli.test.ts`, `npx vitest run tests/setup-cli-contract.test.ts`, `npx vitest run tests/review-command.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: full

**Commit**: `feat(usage): Open the usage page from the daemon web server`

---

### T16: Document the web IPC method and smoke-test the build

**What**: Describe `web.ensure`, the web child, and the fallback in the protocol doc; build and smoke-test against `dist/`.
**Where**: `docs/protocol.md`
**Depends on**: T15
**Reuses**: existing doc tone (Portuguese)
**Requirement**: WD-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Doc covers `web.ensure` params, result, errors, child restart on build change, and the fallback
- [ ] `npm run build` and `scripts/pty-gate.sh` pass
- [ ] Smoke run with an isolated `RUN_AGENT_DIR`: `review --no-open`, `setup --no-open`, `usage --web --no-open` each exit 0 and print URLs on one port; curl of each page after the token redirect answers 200. After the run, the isolated daemon is stopped
- [ ] Killing the web child, then `ui --no-open`, prints a working URL
- [ ] `touch dist/web/child.js`, then `review --no-open` again → a different token, and `ps` shows the same sessions as before

**Tests**: none
**Gate**: build

**Commit**: `docs(web): Document the daemon web console protocol`

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1:  T1 → T2 → T3 → T4
Phase 2:  T5 → T6 → T7
Phase 3:  T8 → T9 → T10 → T11
Phase 4:  T12 → T13 → T14 → T15 → T16
```

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | start | ✅ |
| T2 | T1 | T1 → T2 | ✅ |
| T3 | T2 | T2 → T3 | ✅ |
| T4 | T3 | T3 → T4 | ✅ |
| T5 | None (previous phase) | phase start | ✅ |
| T6 | T5 | T5 → T6 | ✅ |
| T7 | T6 | T6 → T7 | ✅ |
| T8 | None (previous phase) | phase start | ✅ |
| T9 | T8 | T8 → T9 | ✅ |
| T10 | T9 | T9 → T10 | ✅ |
| T11 | T10 | T10 → T11 | ✅ |
| T12 | None (previous phase) | phase start | ✅ |
| T13 | T12 | T12 → T13 | ✅ |
| T14 | T13 | T13 → T14 | ✅ |
| T15 | T14 | T14 → T15 | ✅ |
| T16 | T15 | T15 → T16 | ✅ |

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Web security | integration | integration | ✅ |
| T2 | Web server | integration | integration | ✅ |
| T3 | Web routes | unit | unit | ✅ |
| T4 | Web server | integration | integration | ✅ |
| T5 | Review handler + page script | unit | unit | ✅ |
| T6 | Usage route | unit | unit | ✅ |
| T7 | Setup page script | unit | unit | ✅ |
| T8 | Pure helper | unit | unit | ✅ |
| T9 | Web child | unit | unit | ✅ |
| T10 | Supervisor | unit | unit | ✅ |
| T11 | Daemon handler | unit | unit | ✅ |
| T12 | Pure helper | unit | unit | ✅ |
| T13 | CLI commands | unit | unit | ✅ |
| T14 | CLI command | unit | unit | ✅ |
| T15 | CLI command | unit | unit | ✅ |
| T16 | Docs | none | none | ✅ |
