# Web daemon specification

## Problem Statement

Every web command (`review`, `setup`, `usage --web`, `ui`) starts its own HTTP server inside the CLI process, and all of them default to port 3100. A second web command fails with `EADDRINUSE` while the first one runs (observed 2026-09-24: `review --port 3188` running, `usage --web --port 3188` printed `Failed to listen on 127.0.0.1:3188: listen EADDRINUSE` and exited 1). The daemon already lives across commands, so it should own the one web server: start it, hand out its URL, and restart it when the code changes.

## Goals

- [ ] One web server, supervised by the daemon, serves every page; running `review`, `setup`, `usage --web`, and `ui` in any order opens pages on the same origin without a port conflict.
- [ ] Web commands return to the shell after opening or printing the URL instead of holding the terminal.
- [ ] A web server failure never stops the daemon or touches a session.
- [ ] After `npm run build`, the next web command serves pages from the new build without restarting the daemon.

## Current state (verified)

- `startWebServer` (src/web/server.ts:92-173) binds 127.0.0.1, creates a per-start token after listen, opens or prints `?t=<token>`, and installs SIGINT/SIGTERM handlers that call `process.exit(0)` (src/web/server.ts:135-159).
- `checkWebRequest` (src/web/security.ts:39-60) checks Host on every request, requires cookie + Origin only on POST, and bootstraps the cookie from a valid `t` on HTML GETs. The 303 removes only `t` and keeps other query parameters (src/web/security.ts:99-104). API GETs need no cookie.
- `dispatchRequest` calls the route handler with no error handling (src/web/server.ts:175-196). The setup routes discard their async promises with `void` (src/web/setup-routes.ts:566-575).
- `createUiRoutes` (src/cli/commands/ui.ts:21-48) composes home, review, setup, and usage routes into one table. With default dependencies, usage goes through `fetchUsageQuery`, which uses daemon IPC and falls back to read-only SQLite (src/cli/commands/usage.ts:88-128).
- The review handler reads the repo from `process.cwd()` at request time (src/cli/commands/review.ts:44). The page fetches `api/review?ref=` only (src/web/review-page.ts:627-629). Review drafts live in localStorage under `codedeck-review:<file>:<line>`, without the repo (src/web/review-page.ts:209-210).
- `usage --web` resolves CLI filters into page options (src/cli/commands/usage.ts:214-243). `/usage` reads `period`, `repo`, `model`, `agent`, `since`, `until`, `by` from the query but not `interval` (src/web/usage-routes.ts:43-62).
- `setup` web requires a TTY on stdin and stdout before it starts the server (src/cli/commands/setup.ts:1269-1274), defaults a missing `--port` to 3100 (src/cli/commands/setup.ts:1291), and `--refresh` injects a catalog refresh script (src/cli/commands/setup.ts:1235-1251).
- `daemon.stop` ignores params and runs `handleShutdown`, which marks every active session `interrupted` and kills its process tree (src/daemon/daemon.ts:1352-1355, 1854-1874). This feature does not change `daemon.stop`.
- IPC errors carry only `code`, `message`, `details` (src/daemon/protocol.ts:267). Unknown methods answer `UNKNOWN_METHOD` (src/daemon/daemon.ts:1358).

## Out of Scope

| Feature | Reason |
| --- | --- |
| Restarting the daemon itself when its build is stale | A daemon stop interrupts sessions (src/daemon/daemon.ts:1863-1874). The web child restart covers page staleness. |
| New pages (live sessions, logs over SSE) | This feature moves hosting; new pages build on it later. |
| Persisting the web token across web child restarts | A restart invalidates old tabs; rerunning the command gives a fresh link. |
| Listing recent repositories on the review page | Review stays single-repo, chosen by the command's cwd. |
| Changing page visuals or setup/usage API payloads | Pages and JSON contracts stay as they are except where listed below. |
| Remote access | The server stays on 127.0.0.1. |
| Setup `--tui`, setup batch flags, usage TUI/JSON/single-run/backfill paths | They do not start a web server and keep their current behavior. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Where HTTP runs | In a web child process the daemon spawns from the `dist/web/child.js` of the requesting CLI (`entry` in `web.ensure`), or from its own dist tree when `entry` is absent. The daemon process never listens on HTTP itself. | A crash or hang in the web stack cannot reach the daemon, and a fresh child loads the newest code from disk. | n |
| When the child starts | Lazily, on the first `web.ensure` IPC request. | No open port unless someone uses the web console. | n |
| Child lifetime | Until the daemon exits, the child crashes, or a build change restarts it. The child exits when its stdin pipe from the daemon closes. | A daemon killed with SIGKILL must not leave an orphan holding port 3100. | n |
| Child startup handshake | The child prints one JSON line on stdout: `{ "port", "token", "build" }` on success or `{ "error": { "message", "port" } }` on listen failure. The daemon buffers until the first newline, waits up to 5000 ms, then keeps draining and discarding stdout. | Simple and testable; draining keeps a later write from blocking on a full pipe. | n |
| Child stderr | Appended to `~/.run-agent/logs/web-child.log`. | The exit code alone does not explain a crash. | n |
| Build identity | The newest mtime (ms) of `.js` files under the dist root (the directory two levels above the module file), as a decimal string, `"0"` when none. The child computes it at start; the CLI computes it over its own dist root and sends it in `web.ensure` together with `entry`, the absolute path of its own `dist/web/child.js`. The daemon identifies a child by `(entry, build)`. | `tsc` rewrites every emitted file on a full build and only changed files in watch mode; the newest mtime covers both. | n |
| Build or entry mismatch | The daemon stops the running child and starts one from the requested `entry` before answering. | The child restart touches no session, and each CLI gets the pages of its own tree. |
| Two dist trees sharing one daemon (global install and dev checkout, the setup on this machine) | Alternating commands from the two trees restart the child each time; repeated commands from one tree reuse it. Accepted. | The cost is a new token, not lost work, and each tree serves its own pages. | n |
| Command lifetime | Web commands exit 0 after opening or printing the URL. Ctrl+C no longer closes the server. | The server belongs to the daemon. | n |
| Preferred port | 3100, or the command's `--port`, honored only when the daemon starts a child. | Keeps the existing flag meaningful. | n |
| Default port busy | The child falls back to an OS-assigned port and reports it. | A foreign process on 3100 must not break the console. | n |
| Explicit `--port` busy | Report the listen error, exit 1, start nothing. | An explicit port is a request, not a hint. | n |
| Server already running on another port | Use it and print a notice naming the actual port. | Restarting would invalidate open tabs. | n |
| Usage data in the child | The child uses the default `fetchUsageQuery` (IPC `usage.query`, read-only SQLite fallback). | Reuses the existing path; the daemon is alive while the child runs. | n |
| Review repository | The command sends its cwd as `repo`; the page forwards `repo` to `/api/review`. Without `repo`, the page shows `Open this page with codedeck review inside a repository.` and makes no API request. | The child's cwd is meaningless for review. `codedeck ui` has no repo to pass. | n |
| API GET auth | Every `/api/*` request requires the session cookie. | A long-lived server that reads any repo by path must not answer unauthenticated local callers. | n |
| Page GET without token or cookie | 403 with the text `open this page with codedeck ui`. | Without the cookie the page's API calls fail anyway. | n |
| Usage filters from CLI flags | The command resolves flags into concrete query parameters on the URL. | The child cannot see the command's cwd or flags. | n |
| `setup --refresh` | Opens `/setup?refresh=1`; the page refreshes the catalog once on load. | Replaces per-command script injection. | n |
| Setup TTY requirement | Removed for the web path, kept for `--tui`. | A browser page does not need the terminal. | n |
| Daemon cannot host | Any `web.ensure` failure other than an explicit-port listen error (unknown method from an older daemon, shutdown in progress, child start timeout, socket error) or a daemon start failure makes the command serve in-process, as today, with a one-line notice. | The web console must keep working during the upgrade and when the daemon is broken. | n |
| Concurrent daemon starts | Two web commands can still race `ensureDaemonStarted` as today. No new lock. | Existing behavior; this feature adds no daemon restarts. | n |

**Open questions:** none. All resolved or logged above.

---

## User Stories

### P1: Daemon supervises one web server ⭐ MVP

**User Story**: As a CodeDeck user, I want every web command to open pages from one daemon-supervised server so that I can open review, setup, and usage at the same time.

**Why P1**: This removes the port conflict, which is the reason for the feature.

**Acceptance Criteria**:

1. WHEN the daemon receives `web.ensure` and no web child runs THEN the daemon SHALL spawn the web child from the request's `entry` (or its own `dist/web/child.js` when `entry` is absent) and return `{ baseUrl, port, token }` from its handshake. WD-01
2. WHEN the daemon receives `web.ensure` with the same `entry` and `build` as the running child THEN the daemon SHALL return the running child's `baseUrl`, `port`, and `token` without spawning. WD-02
3. WHEN two `web.ensure` requests arrive before the first handshake completes THEN the daemon SHALL spawn exactly one child and return the same result to both. WD-03
4. IF `web.ensure` has no `port` and 3100 is in use THEN the child SHALL listen on an OS-assigned port and the daemon SHALL return that port. WD-04
5. IF `web.ensure` has an explicit `port` and that port is in use THEN the daemon SHALL return an error with code `WEB_LISTEN_FAILED`, the listen error as `message`, and `{ port }` as `details`. WD-05
6. IF the child exits before its handshake, sends no handshake line within 5000 ms, or sends a first line that is not JSON with a numeric `port` and a string `token` (or an `error` object) THEN the daemon SHALL kill it and return an error with code `WEB_START_FAILED`. WD-06
7. WHEN the web child exits after its handshake THEN the daemon SHALL mark the web server stopped, append `web child exited code=<code>` to the daemon log, and spawn a new child on the next `web.ensure`. WD-07
8. The web child SHALL serve the `createUiRoutes` table: `/`, `/review`, `/api/review`, `/setup`, the `/api/setup/*` routes, `/usage`, and `/api/usage`. WD-08
9. WHEN the web child's stdin reaches end of stream or it receives SIGTERM THEN the child SHALL stop listening, close all open connections, and exit with code 0 without waiting for in-flight requests. WD-09
10. WHEN the daemon shuts down while a web child runs THEN the daemon SHALL send SIGTERM to the child without waiting for it to exit. WD-10
11. WHEN a web child completes its handshake THEN the daemon SHALL append `web listening port=<port>` to the daemon log, without the token. WD-11

**Independent Test**: Drive `web.ensure` through the daemon seam with an injected spawn that returns a fake child; assert one spawn for repeated and concurrent calls, the error codes, and the log lines. Run the child entry function with injected stdin/stdout and a port-0 listener; assert the handshake line, the served routes, and exit on stdin end.

---

### P1: Web commands delegate to the daemon ⭐ MVP

**User Story**: As a CodeDeck user, I want `review`, `setup`, `usage --web`, and `ui` to open the daemon's page and return me to the shell.

**Why P1**: Without this the daemon server has no entry point.

**Acceptance Criteria**:

1. WHEN `codedeck ui` runs THEN the command SHALL ensure the daemon, call `web.ensure` with its local build, and open `<baseUrl>/?t=<token>`. WD-12
2. WHEN `codedeck review` runs THEN the command SHALL open `<baseUrl>/review?repo=<cwd>&t=<token>`. WD-13
3. WHEN `codedeck setup` runs without batch or `--tui` flags THEN the command SHALL open `<baseUrl>/setup?t=<token>` without requiring a TTY. WD-14
4. WHEN `codedeck setup --refresh` runs THEN the command SHALL open `<baseUrl>/setup?refresh=1&t=<token>`. WD-15
5. WHEN `codedeck usage --web` runs THEN the command SHALL open `<baseUrl>/usage?<filters>&t=<token>`, where the filters are the non-empty values of `period`, `repo`, `model`, `agent`, `since`, `until` resolved from its flags and cwd, plus `by` and `interval` from its options. WD-16
6. WHEN a web command opens the URL THEN the command SHALL print `<title> on <url>` and exit with code 0. WD-17
7. WHEN a web command runs with `--no-open` THEN the command SHALL print `<title> on <url>` without opening a browser and exit with code 0. WD-18
8. IF the browser cannot be opened THEN the command SHALL print `Could not open a browser, visit <url> manually.` and exit with code 0. WD-19
9. WHEN a web command runs with `--port <n>` THEN the command SHALL send `n` as `port` in `web.ensure`; WHEN `--port` is omitted THEN the command SHALL send no `port`. WD-20
10. IF `web.ensure` returns a port different from an explicit `--port` THEN the command SHALL print `CodeDeck web is already running on port <port>` before the URL line. WD-21
11. IF `web.ensure` returns `WEB_LISTEN_FAILED` THEN the command SHALL print `Failed to listen on 127.0.0.1:<port>: <message>` and exit with code 1. WD-22
12. IF `--port` is not an integer from 1 through 65535 THEN the command SHALL report the port error, exit with code 1, and send no IPC request. WD-23

**Independent Test**: Run each command with an injected launcher or IPC client and browser opener; assert the `web.ensure` params, the opened URL, the printed lines, and the exit code.

---

### P1: Web failures stay isolated ⭐ MVP

**User Story**: As a CodeDeck user, I want a broken web page to leave my running agents and the rest of the console alone.

**Why P1**: A long-lived server must survive one bad request.

**Acceptance Criteria**:

1. IF a route handler throws synchronously THEN the server SHALL respond 500 with `{ "error": "<message>" }` when headers are not yet sent. WD-24
2. IF a route handler returns a rejected promise THEN the server SHALL respond 500 with `{ "error": "<message>" }` when headers are not yet sent. WD-25
3. IF a route handler fails after headers are sent THEN the server SHALL end the response without writing a second status line and keep serving later requests. WD-26
4. The setup API route handlers SHALL return their async work to the dispatcher instead of discarding it. WD-27
5. The daemon process SHALL NOT import `src/web/server.ts` or open an HTTP listener. WD-28

**Independent Test**: Register throwing, rejecting, and late-failing routes on a port-0 server and assert the responses; make a real setup mutation route throw and assert a 500 instead of an unhandled rejection.

---

### P1: Long-lived server authentication ⭐ MVP

**User Story**: As a CodeDeck user, I want the web server to answer only my browser session.

**Why P1**: The server now outlives the command and reads any repository path it is given.

**Acceptance Criteria**:

1. IF an `/api/*` request lacks a cookie whose value equals the current token THEN the server SHALL respond 403 `forbidden` before the route handler runs. WD-29
2. IF an HTML page GET carries neither a valid `t` nor a valid cookie THEN the server SHALL respond 403 with the body `open this page with codedeck ui`. WD-30
3. WHEN an HTML page GET carries a valid `t` THEN the server SHALL set the cookie and respond 303 to the same path and remaining query without `t`. WD-31
4. The server SHALL keep the existing Host check and the POST Origin check. WD-32

**Independent Test**: Request an API route with and without the cookie, a page with no credentials, and `/review?repo=%2Fx&t=<token>`; assert 403, 403 with the message, and 303 to `/review?repo=%2Fx` with `Set-Cookie`.

---

### P1: Review reads the requested repository ⭐ MVP

**User Story**: As a CodeDeck user, I want `codedeck review` in any repo to show that repo's changes even though the server started elsewhere.

**Why P1**: Without it, review shows the server's cwd.

**Acceptance Criteria**:

1. WHEN `/api/review` receives `repo=<path>` THEN the handler SHALL load the review from `<path>`. WD-33
2. IF `/api/review` receives no `repo` parameter THEN the handler SHALL respond 400 with `{ "error": "repo query parameter is required" }`. WD-34
3. IF `repo` is not an absolute path THEN the handler SHALL respond 400 with `{ "error": "repo must be an absolute path" }`. WD-35
4. IF loading `repo` fails with a `not a git repository` error THEN the handler SHALL respond 404 with that error. WD-36
5. WHEN the review page loads with `repo` in its query THEN the page SHALL send that `repo` value on every `/api/review` request. WD-37
6. WHEN the review page loads without `repo` THEN the page SHALL show `Open this page with codedeck review inside a repository.` and make no `/api/review` request. WD-38
7. The review page SHALL include `repo` in every draft localStorage key. WD-39

**Independent Test**: Call the review handler with an injected loader and each `repo` variant; run the page script in `node:vm` with a fake `fetch` and `localStorage` and assert the requested URL, the no-repo message, and the draft keys.

---

### P2: Web child restarts on build change

**User Story**: As a developer iterating on pages, I want a web command after `npm run build` to serve the new pages without restarting the daemon by hand.

**Why P2**: The server works without it, but every page change would need a manual restart.

**Acceptance Criteria**:

1. The web child SHALL compute its build identity at start and include it as `build` in its handshake. WD-40
2. WHEN the daemon receives `web.ensure` whose `build` or `entry` differs from the running child's THEN the daemon SHALL send SIGTERM to the running child, wait up to 3000 ms for it to exit, send SIGKILL if it has not, spawn a new child, and return the new child's result. WD-41
3. WHEN the daemon receives `web.ensure` without `build` while a child runs, and the request either omits `entry` or sends the running child's `entry`, THEN the daemon SHALL return the running child's result. WD-42
4. WHILE the daemon restarts the web child the daemon SHALL leave every session row and session process untouched. WD-43

**Independent Test**: With a fake spawn, ensure with build `a`, then with build `b`; assert SIGTERM to the first child, a second spawn, and the second child's token in the result; seed a `working` session and assert its row is unchanged.

---

### P2: In-process fallback

**User Story**: As a CodeDeck user, I want the web console to open even when the daemon cannot host it.

**Why P2**: This covers the upgrade from a daemon without `web.ensure` and a broken daemon.

**Acceptance Criteria**:

1. IF `web.ensure` fails with any error other than `WEB_LISTEN_FAILED` THEN the command SHALL print `CodeDeck daemon cannot host the web console (<code>); serving from this process.` and start the pages in-process with the full route table, an initial path whose query is encoded with `URLSearchParams`, and an ephemeral-port fallback when `--port` was omitted. WD-44
2. IF `ensureDaemonStarted` fails THEN the command SHALL print `CodeDeck daemon is unavailable; serving from this process.` and start the pages in-process. WD-45
3. WHILE a command serves in-process the command SHALL keep running until SIGINT or SIGTERM, with the current `startWebServer` behavior. WD-46

**Independent Test**: Drive a web command with an IPC client that answers `UNKNOWN_METHOD`, then `SERVICE_UNAVAILABLE`, then one whose start fails; assert the in-process server factory runs with the initial path and query, and the message prints.

---

## Edge Cases

- IF `interval` is present in the `/usage` query THEN the page SHALL use it as the polling interval with the existing `Math.max(1, Number(value) || 2)` normalization. WD-47
- WHEN `/setup` loads with `refresh=1` THEN the page SHALL send `POST /api/setup/catalog/refresh` exactly once after its initial load. WD-48
- IF `web.ensure` carries an `entry` that is not absolute, does not end in `/web/child.js`, or does not exist THEN the daemon SHALL return an error with code `WEB_BAD_ENTRY` and spawn nothing. WD-49
- WHEN the web child writes to stderr THEN the daemon SHALL append it to `~/.run-agent/logs/web-child.log`. WD-50

---

## Implicit-requirement sweep

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | WD-23 (port), WD-34 to WD-36 (repo), WD-47 (interval), WD-49 (entry), WD-06 (handshake shape). |
| Failure / partial-failure states | WD-05, WD-06, WD-07, WD-22, WD-24 to WD-26, WD-44, WD-45. |
| Idempotency / retry / duplicates | WD-02, WD-03, WD-07. |
| Auth boundaries & rate limits | WD-29 to WD-32. Rate limits N/A because the server binds loopback and requires the token. |
| Concurrency / ordering | WD-03; concurrent daemon starts logged in Assumptions. |
| Data lifecycle / expiry | WD-09, WD-10, WD-41; the token dies with its child (Out of Scope: persistence). Draft keys per repo: WD-39. |
| Observability | WD-07 and WD-11 (daemon log), WD-50 (child stderr); command lines in WD-17, WD-21, WD-22, WD-44, WD-45. |
| External-dependency failure | WD-19 (browser), WD-45 (daemon start), WD-06 (child start). |
| State-transition integrity | Web child: none → starting → running (WD-01, WD-03); starting → none on failure (WD-05, WD-06); running → none on exit (WD-07); running → restarting → running on build change (WD-41). Sessions untouched: WD-43. |

---

## External Dependencies

| Resource | Identifier | System | Verified | Evidence |
| --- | --- | --- | --- | --- |
| Node listen error code for a busy port | EADDRINUSE | Node.js | yes | observed 2026-09-24: `usage --web --port 3188` printed `listen EADDRINUSE: address already in use 127.0.0.1:3188` |
| daemon error code for an unknown IPC method | UNKNOWN_METHOD | repo | yes | src/daemon/daemon.ts:1358 |
| daemon error code while shutting down | SERVICE_UNAVAILABLE | repo | yes | src/daemon/daemon.ts:579 |
| current review page API call | api/review?ref= | repo | yes | src/web/review-page.ts:629 |
| new daemon error code for a busy explicit port | WEB_LISTEN_FAILED | repo | yes | defined in WD-05; implemented in src/daemon/daemon.ts |
| new daemon error code for a failed child start | WEB_START_FAILED | repo | yes | defined in WD-06; implemented in src/daemon/daemon.ts |
| new daemon error code for an invalid child entry | WEB_BAD_ENTRY | repo | yes | defined in WD-49; implemented in src/daemon/web-supervisor.ts |
| web child stderr log under the logs dir | ~/.run-agent/logs/web-child.log | repo | yes | src/config/paths.ts:47 (logsDir) |
| page URLs built by the commands | <baseUrl>/?t=<token> | repo | yes | src/web/server.ts:121-123 (URL + token construction reused) |
| review URL | <baseUrl>/review?repo=<cwd>&t=<token> | repo | yes | src/web/server.ts:121-123 |
| setup URL | <baseUrl>/setup?t=<token> | repo | yes | src/web/server.ts:121-123 |
| setup refresh URL | <baseUrl>/setup?refresh=1&t=<token> | repo | yes | src/web/server.ts:121-123 |
| usage URL | <baseUrl>/usage?<filters>&t=<token> | repo | yes | src/web/server.ts:121-123 |

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WD-01 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-02 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-03 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-04 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-05 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-06 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-07 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-08 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-09 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-10 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-11 | P1: Daemon supervises one web server | Tasks | Verified |
| WD-12 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-13 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-14 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-15 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-16 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-17 | P1: Web commands delegate to the daemon | Tasks | Verified |
| WD-18 | P1: Web commands delegate to the daemon | Tasks | Verified |
| WD-19 | P1: Web commands delegate to the daemon | Tasks | Verified |
| WD-20 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-21 | P1: Web commands delegate to the daemon | Tasks | Verified |
| WD-22 | P1: Web commands delegate to the daemon | Tasks | Verified |
| WD-23 | P1: Web commands delegate to the daemon | Tasks | Pending |
| WD-24 | P1: Web failures stay isolated | Tasks | Verified |
| WD-25 | P1: Web failures stay isolated | Tasks | Verified |
| WD-26 | P1: Web failures stay isolated | Tasks | Verified |
| WD-27 | P1: Web failures stay isolated | Tasks | Verified |
| WD-28 | P1: Web failures stay isolated | Tasks | Verified |
| WD-29 | P1: Long-lived server authentication | Tasks | Verified |
| WD-30 | P1: Long-lived server authentication | Tasks | Verified |
| WD-31 | P1: Long-lived server authentication | Tasks | Verified |
| WD-32 | P1: Long-lived server authentication | Tasks | Verified |
| WD-33 | P1: Review reads the requested repository | Tasks | Verified |
| WD-34 | P1: Review reads the requested repository | Tasks | Verified |
| WD-35 | P1: Review reads the requested repository | Tasks | Verified |
| WD-36 | P1: Review reads the requested repository | Tasks | Verified |
| WD-37 | P1: Review reads the requested repository | Tasks | Verified |
| WD-38 | P1: Review reads the requested repository | Tasks | Verified |
| WD-39 | P1: Review reads the requested repository | Tasks | Verified |
| WD-40 | P2: Web child restarts on build change | Tasks | Verified |
| WD-41 | P2: Web child restarts on build change | Tasks | Verified |
| WD-42 | P2: Web child restarts on build change | Tasks | Verified |
| WD-43 | P2: Web child restarts on build change | Tasks | Verified |
| WD-44 | P2: In-process fallback | Tasks | Verified |
| WD-45 | P2: In-process fallback | Tasks | Verified |
| WD-46 | P2: In-process fallback | Tasks | Verified |
| WD-47 | Edge cases | Tasks | Verified |
| WD-48 | Edge cases | Tasks | Verified |
| WD-49 | Edge cases | Tasks | Verified |
| WD-50 | Edge cases | Tasks | Verified |

**Coverage:** 50 total, 50 mapped to tasks (see tasks.md), 0 unmapped.

---

## Success Criteria

- [ ] `codedeck review`, then `codedeck setup`, then `codedeck usage --web` all print URLs on the same port and each exits 0.
- [ ] Killing the web child leaves every session running, and the next web command serves pages again.
- [ ] After `npm run build`, the next web command prints a URL whose page comes from the new build, and `codedeck ps` shows the same sessions as before.
