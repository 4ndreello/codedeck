# Web access specification

## Problem Statement

The web console cannot be bookmarked. Opening `http://localhost:3100/setup` directly answers 403 `open this page with codedeck ui` (observed 2026-09-25, screenshot from the user). Three things cause it: the token is random on every web child start, the cookie that carries it dies with the browser session, and the child only exists after a CLI command asks the daemon for it. On top of that, port 3100 sits in the range dev servers use. The user wants a fixed address they can always open while the daemon runs.

## Goals

- [ ] After running any web command once on a machine, `http://127.0.0.1:7777/<page>` and `http://localhost:7777/<page>` open the page from a bookmark, across browser restarts, web child restarts, and daemon restarts.
- [ ] While the daemon runs, the console answers on its port without a prior web command.
- [ ] The port is configurable in `config.json`, and a web command says so when the console runs on a port other than the one configured.
- [ ] Every protection that exists today (Host check, Origin check on POST, cookie on `/api/*`) keeps holding.

## Current state (verified)

- `createWebSecurity(port)` draws a fresh 32-byte hex token per server (src/web/security.ts:18-25). The web child reports it in its handshake (src/web/child.ts:63).
- A valid `?t=` on a page GET sets `codedeck_ui_token_<port>=<token>; Path=/; HttpOnly; SameSite=Strict` with no `Max-Age` and answers 303 without `t` (src/web/security.ts:113-122). A page GET with no valid cookie answers 403 `open this page with codedeck ui` (src/web/security.ts:16, 64-67).
- `isAllowedWebHost` accepts `127.0.0.1:<port>` and `localhost:<port>` (src/web/security.ts:27-31). The URL the CLI opens uses `127.0.0.1` (src/daemon/web-supervisor.ts:201).
- `DEFAULT_WEB_PORT` is 3100 (src/web/server.ts:8). The child falls back to an ephemeral port only when no port was given (src/web/child.ts:37). The four web commands print `(default: 3100)` in `--port` help (src/cli/commands/setup.ts:1304, review.ts:96, usage.ts:154, ui.ts:58).
- The daemon creates the `WebSupervisor` lazily on the first `web.ensure` (src/daemon/daemon.ts:1377). `start()` never touches the web child (src/daemon/daemon.ts:328-375), and the `--daemon` entry only calls `start()` (src/daemon/daemon.ts:2003-2009).
- `launchWebPage` prints `CodeDeck web is already running on port <port>` only when `--port` was given and differs (src/cli/web-launch.ts:61-63). The in-process fallback builds its own server and token through `startWebServer` (src/cli/web-launch.ts:83).
- `loadConfig` spreads the parsed file over the defaults without validating unknown keys (src/config/config.ts:432-442). Setup saves keep keys they do not manage (src/config/setup.ts:340-343).
- No vitest setup sets `RUN_AGENT_DIR` globally (vitest.config.ts), so any code that writes under `getPaths().base` by default must be kept out of unit tests.

## External Dependencies

| Resource | Identifier | System | Verified | Evidence |
| --- | --- | --- | --- | --- |
| cookies are not isolated by port | RFC 6265 §8.5 | IETF RFC 6265 | yes | fetched rfc-editor.org/rfc/rfc6265.html 2026-09-25: "Cookies do not provide isolation by port." |
| a cookie set for `127.0.0.1` is not sent to `localhost` | RFC 6265 §5.1.3 | IETF RFC 6265 | yes | fetched rfc-editor.org/rfc/rfc6265.html 2026-09-25: domain matching requires identical strings or a host-name suffix, and an IP address never suffix-matches |
| `Max-Age` is the cookie lifetime in seconds | RFC 6265 §4.1.2.2 | IETF RFC 6265 | yes | fetched rfc-editor.org/rfc/rfc6265.html 2026-09-25 |

## Out of Scope

| Feature | Reason |
| --- | --- |
| Starting the daemon at login (systemd user unit) | "Always" here means while the daemon runs. After a reboot the first `codedeck` command starts the daemon, and with it the console. A login unit is a separate install concern. |
| Respawning the web child after a crash without a request | A crash is logged; the next web command respawns it (existing behavior). Crash-loop handling would need backoff rules this feature does not need. |
| Removing the token | The token is what keeps other local users and non-browser processes off the setup API, which rewrites the harness config. |
| A command to rotate the token | Deleting `~/.run-agent/web-token` rotates it on the next web child start; documented in `docs/protocol.md`. |
| Remote or LAN access | The server stays on 127.0.0.1. |
| New pages or page visuals | This feature changes access only. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Default port | 7777 replaces 3100 as `DEFAULT_WEB_PORT`. | The user asked for 7777; 3000-3999 collides with common dev servers. | y |
| Port config key | `web.port` in `config.json`, an integer 1-65535. Precedence: `--port`, then `web.port`, then 7777. | Matches the existing per-feature objects in the config (`autocompact`, `orchestrator`). | n |
| Configured port busy | Same as the default today: the child falls back to an OS-assigned port. The CLI notices the mismatch (WA-12). | A foreign process on 7777 must not break the console; the notice tells the user the bookmark will not work this time. | n |
| Explicit `--port` busy | Unchanged: report the listen error and exit 1. | An explicit port is a request, not a hint. | y |
| Invalid `web.port` (not an integer in 1-65535) | Treated as absent: 7777 is used and nothing fails. | Matches how `loadConfig` tolerates a broken file (src/config/config.ts:439-441); `doctor` reporting is not part of this feature. | n |
| Token storage | `~/.run-agent/web-token` (`getPaths().base`), 64 lowercase hex characters plus an optional trailing newline, created with mode 0600. | Same directory as the daemon's other state; 0600 keeps other users out. | n |
| Token file missing or malformed | Generate a new token and write it. Creation uses exclusive create, and a process that loses the race reads the winner's token. | The web child and an in-process fallback can start at the same moment; both must end up with the same token. | n |
| Who uses the stored token | The web child and the CLI in-process fallback. Unit tests keep a per-server random token unless they inject one. | Both servers must accept the same cookie, or the fallback would overwrite it (same cookie name, same host, see RFC 6265 §8.5). | n |
| Cookie lifetime | `Max-Age=31536000` (365 days), renewed on every page GET that already carries a valid cookie. | A bookmark keeps working for a year after the last visit; 365 days is below the caps browsers put on `Max-Age`. | n |
| Canonical host | `127.0.0.1`. A page GET whose Host is `localhost:<port>` answers 302 to the same path and query on `127.0.0.1:<port>`. | RFC 6265 §5.1.3: a cookie set for `127.0.0.1` is never sent to `localhost`, so without the redirect a `localhost` bookmark would get 403 forever. | n |
| When the daemon starts the child | Once, right after the daemon's IPC socket listens, from its own `dist/web/child.js`, with no explicit port. | Makes the address answer without a prior command. The existing entry/build rules still replace the child when a CLI from another tree asks. | n |
| Eager start failure | Logged to `daemon.log` as `web autostart failed: <message>`; the daemon keeps running and `web.ensure` retries later. | The web console must never keep the daemon from starting. | n |
| 403 page text | `Run "codedeck ui" once in a terminal to open CodeDeck in this browser.` | The old text did not say the step is one-time. | n |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Bookmark survives restarts ⭐ MVP

**User Story**: As a developer, I want a console URL I can bookmark so that I open setup, usage, or review without going through the terminal each time.

**Why P1**: This is the reported pain.

**Acceptance Criteria**:

1. WHEN the web child starts and `~/.run-agent/web-token` holds a valid token THEN the child SHALL serve with that token and report it in its handshake.  <!-- WA-01 -->
2. IF `~/.run-agent/web-token` is missing or malformed THEN the web child SHALL write a new 64-character lowercase hex token to it with mode 0600 and serve with that token.  <!-- WA-02 -->
3. WHEN two processes create the token file at the same time THEN both SHALL end up serving with the token that is in the file.  <!-- WA-03 -->
4. WHEN the CLI serves in-process because the daemon cannot host the console THEN it SHALL use the token from `~/.run-agent/web-token` under the same rules as the web child.  <!-- WA-04 -->
5. WHEN a page GET carries a valid `?t=` THEN the server SHALL answer 303 with `Set-Cookie: codedeck_ui_token_<port>=<token>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`.  <!-- WA-05 -->
6. WHEN a page GET carries a valid cookie and no `t` THEN the server SHALL serve the page with the same `Set-Cookie` header as WA-05.  <!-- WA-06 -->
7. WHEN a page GET arrives with Host `localhost:<port>` THEN the server SHALL answer 302 with `Location: http://127.0.0.1:<port><path><query>` and SHALL NOT check the token or cookie first.  <!-- WA-07 -->
8. IF a page GET on `127.0.0.1:<port>` has no valid `t` and no valid cookie THEN the server SHALL answer 403 with the body `Run "codedeck ui" once in a terminal to open CodeDeck in this browser.`  <!-- WA-08 -->
9. The server SHALL keep rejecting requests with any Host other than `127.0.0.1:<port>` or `localhost:<port>`, POSTs without a valid cookie and same-origin `Origin`, and `/api/*` requests without a valid cookie, each with 403 `forbidden`.  <!-- WA-09 -->

**Independent Test**: open `codedeck ui` once, close the browser, kill the web child, run `codedeck setup --no-open`, then open `http://localhost:7777/setup` from a fresh browser window: the page loads without a token.

---

### P1: Console answers while the daemon runs ⭐ MVP

**User Story**: As a developer, I want the console to be up whenever the daemon is so that the bookmark works without first running a web command.

**Why P1**: A stable token does not help if nothing listens on the port.

**Acceptance Criteria**:

1. WHEN the daemon's IPC socket starts listening THEN the daemon SHALL start the web child once, from its own `dist/web/child.js`, without an explicit port.  <!-- WA-10 -->
2. IF the eager start fails THEN the daemon SHALL append `web autostart failed: <message>` to `daemon.log`, keep serving IPC, and start the child on the next `web.ensure`.  <!-- WA-11 -->

**Independent Test**: stop the daemon, run `codedeck ps` (which starts the daemon), then `curl -sI http://127.0.0.1:7777/` answers 403 instead of refusing the connection.

---

### P2: Fixed, configurable port

**User Story**: As a developer, I want the console on a port I choose so that the bookmark does not collide with my dev servers.

**Why P2**: 7777 alone serves most users; the config key covers collisions.

**Acceptance Criteria**:

1. The web server SHALL use port 7777 when neither `--port` nor a valid `web.port` is given.  <!-- WA-12 -->
2. WHERE `config.json` holds a valid `web.port` the web child SHALL listen on that port when no `--port` is given.  <!-- WA-13 -->
3. IF the configured or default port is busy THEN the web child SHALL listen on an OS-assigned port.  <!-- WA-14 -->
4. WHEN a web command gets a console URL whose port differs from the preferred port (`--port`, else `web.port`, else 7777) THEN it SHALL print `CodeDeck web is running on port <actual> instead of <preferred>` before the page line.  <!-- WA-15 -->
5. IF `web.port` is not an integer in 1-65535 THEN the web child and the CLI SHALL treat it as absent.  <!-- WA-16 -->
6. The `--port` help of `review`, `setup`, `usage`, and `ui` SHALL read `port to listen on (default: 7777, or web.port from config)`.  <!-- WA-17 -->

**Independent Test**: set `"web": { "port": 7788 }`, restart the daemon, and `curl -sI http://127.0.0.1:7788/` answers 403; occupy 7788 with `nc -l 7788`, restart the daemon, run `codedeck ui --no-open`, and the notice names the fallback port.

---

## Edge Cases

- IF the token file exists with other content (a truncated write, a hand edit) THEN the child SHALL replace it per WA-02.
- WHEN the web child restarts on the same port (build change, crash plus a new command) THEN a browser with the cookie SHALL load pages without a new `?t=` (follows from WA-01 and WA-06).
- WHEN the daemon already serves on the preferred port and a web command passes no `--port` THEN the command SHALL print no port notice.
- IF a `localhost` page GET carries `?t=` THEN the 302 SHALL keep `t` in the query so the `127.0.0.1` request can set the cookie (follows from WA-07).

---

## Implicit-requirement sweep

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | WA-16 (`web.port`), WA-02 (token format). |
| Failure / partial-failure states | WA-11 (eager start), WA-14 (busy port), WA-02 (malformed token). |
| Idempotency / retry / duplicate handling | WA-03 (concurrent token creation); WA-10 starts the child once. |
| Auth boundaries & rate limits | WA-09 keeps the existing checks; rate limits N/A because the server listens on loopback only. |
| Concurrency / ordering | WA-03; supervisor start sharing is unchanged from web-daemon. |
| Data lifecycle / expiry | WA-05/WA-06 (365-day sliding cookie); token rotation by file deletion is out of scope. |
| Observability | WA-11 log line, WA-15 CLI notice. |
| External-dependency failure | N/A because the only external behavior is browser cookie handling, fixed by RFC 6265. |
| State-transition integrity | N/A because this feature adds no new states; the supervisor's lifecycle is unchanged. |

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WA-01 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-02 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-03 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-04 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-05 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-06 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-07 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-08 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-09 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-10 | P1: Console answers while the daemon runs | Tasks | Pending |
| WA-11 | P1: Console answers while the daemon runs | Tasks | Pending |
| WA-12 | P2: Fixed, configurable port | Tasks | Pending |
| WA-13 | P2: Fixed, configurable port | Tasks | Pending |
| WA-14 | P2: Fixed, configurable port | Tasks | Pending |
| WA-15 | P2: Fixed, configurable port | Tasks | Pending |
| WA-16 | P2: Fixed, configurable port | Tasks | Pending |
| WA-17 | P2: Fixed, configurable port | Tasks | Pending |

**Coverage:** 17 total, 0 mapped to tasks, 17 unmapped ⚠️

---

## Success Criteria

- [ ] A `localhost:7777` bookmark opens setup after a browser restart and after a daemon restart, with no terminal step.
- [ ] `curl -sI http://127.0.0.1:7777/` answers 403 within 5 s of the daemon starting.
- [ ] No existing 403 case in `tests/web-server.test.ts` starts passing a request it rejected before.
