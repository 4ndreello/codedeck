# Web access tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: inline (no design.md; the spec's Assumptions table fixes every mechanism)
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec. Guidelines found: `CLAUDE.md` (scoped vitest runs, never the full suite), `vitest.config.ts`.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Token store (`src/web/web-token.ts`) | unit over a temp directory, fs seams for races | All branches; 1:1 to WA ACs | `tests/web-token.test.ts` | `npx vitest run tests/<file>` |
| Web server / security (`src/web/server.ts`, `src/web/security.ts`) | integration (real loopback listener on port 0) | Every WA AC in the task, happy + error paths | `tests/web-security.test.ts`, `tests/web-server.test.ts` | `npx vitest run tests/<file>` |
| Config resolver (`src/config/web-port.ts`) | unit | All branches | `tests/web-port.test.ts` | `npx vitest run tests/<file>` |
| Web child and supervisor | unit with injected streams / fake child | All branches; 1:1 to WA ACs | `tests/web-child.test.ts`, `tests/web-supervisor.test.ts` | `npx vitest run tests/<file>` |
| Daemon entry (`src/daemon/daemon.ts`) | unit through `tests/helpers/daemon-seam.ts` | 1:1 to WA ACs | `tests/daemon-web.test.ts` | `npx vitest run tests/<file>` |
| CLI launcher and commands | unit with injected client / fakes | 1:1 to WA ACs | `tests/web-launch.test.ts`, `tests/web-cli.test.ts`, `tests/review-command.test.ts` | `npx vitest run tests/<file>` |
| Gate scripts, docs | none | build gate only | - | - |

## Gate Check Commands

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Quick | Every task | `npx vitest run <each test file of the task>` (one run per file) + `npx tsc --noEmit` |
| Full | Last task of each phase | Quick gate over every test file touched in the phase, one file per run |
| Build | Last task | `npm run build`, `scripts/pty-gate.sh`, then a manual smoke run against `dist/` under a temp `RUN_AGENT_DIR` |

---

## Execution Plan

### Phase 1: Token and security

```
T1 → T2 → T3
```

### Phase 2: Ports and supervision

```
T4 → T5 → T6 → T7
```

### Phase 3: CLI and delivery

```
T8 → T9 → T10
```

---

## Task Breakdown

### T1: Add the persistent web token store

**What**: `resolveWebToken(options?)` in a new module: reads `<base>/web-token`, validates 64 lowercase hex plus optional newline, tightens loose modes to 0600, and publishes a new token through temp file + `link`, falling back to read on `EEXIST` and to `rename` when the existing file is malformed.
**Where**: `src/web/web-token.ts` (new)
**Depends on**: None
**Reuses**: `getPaths().base` from `src/config/paths.ts`
**Requirement**: WA-01, WA-02, WA-03, WA-04

**Done when**:

- [x] Valid file → returns its token unchanged (with and without trailing newline)
- [x] Missing file → creates a 64-hex token with mode 0600 and returns it; no temp file left behind
- [x] Malformed file (short, uppercase, extra text) → replaced; the returned token equals the file content
- [x] Race seam: a file appears between the temp write and `link` → `EEXIST` path returns the other token, which equals the file content
- [x] Mode 0644 file → mode becomes 0600, token kept
- [x] Gate check passes: `npx vitest run tests/web-token.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(web): Persist the web console token`

---

### T2: Keep the cookie for a year and send localhost to 127.0.0.1

**What**: In `checkWebRequest`: `Max-Age=31536000` on the bootstrap cookie, the same `Set-Cookie` on page GETs served with a valid cookie, a 302 from `localhost:<port>` page GETs to `127.0.0.1:<port>` built from a parsed URL, and the new 403 page text.
**Where**: `src/web/security.ts`
**Depends on**: T1
**Reuses**: existing `redirectWithSessionCookie` and `hasSessionCookie`
**Requirement**: WA-06, WA-07, WA-08, WA-09, WA-10

**Done when**:

- [x] Valid `?t=` → 303 with the exact WA-06 `Set-Cookie`
- [x] Valid cookie, no `t` and invalid `t` → page served with the same `Set-Cookie`
- [x] `localhost` Host page GET with and without `t` → 302 to the `127.0.0.1` URL keeping the query; an absolute-form request target does not leak its host into `Location`
- [x] No cookie, no `t` on `127.0.0.1` → 403 with the WA-08 body
- [x] Existing rejections (foreign Host, POST without cookie/Origin, `/api/*` without cookie) still answer 403 `forbidden`
- [x] Gate check passes: `npx vitest run tests/web-security.test.ts`; `npx vitest run tests/web-server.test.ts`; `npx tsc --noEmit`

**Tests**: integration
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(web): Keep the console cookie and canonicalize the host`

---

### T3: Accept an injected token and fall back on any listen error

**What**: `listenWebServer` / `startWebServer` take an optional `token`; `createWebSecurity(port, token?)` keeps a random default. With `fallbackToEphemeral`, any listen error retries on port 0. `DEFAULT_WEB_PORT` becomes 7777.
**Where**: `src/web/server.ts`, `src/web/security.ts`; the 3100 pins in `tests/review-command.test.ts` and `tests/web-launch.test.ts` move with the constant
**Depends on**: T2
**Reuses**: existing `listen` helper
**Requirement**: WA-01, WA-18, WA-21

**Done when**:

- [x] Injected token → served and required by the cookie check; omitted → random 64-hex token
- [x] `fallbackToEphemeral` + `EADDRINUSE` and + a non-`EADDRINUSE` listen error (injected server factory) → listens on an OS port
- [x] No fallback → the listen error propagates
- [x] `DEFAULT_WEB_PORT` is 7777
- [x] Gate check passes: `npx vitest run tests/web-server.test.ts`; `npx vitest run tests/web-security.test.ts`; `npx tsc --noEmit`

**Tests**: integration
**Gate**: full
**Status**: ✅ Done

**Commit**: `feat(web): Serve on 7777 with an injectable token`

---

### T4: Resolve the preferred web port from config

**What**: `resolveWebPort(config)` returns `{ port, invalid? }`: `web.port` when an integer in 1-65535, else 7777, with `invalid` holding the raw value when `web.port` is present but bad; plus the `Ignoring invalid web.port in config: <JSON value>` formatter. Adds `web?: { port?: number }` to `RunAgentConfig`.
**Where**: `src/config/web-port.ts` (new), `src/config/config.ts`; `src/web/server.ts` re-exports `DEFAULT_WEB_PORT` from it so daemon code can resolve the port without reaching `src/web`
**Depends on**: None (previous phase)
**Reuses**: `isJsonObject` style guards in `src/config/config.ts`
**Requirement**: WA-15, WA-22

**Done when**:

- [x] Absent `web` / absent `web.port` → 7777, no `invalid`
- [x] `web.port` 7788 → 7788; 1 and 65535 accepted
- [x] `"7788"`, 0, 65536, 7.5, `web: "x"` → 7777 with `invalid` set; message renders the JSON value
- [x] Gate check passes: `npx vitest run tests/web-port.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(config): Add the web.port setting`

---

### T5: Serve the child with the stored token and preferred port

**What**: The child parses `--port` (explicit) and `--preferred-port` (fallback); with neither it uses 7777 with fallback. It passes `resolveWebToken()` as the server token (injectable for tests).
**Where**: `src/web/child.ts`
**Depends on**: T4
**Reuses**: `runWebChild` options seams
**Requirement**: WA-01, WA-18, WA-24

**Done when**:

- [x] `--preferred-port 7788` → listen called with port 7788 and fallback on
- [x] `--port 7788` → port 7788, fallback off (unchanged)
- [x] Neither → port 7777, fallback on
- [x] The handshake token equals the injected token resolver's value, and the server was given that token
- [x] Gate check passes: `npx vitest run tests/web-child.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(web): Start the web child on the preferred port`

---

### T6: Apply the port rules in the supervisor

**What**: `preferredPort` in `WebEnsureParams`; the supervisor records what each child was started for (explicit, preferred n, none), passes `--preferred-port`, restarts per WA-19, reuses per WA-20 and WA-25, and serializes requests that arrive during a start (WA-13).
**Where**: `src/daemon/web-supervisor.ts`, `src/daemon/protocol.ts`
**Depends on**: T5
**Reuses**: existing `stop`, `start`, `matches`
**Requirement**: WA-13, WA-16, WA-18, WA-19, WA-20, WA-25

**Done when**:

- [x] `preferredPort` only → spawn args `--web-child --preferred-port <n>`
- [x] Running for preferred 7777, request preferred 7788 → SIGTERM + new child for 7788
- [x] Running for explicit 8000, request preferred 7777 → restart for 7777
- [x] Running with no port argument, request preferred 7777 → restart for 7777
- [x] Running for preferred 7777, request `port` 8000 with matching entry/build → reuse, no spawn
- [x] Request with neither → reuse a matching child
- [x] Entry or build mismatch still restarts (existing tests keep passing)
- [x] Two requests during a start that each need a different child → starts run one after the other, never two children alive at once, each request resolves with a child matching its own params
- [x] Gate check passes: `npx vitest run tests/web-supervisor.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(daemon): Restart the web child when the preferred port changes`

---

### T7: Start the web child with the daemon

**What**: `Daemon.autostartWeb()` resolves the preferred port from `loadConfig()`, logs the WA-22 line when invalid, calls the supervisor without awaiting, and logs `web autostart failed: <message>` on rejection. The `--daemon` entry calls it after `start()` resolves; `start()` does not.
**Where**: `src/daemon/daemon.ts`
**Depends on**: T6
**Reuses**: `appendDaemonLog`, `DaemonOptions.webSupervisor`
**Requirement**: WA-11, WA-12, WA-14, WA-22

**Done when**:

- [x] `autostartWeb()` calls `ensure` once with `{ preferredPort }` and no `port`/`entry`/`build`
- [x] Rejection → `daemon.log` gets `web autostart failed: <message>`; later `web.ensure` requests still work
- [x] Invalid `web.port` in the test config → the WA-22 line in `daemon.log`
- [x] `start()` alone never calls the supervisor (seam test)
- [x] The `--daemon` entry calls `autostartWeb()` after `start()` (static check of the entry block)
- [x] Gate check passes: `npx vitest run tests/daemon-web.test.ts`; `npx vitest run tests/web-supervisor.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: full
**Status**: ✅ Done

**Commit**: `feat(daemon): Start the web console with the daemon`

---

### T8: Send the preferred port from the CLI and share the token in the fallback

**What**: `launchWebPage` resolves the preferred port (injectable config loader), prints the WA-22 warning when invalid, sends `preferredPort` without `--port`, prints `CodeDeck web is running on port <actual> instead of <asked>` when the URL port differs, and serves the fallback on the preferred port with fallback on and the stored token.
**Where**: `src/cli/web-launch.ts`
**Depends on**: None (previous phase)
**Reuses**: `resolveWebPort`, `resolveWebToken`
**Requirement**: WA-05, WA-16, WA-17, WA-21, WA-22

**Done when**:

- [ ] No `--port` → params `{ preferredPort: <resolved>, build, entry }` without `port`; with `--port` → `port` sent, no `preferredPort`
- [ ] URL port ≠ asked port → notice line before the page line; equal → no notice (both with and without `--port`)
- [ ] Invalid `web.port` → the WA-22 line on stderr, once
- [ ] Fallback without `--port` → `startServer` gets the preferred port, `fallbackToEphemeral: true`, and the resolver's token; with `--port` → that port, no fallback
- [ ] Gate check passes: `npx vitest run tests/web-launch.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cli): Ask for the preferred web port`

---

### T9: Update the --port help of the web commands

**What**: The four commands read `port for a new console (default: web.port from config, else 7777)`; tests that pin 3100 move to 7777.
**Where**: `src/cli/commands/review.ts`, `src/cli/commands/setup.ts`, `src/cli/commands/usage.ts`, `src/cli/commands/ui.ts`
**Depends on**: T8
**Reuses**: none
**Requirement**: WA-23

**Done when**:

- [ ] Each command's help contains the WA-23 text
- [ ] Gate check passes: `npx vitest run tests/web-cli.test.ts`; `npx vitest run tests/review-command.test.ts`; `npx tsc --noEmit`

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cli): Describe the console port in --port help`

---

### T10: Stop gate daemons, document, and smoke-test the build

**What**: `scripts/pty-gate.sh` and `scripts/rename-gate.sh` kill the daemon from `$RUN_AGENT_DIR/daemon.pid` in their EXIT trap; `docs/protocol.md` documents `preferredPort`, the child arguments, the token file and its rotation. Run the build gate and a smoke run.
**Where**: `scripts/pty-gate.sh`, `scripts/rename-gate.sh`, `docs/protocol.md`
**Depends on**: T9
**Reuses**: none
**Requirement**: WA-11, WA-12

**Done when**:

- [ ] `npm run build` exits 0; `scripts/pty-gate.sh` prints its ok line and leaves no daemon with its `RUN_AGENT_DIR`
- [ ] Smoke under a temp `RUN_AGENT_DIR` and config: daemon start → 403 on the preferred port within 5 s; `ui --no-open` URL → cookie with `Max-Age`; restarting the daemon keeps the token; `localhost` page GET → 302; `web.port` change + one command moves the port
- [ ] Gate check passes: build gate

**Tests**: none
**Gate**: build

**Commit**: `docs(web): Document stable console access and stop gate daemons`

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3

Phase 1:  T1 → T2 → T3
Phase 2:  T4 → T5 → T6 → T7
Phase 3:  T8 → T9 → T10
```

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | start | ✅ |
| T2 | T1 | T1 → T2 | ✅ |
| T3 | T2 | T2 → T3 | ✅ |
| T4 | None (previous phase) | phase start | ✅ |
| T5 | T4 | T4 → T5 | ✅ |
| T6 | T5 | T5 → T6 | ✅ |
| T7 | T6 | T6 → T7 | ✅ |
| T8 | None (previous phase) | phase start | ✅ |
| T9 | T8 | T8 → T9 | ✅ |
| T10 | T9 | T9 → T10 | ✅ |

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Token store | unit | unit | ✅ |
| T2 | Web security | integration | integration | ✅ |
| T3 | Web server | integration | integration | ✅ |
| T4 | Config resolver | unit | unit | ✅ |
| T5 | Web child | unit | unit | ✅ |
| T6 | Supervisor | unit | unit | ✅ |
| T7 | Daemon entry | unit | unit | ✅ |
| T8 | CLI launcher | unit | unit | ✅ |
| T9 | CLI commands | unit | unit | ✅ |
| T10 | Gate scripts, docs | none | none | ✅ |
