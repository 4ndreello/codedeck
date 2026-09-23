# Web console specification

## Problem Statement

Setup and usage analytics currently require the terminal, while review already serves a local page from the CLI. A browser console will make setup and usage easier to inspect while preserving the existing TUI and machine-readable command paths.

## Goals

- [ ] Serve Review, Usage, and Setup from one local HTTP server started by a CLI command.
- [ ] Keep the server bound to loopback and require token, Host, and Origin checks for actions that change state.
- [ ] Reuse a pure setup planner from the terminal wizard and the web setup flow without adding catalog validation to the planner.
- [ ] Preserve existing setup batch, usage JSON, single-run, backfill, observation, and statusline contracts.
- [ ] Render usage totals and all supported breakdowns in the browser, with filters and periodic refresh.
- [ ] Keep every page self-contained and test page behavior in Node without a DOM dependency.

## Current state (verified)

- Review owns its Node HTTP server, port parser, browser opener, and request handler in src/cli/commands/review.ts:1-135. It defaults to port 3100, accepts --port and --no-open, binds to 127.0.0.1, serves the same review page at GET / and GET /review, and serves read-only GET /api/review. Existing tests are in tests/review.test.ts:193-230 and tests/review-command.test.ts:5-27.
- src/web/review-page.ts:8-662 exports one self-contained HTML string with inline CSS and JavaScript.
- Usage option parsing and CLI branches are in src/cli/commands/usage.ts:13-30 and :79-214. fetchUsageQuery at :37-77 uses daemon IPC usage.query and falls back to read-only SQLite. The positional run-id path calls usage.get at :103-125.
- At this worktree HEAD, src/daemon/protocol.ts:199-211 has totals and byDay, byRepository, byModel, byAgent, and byRun. The feat/orchestrator-usage change adds required byOrigin to UsageQueryResult, --backfill, --observe, and --by origin. The web implementation must be based on a HEAD that contains that change. An older daemon reached over IPC may still return a result without byOrigin at runtime, so the page handles that field defensively.
- The setup command and wizard are in src/cli/commands/setup.ts:625-801 and :1560-1626. A non-batch invocation without both stdin and stdout TTYs exits with code 1 and prints “setup needs a terminal on both stdin and stdout”; it starts no discovery and writes no config. The behavior is covered by tests/setup-cli-contract.test.ts:315-334 and tests/setup-wizard.test.ts:1220-1243.
- The setup wizard allows typed harness:model values through src/cli/picker-state.ts:113-141 and keeps configured models that are absent from the catalog in src/cli/commands/setup.ts:499-518. It also preserves a role's binding and effort when their screens are skipped; first-run skips produce an empty agents object sentinel. Tests are in tests/setup-wizard.test.ts:579-592, :757-764, and :1179-1183.
- The setup command resolves explicit and active profiles in src/cli/commands/setup.ts:831-853. An active profile that does not exist raises SetupUsageError. An explicit profile without a saved snapshot starts from profile defaults with agents: {}.
- SetupEnvelope in src/cli/commands/setup.ts:1000-1036 uses top-level fields proposta, validacoes, mudancas, and resultado. runSetupBatch reads config without replacing invalid JSON and returns code 14 for invalid config or 15 for a read error at :1369-1387. It validates only winning --bind entries at :1404 and :1444-1459. loadConfig in src/config/config.ts:531-540 swallows read and parse errors, so web setup must use readConfigForSetup.
- getBatchModels in src/core/models.ts:276-389 supports allowNetwork:false for cached reads and refresh:true for network discovery, with a default 12,000 ms timeout. If discovery is incomplete or a requested harness reports an error, it discards partial network results and returns the cache fallback with status and discoveryError.
- Custom orchestrator parallelism accepts positive finite numbers in src/cli/commands/setup.ts:319-345 and :361-394. README.md:149-186 currently describes setup as a terminal picker.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Removing or adding features to the setup TUI or usage TUI | Both remain frozen and reachable behind their flags. Their removal is a later feature. |
| Moving HTTP into the daemon | The server lives in the CLI process and only while its command runs. |
| Remote access or authentication beyond the per-start token | The server binds only to 127.0.0.1. |
| Profile management beyond the existing --profile target | The web setup edits only the target already selected by the CLI. |
| Changing setup batch, usage JSON, usage.get, backfill, observe, or statusline contracts | Existing command and agent callers keep their current interfaces and outputs. |
| New review page features | Review keeps its current page and GET API behavior. |
| Build tooling, a frontend framework, or frontend dependencies | Pages remain self-contained HTML strings with inline CSS and JavaScript. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Home page entry command | codedeck ui | This is the requested default and leaves codedeck review at its current root page. | Yes |
| Setup TUI entry | codedeck setup --tui | This is the requested default for keeping the frozen wizard reachable. | Yes |
| Usage web entry | codedeck usage --web | This is the requested opt-in entry and leaves plain usage output unchanged. | Yes |
| Non-TTY setup | Without batch flags, lack of either stdin or stdout TTY keeps the current code 1 and message; no server starts. | This is the orchestrator's confirmed decision and preserves current tests. | Yes |
| Shared web port | 3100 by default; web commands accept --port values from 1 through 65535. | Review already uses this default and range. Port 0 is available only through the injected server test seam. | No |
| No-browser behavior | --no-open or a failed browser opener prints the full initial URL, including ?t=<token>, and keeps serving until SIGINT or SIGTERM. | The printed link must bootstrap the same per-start browser session as openBrowser. | No |
| Host allowlist | Accept only 127.0.0.1:<bound-port> and localhost:<bound-port>, case-insensitively; reject absent or other Host values with HTTP 403. | These are the only accepted browser hostnames for the loopback server. | No |
| Token transport | Generate 32 cryptographically random bytes per server start; carry the token as the t query parameter in the opened and printed initial URL. | The page receives the token out of band and does not embed it in HTML or JavaScript. | No |
| Session cookie | Set a host-only HttpOnly; SameSite=Strict; Path=/ cookie named codedeck_ui_token_<port> only after a valid token GET. | Browser cookies do not isolate by port, so the name prevents one local CodeDeck port from replacing another port's token. | No |
| Token bootstrap redirect | A valid token GET to an HTML route sets the cookie and returns HTTP 303 to the same path without t. | The token is removed from the address bar after bootstrap. | No |
| Origin comparison | Require an HTTP Origin whose host and port match the accepted request Host and bound port on every POST; return HTTP 403 if absent or different. | This gives every action route one same-origin rule. | No |
| Home links | Render a link only when its page route is registered in the active route table. | P1 must not advertise Usage before P5 registers it. | No |
| Setup catalog source | GET calls getBatchModels with allowNetwork:false; protected refresh calls it with refresh:true, allowNetwork:true, and timeoutMs:12000. | This is the single catalog source and matches the batch helper's fallback behavior. | No |
| Concurrent catalog refresh | Requests during one discovery share one in-flight refresh promise. | Duplicate provider requests do not improve the displayed result. | No |
| Setup --refresh behavior | On an interactive setup web launch, open /setup and request protected catalog refresh on page load. | This preserves the current flag while keeping discovery behind the action route. | No |
| Setup request size | Accept JSON bodies up to 64 KiB; return HTTP 400 for larger or malformed bodies. | A full role selection is small and a fixed limit bounds request parsing. | No |
| Setup API status mapping | Malformed input returns 400; binding validation failures return 422; save failures return 500. The SetupEnvelope records the existing setup code and saved=false. | The page receives a stable HTTP result and the existing validation codes remain visible. | No |
| setup --json with --port | Reject the combination through the setup usage-error path before starting a server. | --json selects the existing batch contract while --port selects web startup. | No |
| Usage --by with --web | Use --by as the initially selected breakdown; keep all available breakdown sections on the page. | This preserves the CLI grouping preference without hiding the other web sections. | No |
| Usage interval | Use a floor of 1 second and a numeric-conversion fallback of 2 seconds for web polling. | Commander supplies the default string "2", so the implementation cannot distinguish an omitted option from explicit --interval 2. | No |
| Aggregate usage --web --json | Start the browser page and print the token URL; --json affects aggregate output only when --web is absent. | The browser is the selected aggregate interface, while the positional run-id JSON contract remains unchanged. | No |
| Catalog refresh method | Use protected POST /api/setup/catalog/refresh with refresh:true, allowNetwork:true, and timeoutMs:12000. | Discovery may update the model cache, so it uses the guarded action path and the helper's current timeout. | No |
| Page behavior tests | Put state, rendering decisions, and polling transitions in TypeScript functions exported from each page module, then inject their source into its HTML string. | Node tests can exercise the same functions without installing a DOM implementation. | No |
| Post-merge usage result | Use the merged required byOrigin type, with a runtime fallback when an older daemon omits the field. | The feature branch adds byOrigin to the type; IPC can still reach an older daemon process. | Yes |
| Usage query failure | Return HTTP 500 with a JSON error, show the error in the page, and retain the last successful result. | A later poll can recover without removing the visible result. | No |
| Usage run ID with --web | When --backfill is absent, preserve the usage.get single-run branch, including --observe and --json, and start no web server when a positional ID or --run is present; --by origin remains aggregate-only. | The branch is used by the statusline and is evaluated before aggregate web startup. | No |
| Usage --backfill with --web | Run the existing backfill branch and start no web server. | The post-merge CLI checks --backfill before single-run and aggregate handling. | No |
| --watch with --web | The browser polls; --watch does not select terminal rendering. The normalized --interval value controls browser polling. | The web page replaces terminal watch output for this invocation. | No |
| Active profile missing | Surface the existing SetupUsageError and do not silently switch to a global target. | This preserves resolveSetupTarget behavior. | No |

**Open questions:** none. Defaults without a human decision are recorded above with their rationale.

## User Stories

### P1: Shared local server and home page

**User Story**: As a CodeDeck user, I want one local browser entry point so that I can use registered Review, Usage, and Setup pages without changing their command-line data paths.

**Why P1**: The shared server and route table are the base for every browser page.

**Acceptance Criteria**:


1. WHEN a web entry command starts its server THEN the CLI SHALL bind only to 127.0.0.1. WEB-01
2. WHILE a web command is running THEN SIGINT or SIGTERM SHALL close its server and invoke the injected exit function. WEB-02
3. WHEN a web entry command starts without --port THEN the server SHALL listen on port 3100. WEB-03
4. IF a user-supplied --port is not an integer from 1 through 65535 THEN the command SHALL report the port error, exit with code 1, and skip server startup. WEB-04
5. WHEN codedeck review serves GET / THEN the server SHALL return REVIEW_PAGE with HTTP 200 and text/html content type. WEB-05
6. WHEN codedeck review serves GET /review THEN the server SHALL return the same review page as GET /. WEB-06
7. WHEN the browser sends GET /api/review THEN the handler SHALL pass ref (default HEAD) and optional file to the existing review loader and return its result. WEB-07
8. WHEN the home page is rendered THEN it SHALL link every registered page route and no unregistered page route. WEB-08
9. IF the requested port is already in use THEN the command SHALL print the listen error, exit with code 1, and not print a started-server URL. WEB-57
10. WHEN the test seam listens on port 0 THEN the server SHALL use server.address().port when constructing its URL and security instance. WEB-75
**Independent Test**: Start the server on an ephemeral test port, request each registered page and API route, and assert the address, status, content type, home links, and shutdown callbacks.

### P2: Local request security

**User Story**: As a local user, I want browser actions limited to the local server instance I started so that another site cannot submit setup changes.

**Why P2**: Setup apply and catalog refresh must reject forged requests before state changes occur.

**Acceptance Criteria**:


1. IF Host is absent or matches neither 127.0.0.1:<bound-port> nor localhost:<bound-port> THEN the server SHALL return HTTP 403 before route dispatch. WEB-10
2. WHEN the server starts THEN it SHALL generate one token from 32 cryptographically random bytes for that process. WEB-11
3. WHEN an action POST is dispatched THEN the server SHALL require the host-only cookie named codedeck_ui_token_<port> and return HTTP 403 when its value is missing, stale, or invalid. WEB-12
4. WHEN an action POST is dispatched THEN the server SHALL require an HTTP Origin matching the request Host and bound port and return HTTP 403 when Origin is absent or different. WEB-13
5. WHEN an HTML GET carries the valid t query token THEN the server SHALL set the port-specific cookie and redirect to the same path without t. WEB-71
6. IF an HTML GET lacks a valid t query token THEN the server SHALL NOT set the session cookie. WEB-72
7. IF a page receives HTTP 403 for a protected action THEN its page logic SHALL show “This CodeDeck session has expired. Reload the page. If it still fails, restart the command and open its new URL.” WEB-73
8. WHEN the server returns an HTML page THEN the response SHALL include Content-Security-Policy: frame-ancestors 'none'. WEB-74
9. IF --no-open is set or the browser opener fails THEN the command SHALL print the full initial URL, including ?t=<token>, and keep serving. WEB-09
**Independent Test**: Send accepted and rejected Host, token, and Origin combinations to protected and read routes. Confirm rejected action requests return 403 without invoking handlers, bootstrap redirects strip t, and all HTML responses include the framing policy.

### P3: Shared setup planning

**User Story**: As a user of either setup interface, I want the same selections to produce the same proposed config and diff so that the wizard and browser cannot drift in config assembly.

**Why P3**: The browser can only match setup behavior after config planning is separated from terminal I/O.

**Acceptance Criteria**:


1. WHEN the setup planner receives a current RunAgentConfig, resolved target, and complete selections THEN it SHALL return a proposed config and diff without reading or writing files, discovering models, or validating against a catalog. WEB-14
2. WHEN the selection contains a role binding THEN the planner SHALL set that role's harness, model, and optional effort to the selected values. WEB-15
3. WHEN a role is omitted from selections THEN the planner SHALL preserve that role's current binding. WEB-86
4. WHEN the planner updates selected config fields THEN it SHALL preserve unrelated config keys. WEB-87
5. WHEN the selection contains an orchestrator mode THEN the planner SHALL put its parameter values in the proposed config without persisting a preset label. WEB-16
6. WHEN the selection contains a sandbox value THEN the planner SHALL set defaultSandbox to workspace-write or danger-full-access as selected. WEB-17
7. WHEN the selection turns autocompact on THEN the planner SHALL set autocompact.enabled to true and preserve other autocompact fields. WEB-18
8. WHEN a setup response is assembled THEN it SHALL expose the exact top-level fields proposta, validacoes, mudancas, and resultado from SetupEnvelope. WEB-20
9. WHEN setup receives an explicit --profile target THEN the planner SHALL update only that profile snapshot. WEB-19
10. WHEN setup has no explicit --profile and an existing active profile THEN the planner SHALL use the resolved active profile snapshot. WEB-62
11. WHEN the terminal wizard completes selections THEN it SHALL use the shared planner without adding catalog validation to the wizard path. WEB-22
12. WHEN the selection turns autocompact off THEN the planner SHALL set enabled to false if the target config has an autocompact block and SHALL preserve the absent block otherwise. WEB-61
**Independent Test**: Call the planner with global and profile RunAgentConfig values. Assert exact proposal and diff paths for each field, skipped role behavior, and absence of file, network, and catalog-validation calls. Run the existing setup wizard and CLI contract tests unchanged.

### P4: Browser setup

**User Story**: As a user configuring CodeDeck, I want to review the current setup and a complete proposal in a browser before it is saved.

**Why P4**: This makes the browser the setup interface for interactive sessions while preserving the batch and TUI paths.

**Acceptance Criteria**:


1. WHEN the browser requests GET /setup THEN the server SHALL return the self-contained setup page with HTTP 200. WEB-23
2. WHEN the browser requests GET /api/setup/catalog THEN the handler SHALL call getBatchModels with allowNetwork:false and return models, status, source, ageMs, cacheWriteFailed, and discoveryError when present without starting discovery. WEB-24
3. WHEN the browser requests GET /api/setup/state THEN the handler SHALL return whether the target is global or a named profile and the current bindings, per-role effort, orchestrator, sandbox, and autocompact values for page prefill. WEB-63
4. IF the active profile does not exist THEN the state handler SHALL return the existing SetupUsageError message without selecting the global target. WEB-84
5. WHEN the user requests catalog refresh THEN the setup page logic SHALL show “Discovering models...” until the refresh response completes. WEB-25
6. WHILE catalog discovery is in progress THEN concurrent refresh requests SHALL share the same in-flight refresh promise. WEB-26
7. WHEN the browser posts selections to /api/setup/dry-run THEN the handler SHALL return a JSON object with exact top-level fields proposta, validacoes, mudancas, and resultado. WEB-27
8. WHEN the browser posts selections to /api/setup/dry-run THEN the handler SHALL leave the config file unchanged. WEB-28
9. IF the proposal has a non-empty diff and all changed bindings validate THEN apply SHALL save it and return resultado.status=applied with saved=true. WEB-29
10. IF the proposal diff is empty THEN apply SHALL return resultado.status=unchanged with saved=false and SHALL skip the config write. WEB-30
11. IF a setup POST body is malformed, larger than 64 KiB, or has an invalid shape THEN the handler SHALL return HTTP 400 without saving config. WEB-31
12. IF changed binding validation fails THEN the handler SHALL return HTTP 422, include the existing validation code in resultado.code, and set saved=false. WEB-32
13. IF saving the config fails THEN the handler SHALL return HTTP 500 with saved=false and the config error message. WEB-33
14. IF the config contains invalid JSON THEN web apply SHALL return resultado.code=14 and SHALL NOT write the config. WEB-76
15. IF reading the config file fails THEN web apply SHALL return resultado.code=15 and SHALL NOT write the config. WEB-77
16. WHEN codedeck setup runs with a TTY, no batch flags, and without --tui THEN it SHALL start web setup at /setup. WEB-34
17. WHEN codedeck setup runs with --tui and a TTY THEN it SHALL run the existing terminal wizard. WEB-35
18. WHEN codedeck setup runs with existing batch flags THEN it SHALL keep the runSetupBatch JSON, dry-run, bind, exit-code, validation, and save contracts unchanged, with winning --bind validation outside the pure planner. WEB-36
19. WHEN the setup page is rendered THEN it SHALL offer harness and model choices for every role in ROLES. WEB-37
20. WHEN the user enters harness:model text absent from the displayed catalog THEN the page SHALL allow that value in the selection and dry-run proposal. WEB-64
21. IF an existing binding's harness and model are unchanged from the resolved target THEN web apply SHALL preserve it without catalog validation, even when it is off-catalog. WEB-85
22. WHEN a binding's harness or model differs from the resolved target THEN web apply SHALL validate that binding and SHALL NOT validate bindings changed only by effort. WEB-21
23. WHEN a role is skipped THEN setup SHALL keep its target binding unchanged or leave it unset when no binding exists. WEB-65
24. WHEN all first-run role screens are skipped and no bindings exist THEN apply SHALL write the empty agents object sentinel. WEB-66
25. WHEN the user skips an effort screen for an unchanged harness and model THEN the page logic SHALL preserve that binding's current effort. WEB-67
26. WHEN the selected orchestrator mode is custom and the user enters positive finite parallelism N THEN the planner SHALL store N as the numeric parallelism value. WEB-68
27. WHEN a selected role supports a reasoning-effort screen THEN the setup page SHALL offer that role's effort values and SHALL omit the effort control for opencode. WEB-38
28. WHEN the setup page is rendered THEN it SHALL offer the orchestrator presets and investigate, selfWork, tools, and parallelism parameters. WEB-39
29. WHEN the setup page is rendered THEN it SHALL offer workspace-write and danger-full-access for sandbox. WEB-40
30. WHEN the setup page is rendered THEN it SHALL offer autocompact on and off. WEB-41
31. WHEN setup starts with --profile <name> THEN the state response SHALL identify that profile and apply its proposal only to that profile. WEB-42
32. IF model discovery is incomplete or any requested harness returns an error THEN the refresh response SHALL return getBatchModels cache fallback and discoveryError without partial network results. WEB-59
33. IF codedeck setup runs without batch flags and either stdin or stdout is not a TTY THEN it SHALL exit with code 1, print “setup needs a terminal on both stdin and stdout”, and start no server. WEB-69
34. IF codedeck setup receives both --json and --port THEN it SHALL report a setup usage error and start no server. WEB-70
35. WHEN setup guidance is updated THEN README.md lines 154 and 186 SHALL describe browser setup as the default, --tui as the picker entry, and --refresh as the catalog refresh option. WEB-82
**Independent Test**: Request setup state and catalog, refresh, submit dry-run and apply, and assert exact envelope fields and writes. Cover changed and unchanged off-catalog bindings, profile targets, all role and effort skips, typed models, custom numeric parallelism, invalid config codes, and non-TTY command behavior.

### P5: Browser usage analytics

**User Story**: As a user reviewing agent costs, I want a browser dashboard with the CLI filters and available breakdowns so that I can inspect usage without the terminal.

**Why P5**: The usage web must build on the merged orchestrator-usage contracts and retain compatibility with older daemons.

**Acceptance Criteria**:


1. WHEN the browser requests GET /usage THEN the server SHALL return the self-contained usage page with HTTP 200. WEB-43
2. WHEN the CLI or web handler calls buildUsageQueryParams(opts, cwd, now) THEN it SHALL apply the CLI precedence of all, today, days, then default today when since is absent; map 3, 7, and 30 to named periods and other positive day counts to local-midnight since; let current override repo; and pass through since, until, model, and agent so equal inputs produce equal UsageQueryParams. WEB-44
3. WHEN a usage query succeeds THEN the page logic SHALL expose every UsageTotals field for rendering. WEB-45
4. WHEN a usage query succeeds THEN the page logic SHALL expose byDay buckets for rendering. WEB-46
5. WHEN a usage query succeeds THEN the page logic SHALL expose byRepository buckets for rendering. WEB-47
6. WHEN a usage query succeeds THEN the page logic SHALL expose byModel buckets for rendering. WEB-48
7. WHEN a usage query succeeds THEN the page logic SHALL expose byAgent buckets for rendering. WEB-49
8. WHEN a usage query succeeds THEN the page logic SHALL expose byRun buckets for rendering. WEB-50
9. WHEN a post-merge result contains byOrigin THEN the page logic SHALL expose its buckets for rendering. WEB-51
10. IF a result returned by an older daemon has no byOrigin field THEN the page logic SHALL render the other breakdowns without an error. WEB-52
11. WHILE the usage page is open THEN its state logic SHALL poll the active query using the normalized interval value. WEB-53
12. WHEN codedeck usage runs with --web and no run ID THEN it SHALL open /usage with aggregate filters and the selected --by breakdown. WEB-54
13. WHEN codedeck usage runs without --web THEN it SHALL preserve the snapshot, TUI, watch, plain, JSON, --by origin, --observe, and --backfill contracts from the CLI and feat/orchestrator-usage. WEB-55
14. IF --backfill is absent and codedeck usage receives a positional run ID or --run THEN it SHALL call usage.get, preserve valid --observe data and --json output, ignore aggregate-only --by origin, and start no web server even if --web is present. WEB-56
15. IF codedeck usage receives --backfill together with --web THEN it SHALL run backfill and start no web server. WEB-83
16. WHEN usage web polling normalizes --interval with Math.max(1, Number(opts.interval) || 2) THEN zero and non-numeric values SHALL resolve to 2 seconds and negative or positive values below 1 SHALL resolve to 1 second. WEB-81
17. WHEN a usage page filter for period, repo, model, agent, since, or until changes THEN the page logic SHALL issue a new query with the updated filters. WEB-78
18. IF a usage query fails after a successful result THEN the page logic SHALL show the error and retain the last successful result. WEB-60
19. WHEN codedeck usage receives --by origin THEN the page logic SHALL select origin as the initial breakdown while leaving all available sections reachable. WEB-80
**Independent Test**: Use fixed options, cwd, and time to assert CLI and web query parameter parity. Test the page logic directly in Node for filters, polling, query errors, and results with and without byOrigin. Test CLI runs with --web, --by origin, --backfill, --observe, --json, and a single-run ID without starting an unintended server.

## Edge Cases

- IF Host is absent or matches neither accepted loopback Host value THEN no route handler SHALL run.
- IF an HTML GET lacks a valid token query parameter THEN the response SHALL NOT set the session cookie.
- IF a protected POST returns 403 THEN the page SHALL show the session-expired reload/restart message.
- IF a user port is invalid or already in use THEN the command SHALL exit without claiming the server started.
- IF a model refresh returns partial network results THEN the page SHALL show only the getBatchModels result and its status, not a partial merged network catalog.
- IF a changed binding fails catalog validation THEN apply SHALL save none of the proposal.
- IF config reading returns invalid JSON or an I/O error THEN web apply SHALL return code 14 or 15 respectively and SHALL NOT write.
- IF an older daemon omits byOrigin THEN the page SHALL render totals and every other breakdown.
- IF codedeck setup lacks either TTY stream without batch flags THEN it SHALL preserve the current exit and message and SHALL NOT start the web server.

## Requirement Traceability

Each acceptance criterion has one requirement ID and maps to the task that implements and tests it.

| Requirement ID | Story | Phase | Status | Task |
| --- | --- | --- | --- | --- |
| WEB-01 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-02 | P1: Shared local server and home page | P1 | In Tasks | T1, T7 |
| WEB-03 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-04 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-05 | P1: Shared local server and home page | P1 | In Tasks | T3 |
| WEB-06 | P1: Shared local server and home page | P1 | In Tasks | T3 |
| WEB-07 | P1: Shared local server and home page | P1 | In Tasks | T3 |
| WEB-08 | P1: Shared local server and home page | P1 | In Tasks | T2, T4, T5, T13, T18 |
| WEB-09 | P2: Local request security | P2 | In Tasks | T7, T12, T17 |
| WEB-10 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-11 | P2: Local request security | P2 | In Tasks | T6 |
| WEB-12 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-13 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-14 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-15 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-16 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-17 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-18 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-19 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-20 | P3: Shared setup planning | P3 | In Tasks | T11 |
| WEB-21 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-22 | P3: Shared setup planning | P3 | In Tasks | T9 |
| WEB-23 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-24 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-25 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-26 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-27 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-28 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-29 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-30 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-31 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-32 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-33 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-34 | P4: Browser setup | P4 | In Tasks | T12 |
| WEB-35 | P4: Browser setup | P4 | In Tasks | T12 |
| WEB-36 | P4: Browser setup | P4 | In Tasks | T9, T12 |
| WEB-37 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-38 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-39 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-40 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-41 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-42 | P4: Browser setup | P4 | In Tasks | T12, T13 |
| WEB-43 | P5: Browser usage analytics | P5 | In Tasks | T16, T18 |
| WEB-44 | P5: Browser usage analytics | P5 | In Tasks | T14, T15 |
| WEB-45 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-46 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-47 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-48 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-49 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-50 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-51 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-52 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-53 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-54 | P5: Browser usage analytics | P5 | In Tasks | T17 |
| WEB-55 | P5: Browser usage analytics | P5 | In Tasks | T17 |
| WEB-56 | P5: Browser usage analytics | P5 | In Tasks | T17 |
| WEB-57 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-59 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-60 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-61 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-62 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-63 | P4: Browser setup | P4 | In Tasks | T10, T11 |
| WEB-64 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-65 | P4: Browser setup | P4 | In Tasks | T10, T11 |
| WEB-66 | P4: Browser setup | P4 | In Tasks | T8, T10, T11 |
| WEB-67 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-68 | P4: Browser setup | P4 | In Tasks | T8, T10 |
| WEB-69 | P4: Browser setup | P4 | In Tasks | T12 |
| WEB-70 | P4: Browser setup | P4 | In Tasks | T12 |
| WEB-71 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-72 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-73 | P2: Local request security | P2 | In Tasks | T7, T10 |
| WEB-74 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-75 | P1: Shared local server and home page | P1 | In Tasks | T1, T7 |
| WEB-76 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-77 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-78 | P5: Browser usage analytics | P5 | In Tasks | T15, T16 |
| WEB-80 | P5: Browser usage analytics | P5 | In Tasks | T16, T17 |
| WEB-81 | P5: Browser usage analytics | P5 | In Tasks | T16, T17 |
| WEB-82 | P4: Browser setup | P4 | In Tasks | T19 |
| WEB-83 | P5: Browser usage analytics | P5 | In Tasks | T17 |
| WEB-84 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-85 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-86 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-87 | P3: Shared setup planning | P3 | In Tasks | T8 |

**Coverage**: 85 total requirements, 85 mapped to tasks, 0 unmapped.
## External Dependencies

None. The feature adds no external-system integration; catalog access reuses the repository's existing model-discovery code.

## Success Criteria

- [ ] codedeck ui lists only pages registered in its route table, and each linked route returns HTTP 200.
- [ ] Invalid Host, Origin, or token requests return HTTP 403 before an action handler runs.
- [ ] A valid token URL bootstraps a port-specific cookie and redirects to a URL without t.
- [ ] Setup state pre-fills the resolved profile or global target, and dry-run never writes config.
- [ ] Web apply validates only changed harness:model bindings and saves no invalid proposal.
- [ ] Existing setup wizard, setup CLI contract, review, usage CLI, JSON, and statusline tests pass unchanged.
- [ ] After the orchestrator-usage commit is an ancestor of implementation HEAD, usage query params match between CLI and web and page logic passes Node tests without a DOM dependency.
