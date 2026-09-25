# Web access specification

## Problem Statement

The web console cannot be bookmarked. Opening `http://localhost:3100/setup` directly answers 403 `open this page with codedeck ui` (observed 2026-09-24, screenshot from the user). Three things cause it: the token is random on every web child start, the cookie that carries it dies with the browser session, and the child only exists after a CLI command asks the daemon for it. On top of that, port 3100 sits in the range dev servers use. The user wants a fixed address they can always open while the daemon runs.

## Goals

- [ ] After running any web command once on a machine, `http://127.0.0.1:7777/<page>` and `http://localhost:7777/<page>` open the page from a bookmark, across browser restarts, web child restarts, and daemon restarts.
- [ ] While the daemon runs, the console answers on its port without a prior web command.
- [ ] The port is configurable in `config.json`, a config change takes effect on the next web command without restarting the daemon, and a web command says so when the console runs on a port other than the one asked for.
- [ ] Every protection that exists today (Host check, Origin check on POST, cookie on `/api/*`) keeps holding.

## Current state (verified)

- `createWebSecurity(port)` draws a fresh 32-byte hex token per server (src/web/security.ts:18-25). The web child reports it in its handshake (src/web/child.ts:59).
- A valid `?t=` on a page GET sets `codedeck_ui_token_<port>=<token>; Path=/; HttpOnly; SameSite=Strict` with no `Max-Age` and answers 303 without `t` (src/web/security.ts:113-122). A page GET with no valid cookie answers 403 `open this page with codedeck ui` (src/web/security.ts:16, 64-67). A page GET with an invalid `t` and a valid cookie serves the page (src/web/security.ts:113-114, 64).
- `isAllowedWebHost` accepts `127.0.0.1:<port>` and `localhost:<port>` (src/web/security.ts:27-31). The URL the CLI opens uses `127.0.0.1` (src/daemon/web-supervisor.ts:201).
- `DEFAULT_WEB_PORT` is 3100 (src/web/server.ts:8). `listenWebServer` falls back to an ephemeral port only on `EADDRINUSE` and only with `fallbackToEphemeral` (src/web/server.ts:122-126). The child sets it only when no port was given (src/web/child.ts:37). The four web commands print `(default: 3100)` in `--port` help (src/cli/commands/setup.ts:1304, review.ts:96, usage.ts:154, ui.ts:58).
- The supervisor reuses a running child whatever port is asked (`matches`, src/daemon/web-supervisor.ts:129-133), and a request that arrives while a start is in flight gets that start's promise, ignoring its own params (src/daemon/web-supervisor.ts:105).
- The daemon creates the `WebSupervisor` lazily on the first `web.ensure` (src/daemon/daemon.ts:1377). `start()` never touches the web child (src/daemon/daemon.ts:328-385), and the `--daemon` entry only calls `start()` (src/daemon/daemon.ts:2003-2009). Tests call `start()` directly (tests/orchestrator-usage-daemon.test.ts:449, 485, 499).
- `scripts/pty-gate.sh` runs a real daemon under a temp `RUN_AGENT_DIR`, and its EXIT trap only deletes directories (scripts/pty-gate.sh:21), so the daemon outlives the gate.
- `launchWebPage` prints `CodeDeck web is already running on port <port>` only when `--port` was given and differs (src/cli/web-launch.ts:61-63). The in-process fallback listens on `options.port ?? DEFAULT_WEB_PORT` with its own random token (src/cli/web-launch.ts:83-85).
- `loadConfig` spreads the parsed file over the defaults without validating unknown keys (src/config/config.ts:432-442). Setup saves keep keys they do not manage (src/config/setup.ts:340-343). The daemon already imports `loadConfig` (src/daemon/daemon.ts:24).
- No vitest setup sets `RUN_AGENT_DIR` globally (vitest.config.ts), so any code that writes under `getPaths().base` by default must be kept out of unit tests.

## External Dependencies

| Resource | Identifier | System | Verified | Evidence |
| --- | --- | --- | --- | --- |
| cookies are not isolated by port | RFC 6265 §8.5 | IETF RFC 6265 | yes | fetched rfc-editor.org/rfc/rfc6265.html 2026-09-24: "Cookies do not provide isolation by port." |
| a cookie set for `127.0.0.1` is not sent to `localhost` | RFC 6265 §5.1.3 | IETF RFC 6265 | yes | fetched rfc-editor.org/rfc/rfc6265.html 2026-09-24: domain matching requires identical strings or a host-name suffix, and an IP address never suffix-matches |
| `Max-Age` is the cookie lifetime in seconds | RFC 6265 §4.1.2.2 | IETF RFC 6265 | yes | fetched rfc-editor.org/rfc/rfc6265.html 2026-09-24 |
| web port constant | DEFAULT_WEB_PORT | repo | yes | src/web/server.ts:8 |
| test state override | RUN_AGENT_DIR | repo | yes | src/config/paths.ts:15 |

## Supersedes (web-daemon)

| web-daemon item | Replaced by |
| --- | --- |
| Assumption "When the child starts: lazily" | WA-10 |
| Assumption "Preferred port 3100" and WD-04 | WA-12, WA-13 |
| Out of Scope "Persisting the web token across web child restarts" | WA-01 to WA-04 |
| WD-21 notice text `CodeDeck web is already running on port <port>` | WA-17 |
| WD-30 page 403 text `open this page with codedeck ui` | WA-08 |
| `web.ensure` params `{port?, build?, entry?}` | adds `preferredPort` (WA-16) |
| WD-02 (same entry and build reuse the running child) | WA-19, WA-20: reuse also requires the port rule to hold |
| WD-42 (a request without `build` reuses the running child) | WA-19, WA-20: the port rule applies first |
| WD-03 (requests during a start share one result) | WA-13: each waiting request re-evaluates with its own params |
| WD-44 (ephemeral fallback only on `EADDRINUSE` when `--port` is absent) | WA-18, WA-21: any listen error |

Tests and docs that pin the old values change with this feature: tests/web-security.test.ts:140, 150; tests/web-launch.test.ts:98, 126; tests/web-server.test.ts:44-46; tests/review-command.test.ts:11-12; docs/protocol.md:46-63.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Starting the daemon at login (systemd user unit) | "Always" here means while the daemon runs. After a reboot the first `codedeck` command starts the daemon, and with it the console. |
| Respawning the web child after a crash without a request | A crash is logged; the next web command respawns it (existing behavior). |
| Removing the token | The token keeps other local users and non-browser processes off the setup API, which rewrites the harness config. |
| A command to rotate the token | Deleting `~/.run-agent/web-token` rotates it at the next web child start; documented in `docs/protocol.md`. |
| Moving a running console to an explicit `--port` | `--port` applies only when a new child starts (WA-15). Changing the console's port for good is what `web.port` is for. |
| Remote or LAN access | The server stays on 127.0.0.1. |
| New pages or page visuals | This feature changes access only. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Default port | 7777 replaces 3100 as `DEFAULT_WEB_PORT`. | The user asked for 7777; 3000-3999 collides with common dev servers. | y |
| Port config key | `web.port` in `config.json`, an integer 1-65535. The preferred port is `web.port` when valid, else 7777. | Matches the existing per-feature objects in the config (`autocompact`, `orchestrator`). | n |
| Who reads `web.port` | The CLI and the daemon, through one shared resolver in `src/config`. The web child reads no config: it gets its port from its arguments. | One resolution point; the child cannot disagree with the process that asked for it. | n |
| Explicit `--port` vs preferred port | `--port` is explicit: no fallback, a listen error exits 1. The preferred port falls back to an OS-assigned port on any listen error (`EADDRINUSE`, `EACCES`, ...). | An explicit port is a request, not a hint; a bad config value must not break every web command. | n |
| `--port` while a console runs | Reused as today, with the WA-17 notice. `--port` only picks the port of a child that has to start anyway, and that child lasts until the next request without `--port`, which moves the console back to the preferred port (WA-19). | Restarting on every `--port` would move open tabs; a request without `--port` restoring the preferred port keeps the bookmark from being hijacked by one `--port` run. | n |
| Config change while a console runs | The supervisor remembers what each child was started for: an explicit port, a preferred port, or nothing. A request without `port` but with a `preferredPort` restarts the child unless it was started for that same preferred port (WA-19). | Editing `web.port` then running any web command applies it without restarting the daemon, which would interrupt sessions. | n |
| Request with neither `port` nor `preferredPort` (a CLI from an older tree) | Reuses a running child whose entry and build match; otherwise starts a child with no port argument (WA-25). | Absent means "no opinion", not "different". | n |
| Child port arguments | `--port <n>`: explicit, no fallback (unchanged). `--preferred-port <n>`: that port, OS-assigned on any listen error. Neither: 7777 with the same fallback. | Keeps today's meaning of `--port`; a child started by an older daemon still gets a sensible port. | n |
| Invalid `web.port` | Treated as absent (7777). The CLI prints `Ignoring invalid web.port in config: <JSON value>` to stderr; the daemon appends the same line to `daemon.log` on its eager start. | Visible, but never fatal, like `loadConfig`'s tolerance (src/config/config.ts:439-441). | n |
| Token storage | `~/.run-agent/web-token` (`getPaths().base`), 64 lowercase hex characters plus an optional trailing newline, mode 0600. | Same directory as the daemon's other state; 0600 keeps other users out. | n |
| Token creation | Write a random token to a 0600 temp file in the same directory, then `link(tmp, web-token)`. On `EEXIST`, read the existing file; if it is malformed, `rename(tmp, web-token)` and read the file again. Remove the temp file in every case. | `link` publishes a complete file atomically, so a concurrent reader never sees a partial token and processes racing on a missing file agree (WA-03). Two processes replacing the same malformed file at once can serve different tokens until the next child start; accepted, since it needs a corrupted file plus a start race. | n |
| Loose token file permissions | If the existing file is readable or writable by group or others, `chmod 0600` before using it. | A hand-copied file must not stay world-readable. | n |
| Who uses the stored token | The web child and the CLI in-process fallback. Unit tests keep a per-server random token unless they inject one. | Both servers must accept the same cookie, or the fallback would overwrite it (same cookie name, same host, RFC 6265 §8.5). | n |
| Cookie lifetime | `Max-Age=31536000` (365 days), renewed on every page GET served with a valid cookie. | A bookmark keeps working for a year after the last visit. | n |
| Accepted risk of a persistent token | The token no longer dies with the child: the `?t=` URL a command prints and the cookie (sent by the browser to any 127.0.0.1 port, RFC 6265 §8.5) stay valid until the file is deleted. Accepted for a single-user loopback tool; rotation by deleting the file is documented. | The alternative (a new link per restart) is the pain this feature removes. | n |
| Canonical host | `127.0.0.1`. A page GET whose Host is `localhost:<port>` answers 302 to `127.0.0.1:<port>` with the path and query of `new URL(request.url, "http://127.0.0.1:<port>")`. | RFC 6265 §5.1.3: a cookie set for `127.0.0.1` is never sent to `localhost`; building from a parsed URL keeps an absolute-form request target out of `Location`. | n |
| Where the eager start runs | In the `--daemon` entry, after `start()` resolves, not awaited. `Daemon.start()` itself does not start the web child. | Keeps tests that call `start()` from spawning a real child, and IPC never waits on the web stack. | n |
| Stray gate daemons | `scripts/pty-gate.sh` and `scripts/rename-gate.sh` stop the daemon they started (from `$RUN_AGENT_DIR/daemon.pid`) in their EXIT trap. | With the eager start, an orphaned gate daemon would hold 7777 with another token and break the real bookmark. | n |
| 403 page text | `Run "codedeck ui" once in a terminal to open CodeDeck in this browser.` | The old text did not say the step is one-time. | n |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Bookmark survives restarts ⭐ MVP

**User Story**: As a developer, I want a console URL I can bookmark so that I open setup, usage, or review without going through the terminal each time.

**Why P1**: This is the reported pain.

**Acceptance Criteria**:

1. WHEN the web child starts and `~/.run-agent/web-token` holds a valid token THEN the child SHALL serve with that token and report it in its handshake.  <!-- WA-01 -->
2. IF `~/.run-agent/web-token` is missing or malformed THEN the web child SHALL publish a new 64-character lowercase hex token there with mode 0600 through the temp-file-and-link procedure and serve with the token the file holds afterwards.  <!-- WA-02 -->
3. WHEN two processes resolve the token at the same time with no file present THEN both SHALL serve with the same token, equal to the file's content.  <!-- WA-03 -->
4. IF the token file is readable or writable by group or others THEN the web child SHALL set its mode to 0600 before serving.  <!-- WA-04 -->
5. WHEN the CLI serves in-process because the daemon cannot host the console THEN it SHALL resolve the token with the same procedure as the web child.  <!-- WA-05 -->
6. WHEN a page GET carries a valid `?t=` THEN the server SHALL answer 303 with `Set-Cookie: codedeck_ui_token_<port>=<token>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`.  <!-- WA-06 -->
7. WHEN a page GET carries a valid cookie and no valid `t` THEN the server SHALL serve the page with the same `Set-Cookie` header as WA-06.  <!-- WA-07 -->
8. IF a page GET on `127.0.0.1:<port>` has no valid `t` and no valid cookie THEN the server SHALL answer 403 with the body `Run "codedeck ui" once in a terminal to open CodeDeck in this browser.`  <!-- WA-08 -->
9. WHEN a page GET arrives with Host `localhost:<port>` THEN the server SHALL answer 302 with `Location: http://127.0.0.1:<port><pathname><search>` taken from `new URL(request.url, "http://127.0.0.1:<port>")`, before any token or cookie check.  <!-- WA-09 -->
10. The server SHALL keep answering 403 `forbidden` to a request with any Host other than `127.0.0.1:<port>` or `localhost:<port>`, to a POST without a valid cookie and same-origin `Origin`, and to an `/api/*` request without a valid cookie.  <!-- WA-10 -->

**Independent Test**: run `codedeck ui` once, close the browser, kill the web child, run `codedeck setup --no-open`, then open `http://localhost:7777/setup` in a fresh browser window: the page loads without a token.

---

### P1: Console answers while the daemon runs ⭐ MVP

**User Story**: As a developer, I want the console to be up whenever the daemon is so that the bookmark works without first running a web command.

**Why P1**: A stable token does not help if nothing listens on the port.

**Acceptance Criteria**:

1. WHEN the `--daemon` entry's `start()` resolves THEN the daemon SHALL call `web.ensure` once with its own entry, no explicit port, and the resolved preferred port, without awaiting it.  <!-- WA-11 -->
2. IF the eager start fails THEN the daemon SHALL append `web autostart failed: <message>` to `daemon.log` and keep serving IPC.  <!-- WA-12 -->
3. WHEN a `web.ensure` arrives while another start is in flight THEN the supervisor SHALL wait for that start to settle and then apply its reuse and restart rules to the new request's own params, repeating the wait whenever it finds another start in flight, so that at most one start runs at a time.  <!-- WA-13 -->
4. The `Daemon.start()` method SHALL NOT start a web child.  <!-- WA-14 -->

**Independent Test**: stop the daemon, run `codedeck ps` (which starts the daemon), then `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/` prints 403 instead of refusing the connection.

---

### P2: Fixed, configurable port

**User Story**: As a developer, I want the console on a port I choose so that the bookmark does not collide with my dev servers.

**Why P2**: 7777 alone serves most users; the config key covers collisions.

**Acceptance Criteria**:

1. The preferred port SHALL be `web.port` from `config.json` when it is an integer in 1-65535, and 7777 otherwise.  <!-- WA-15 -->
2. WHEN a web command runs without `--port` THEN it SHALL send the preferred port as `preferredPort` in `web.ensure` and no `port`.  <!-- WA-16 -->
3. WHEN a web command gets a console URL whose port differs from its `--port`, or from the preferred port when `--port` is absent, THEN it SHALL print `CodeDeck web is running on port <actual> instead of <asked>` before the page line.  <!-- WA-17 -->
4. WHEN the supervisor starts a child for a `preferredPort` THEN it SHALL pass `--preferred-port <n>`, and the child SHALL listen on that port and, on any listen error, on an OS-assigned port.  <!-- WA-18 -->
5. WHEN a `web.ensure` without `port` and with a `preferredPort` finds a running child that was not started for that same preferred port (started for an explicit port, for another preferred port, or with no port argument) THEN the supervisor SHALL restart the child for the requested preferred port.  <!-- WA-19 -->
6. WHEN a `web.ensure` with `port` finds a running child whose entry and build match THEN the supervisor SHALL reuse it, whatever the child was started for.  <!-- WA-20 -->
7. WHEN the CLI serves in-process without `--port` THEN it SHALL listen on the preferred port and fall back to an OS-assigned port on any listen error.  <!-- WA-21 -->
8. IF `web.port` is present and not an integer in 1-65535 THEN the CLI SHALL print `Ignoring invalid web.port in config: <JSON value>` to stderr and the daemon SHALL append the same line to `daemon.log` on its eager start.  <!-- WA-22 -->
9. The `--port` help of `review`, `setup`, `usage`, and `ui` SHALL read `port for a new console (default: web.port from config, else 7777)`.  <!-- WA-23 -->
10. WHEN the web child starts with neither `--port` nor `--preferred-port` THEN it SHALL listen on 7777 and, on any listen error, on an OS-assigned port.  <!-- WA-24 -->
11. WHEN a `web.ensure` with neither `port` nor `preferredPort` finds a running child whose entry and build match THEN the supervisor SHALL reuse it.  <!-- WA-25 -->

**Independent Test**: with the daemon running on 7777, set `"web": { "port": 7788 }` and run `codedeck ui --no-open`: the printed URL uses 7788 and `curl` on 7777 is refused. Occupy 7799 with `nc -l 7799`, set `web.port` to 7799, run `codedeck ui --no-open`, and the notice names the fallback port.

---

## Edge Cases

- IF the token file holds anything other than 64 lowercase hex characters and an optional newline THEN the child SHALL replace it per WA-02.
- WHEN the web child restarts on the same port (build change, crash plus a new command) THEN a browser with the cookie SHALL load pages without a new `?t=` (follows from WA-01 and WA-07).
- WHEN the console already runs on the preferred port and a web command passes no `--port` THEN the command SHALL print no port notice.
- IF a `localhost` page GET carries `?t=` THEN the 302 SHALL keep `t` in the query so the `127.0.0.1` request sets the cookie (follows from WA-09).
- WHEN `codedeck ui --port 8000` started the running child and a later web command passes no `--port` THEN the supervisor SHALL restart the child on the preferred port (follows from WA-19).
- IF `web.port` is a privileged port the user cannot bind THEN the child SHALL fall back per WA-18 and the command SHALL print the WA-17 notice.

---

## Implicit-requirement sweep

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | WA-15, WA-22 (`web.port`); WA-02 (token format). |
| Failure / partial-failure states | WA-12 (eager start), WA-18, WA-21 (listen errors), WA-02 (malformed token). |
| Idempotency / retry / duplicate handling | WA-03 (concurrent token creation), WA-11 (one eager call), WA-13 (requests during a start). |
| Auth boundaries & rate limits | WA-10 keeps the existing checks; WA-04 file mode; rate limits N/A because the server listens on loopback only. |
| Concurrency / ordering | WA-03, WA-13. |
| Data lifecycle / expiry | WA-06, WA-07 (365-day sliding cookie); persistent-token risk accepted in Assumptions. |
| Observability | WA-12, WA-22 log lines; WA-17 CLI notice. |
| External-dependency failure | N/A because the only external behavior is browser cookie handling, fixed by RFC 6265. |
| State-transition integrity | WA-13, WA-19, WA-20, WA-25 define when the supervisor reuses or restarts a child; entry and build mismatches still restart as in web-daemon. |

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WA-01 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-02 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-03 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-04 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-05 | P1: Bookmark survives restarts | Tasks | Pending |
| WA-06 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-07 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-08 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-09 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-10 | P1: Bookmark survives restarts | Tasks | Verified |
| WA-11 | P1: Console answers while the daemon runs | Tasks | Verified |
| WA-12 | P1: Console answers while the daemon runs | Tasks | Verified |
| WA-13 | P1: Console answers while the daemon runs | Tasks | Verified |
| WA-14 | P1: Console answers while the daemon runs | Tasks | Verified |
| WA-15 | P2: Fixed, configurable port | Tasks | Verified |
| WA-16 | P2: Fixed, configurable port | Tasks | Pending |
| WA-17 | P2: Fixed, configurable port | Tasks | Pending |
| WA-18 | P2: Fixed, configurable port | Tasks | Verified |
| WA-19 | P2: Fixed, configurable port | Tasks | Verified |
| WA-20 | P2: Fixed, configurable port | Tasks | Verified |
| WA-21 | P2: Fixed, configurable port | Tasks | Pending |
| WA-22 | P2: Fixed, configurable port | Tasks | Pending |
| WA-23 | P2: Fixed, configurable port | Tasks | Pending |
| WA-24 | P2: Fixed, configurable port | Tasks | Verified |
| WA-25 | P2: Fixed, configurable port | Tasks | Verified |

**Coverage:** 25 total, 0 mapped to tasks, 25 unmapped ⚠️

---

## Success Criteria

- [ ] A `localhost:7777` bookmark opens setup after a browser restart and after a daemon restart, with no terminal step.
- [ ] `curl` on `http://127.0.0.1:7777/` answers 403 within 5 s of the daemon starting.
- [ ] Editing `web.port` and running one web command moves the console, with no daemon restart.
- [ ] No existing 403 case in `tests/web-server.test.ts` or `tests/web-security.test.ts` starts accepting a request it rejected before.
