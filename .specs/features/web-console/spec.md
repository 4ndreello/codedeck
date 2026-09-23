# Web console specification

## Problem Statement

Setup and usage analytics currently require the terminal, while review already runs a local page from the CLI. A browser console will make setup and usage easier to inspect while keeping the existing TUI and machine-readable command paths available with their current behavior.

## Goals

- [ ] Serve Review, Usage, and Setup from one local HTTP server started by a CLI command.
- [ ] Keep the server bound to loopback and require token, Host, and Origin checks for actions that change state.
- [ ] Reuse one setup planning function from the existing wizard and the web setup page.
- [ ] Preserve existing setup batch, usage JSON, single-run usage, and statusline contracts.
- [ ] Render usage totals and each supported breakdown in the browser, refreshing the selected query every 2 seconds.

## Current state (verified)

- Review currently owns its Node HTTP server, port parser, browser opener, and request handler in src/cli/commands/review.ts:1-135. The default port is 3100, the CLI accepts --port and --no-open, the server binds to 127.0.0.1, GET / and GET /review serve the same page, and GET /api/review loads a read-only review result. Existing route and command tests are in tests/review.test.ts:193-230 and tests/review-command.test.ts:5-27.
- src/web/review-page.ts:8-662 exports one self-contained HTML string. Its CSS starts at line 15 and its JavaScript at line 112.
- Usage query options and the CLI branches are in src/cli/commands/usage.ts:13-30 and :79-214. fetchUsageQuery at :37-77 calls daemon IPC method usage.query and falls back to a read-only SQLite database. The CLI supports date, repository, model, agent, grouping, TUI, watch, plain, and JSON options. A positional run ID uses the separate usage.get path at :103-125, which is used by the statusline contract tests.
- The current UsageQueryResult in src/daemon/protocol.ts:199-211 contains totals and byDay, byRepository, byModel, byAgent, and byRun arrays. It has no byOrigin field at this HEAD. The local feat/orchestrator-usage branch is not an ancestor of this HEAD, so P5 must follow that merge. The usage page must render byOrigin only when the merged result includes it.
- The setup wizard in src/cli/commands/setup.ts:625-801 discovers models, builds role/model and role-effort screens, then applies orchestrator, sandbox, autocompact, and profile selections before saving. The setup parser and batch options are at :804-990, SetupEnvelope is at :1000-1036, runSetupBatch is at :1363-1530, and the command entry is at :1560-1626. The current batch path applies role bindings; orchestrator, sandbox, and autocompact selections are wizard-only.
- Profile targeting in src/cli/commands/setup.ts:831-853 uses an explicit --profile target first, otherwise the active profile. An explicit target without a saved snapshot starts from the existing profile defaults; the wizard writes the selected snapshot at :774-779.
- Model discovery is announced before awaiting results in src/cli/commands/setup.ts:634-648. getCachedOrDiscoverModels in src/core/models.ts:151-190 can return the cache or discover and cache models.
- needsModelSetup is defined in src/cli/commands/setup.ts:437-452 and has no call site under src/. The wizard entry is executeSetupAction in src/cli/commands/setup.ts:1560-1598.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Removing or adding features to the setup TUI or usage TUI | Both remain frozen and reachable behind their flags. Removal is a later feature. |
| Moving HTTP into the daemon | The web server lives in the CLI process and only while its command runs. |
| Remote access or authentication beyond the per-start token | The server is local-only and binds to 127.0.0.1. |
| Profile management beyond the existing --profile target | The web setup edits only the target already selected by the CLI. |
| Changing setup batch, usage JSON, or statusline contracts | Batch and agent callers keep their current interfaces and outputs. |
| New review page features | Review keeps its current page and GET API behavior. |
| Build tooling, a frontend framework, or frontend dependencies | Pages remain self-contained HTML strings with inline CSS and JavaScript. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Home page entry command | codedeck ui | This is the requested default and leaves codedeck review at its current root page. | Yes |
| Setup TUI entry | codedeck setup --tui | This is the requested default for keeping the frozen wizard reachable. | Yes |
| Usage web entry | codedeck usage --web | This is the requested opt-in entry and leaves plain usage output unchanged. | Yes |
| Shared web port | 3100 by default; each web entry accepts --port | Review already uses 3100 and has a validated port option. | No |
| No-browser behavior | --no-open or a failed browser opener prints the full URL; the command keeps serving until SIGINT or SIGTERM | It matches the current review command and makes the URL usable in headless environments. | No |
| Host allowlist | Accept only 127.0.0.1:<bound-port> and localhost:<bound-port>, case-insensitively; reject missing or other Host values with HTTP 403 | These are the only browser hostnames supported by the loopback server. | No |
| Per-start token | Generate 32 cryptographically random bytes at server start and set them in a host-only HttpOnly; SameSite=Strict; Path=/ cookie | The browser sends the cookie for same-origin actions without exposing the token to page JavaScript. | No |
| Origin comparison | Require an HTTP Origin whose host and port match the accepted request Host on every POST route; return HTTP 403 when it is absent or different | This blocks cross-origin writes and gives every action route one testable rule. | No |
| Setup catalog refresh | GET /api/setup/catalog reads cached catalog state; POST /api/setup/catalog/refresh starts discovery | Discovery can write the model cache, so the explicit action uses the protected write path. | No |
| Setup --refresh behavior | Open /setup and request protected catalog refresh on page load | This preserves the existing flag while keeping discovery behind the action route. | No |
| Concurrent catalog refresh | Requests made while discovery is running share the same in-flight discovery | Model discovery can take seconds, and duplicate provider calls do not improve the displayed result. | No |
| Setup request size | Accept JSON bodies up to 64 KiB; return HTTP 400 for larger or malformed bodies | A full set of role selections is small; a fixed bound keeps local request parsing bounded. | No |
| Setup API status mapping | Malformed input returns 400, selection validation failures return 422 with a SetupEnvelope, and config save failures return 500 with saved=false | The page gets a predictable transport status while retaining the existing setup validation codes. | No |
| Usage refresh interval | Refresh the current query every 2 seconds; --interval overrides it when supplied with --web | Two seconds matches the current --watch default. | No |
| Usage query failure | Return HTTP 500 with a JSON error, show it in the page, and retain the last successful result | The user can still inspect the last known result while the next refresh retries. | No |
| Usage web with a run ID | A positional run ID or --run keeps the existing single-run branch, even if --web is also present | The statusline and single-run output path must keep their current contract. | No |
| --watch combined with --web | The browser page refreshes on its own; --interval controls its timer and --watch does not change the CLI output path | The web page replaces the need for terminal watch output. | No |
| --tui combined with setup batch flags | Reject the combination with the existing usage-error path | The batch path has a separate non-interactive contract and must not silently open either UI. | No |

**Open questions:** none. The implementation choices without a human default are recorded above with their rationale.

## User Stories

### P1: Shared local server and home page

**User Story**: As a CodeDeck user, I want one local browser entry point for review, setup, and usage so that I can use those screens without changing their command-line data paths.

**Why P1**: The shared server and route table are the base for every browser page.

**Acceptance Criteria**:
1. WHEN a web entry command starts its server THEN the CLI SHALL bind only to 127.0.0.1. WEB-01
2. WHILE codedeck ui, codedeck review, codedeck setup, or codedeck usage --web is running THEN the server SHALL stay alive until SIGINT or SIGTERM closes it. WEB-02
3. WHEN a web entry command starts without --port THEN the server SHALL listen on port 3100. WEB-03
4. IF --port is not an integer from 1 through 65535 THEN the command SHALL report the port error, exit with code 1, and skip server startup. WEB-04
5. WHEN codedeck review serves GET / THEN the server SHALL return REVIEW_PAGE with HTTP 200 and text/html content type. WEB-05
6. WHEN codedeck review serves GET /review THEN the server SHALL return the same review page as GET /. WEB-06
7. WHEN the browser sends GET /api/review THEN the handler SHALL pass ref (default HEAD) and optional file to the existing review loader and return its result. WEB-07
8. WHEN a user runs codedeck ui THEN GET / SHALL list links to /review, /usage, and /setup. WEB-08
9. IF --no-open is set or the browser opener fails THEN the command SHALL print the full URL and keep the server running. WEB-09
10. IF the requested port is already in use THEN the command SHALL print the listen error, exit with code 1, and not print a started-server URL. WEB-57

**Independent Test**: Start each command on an ephemeral test port, request its page and API routes, and assert the listen address, status, content type, and links. Stub browser opening to verify the printed URL and server lifetime.

### P2: Local request security

**User Story**: As a local user, I want browser actions limited to the local server instance I started so that another site cannot submit setup changes.

**Why P2**: Setup apply and catalog refresh must reject forged requests before state changes occur.

**Acceptance Criteria**:
1. IF a request Host is missing or differs from 127.0.0.1:<bound-port> and localhost:<bound-port> THEN the server SHALL return HTTP 403 before route dispatch. WEB-10
2. WHEN the server starts THEN it SHALL generate a token from 32 cryptographically random bytes. WEB-11
3. WHEN a POST route is requested THEN the server SHALL require the current token cookie and return HTTP 403 when it is missing, stale, or invalid. WEB-12
4. WHEN a POST route is requested THEN the server SHALL require an Origin matching the request's HTTP host and bound port, and return HTTP 403 when Origin is absent or different. WEB-13
5. IF a POST request carries a token cookie from a prior server process THEN the new server SHALL return HTTP 403. WEB-58

**Independent Test**: Send accepted and rejected Host, token, and Origin combinations to protected and read routes. Confirm rejected action requests return 403 and do not call their handlers.

### P3: Shared setup planning

**User Story**: As a user of either setup interface, I want the same selections to produce the same config proposal and validation result so that the wizard and browser cannot drift.

**Why P3**: The browser can only match setup behavior after config planning is separated from terminal I/O.

**Acceptance Criteria**:
1. WHEN the setup planner receives a current config, profile target, complete selections, and catalog validation data THEN it SHALL return a proposed config, diff, and validations without reading or writing files or starting discovery. WEB-14
2. WHEN the selection contains role bindings THEN the planner SHALL apply each harness, model, and optional effort while preserving roles the selection leaves unchanged and unrelated config keys. WEB-15
3. WHEN the selection contains an orchestrator mode THEN the planner SHALL put its parameter values in the proposed config without persisting a preset label. WEB-16
4. WHEN the selection contains a sandbox value THEN the planner SHALL set defaultSandbox to workspace-write or danger-full-access as selected. WEB-17
5. WHEN the selection turns autocompact on THEN the planner SHALL set autocompact.enabled to true and preserve other autocompact fields. WEB-18
6. WHEN a profile target is supplied THEN the planner SHALL update only that profile snapshot; when no explicit target is supplied it SHALL use the active profile resolution already used by setup. WEB-19
7. WHEN the planner returns a result THEN it SHALL expose the proposed config, diff, and validations in fields compatible with the current SetupEnvelope proposal. WEB-20
8. IF a selected model binding is not accepted by setup validation THEN setup apply SHALL return the existing validation code and SHALL NOT save the proposed config. WEB-21
9. WHEN the terminal wizard finishes a selection THEN it SHALL use the shared planner while all current setup-wizard and setup-cli-contract tests pass unchanged. WEB-22
10. WHEN the selection turns autocompact off THEN the planner SHALL set enabled to false if the current config has an autocompact block and SHALL preserve the absent block otherwise. WEB-61

**Independent Test**: Call the planner with a global config and a profile config, assert exact proposed values, diff paths, and validation results, and run the existing setup wizard and CLI contract test files without modifying their current cases.

### P4: Browser setup

**User Story**: As a user configuring CodeDeck, I want to review a complete setup proposal in a browser before applying it so that I can see the config changes before they are saved.

**Why P4**: This makes the browser the default setup interface while preserving the batch and TUI paths.

**Acceptance Criteria**:
1. WHEN the browser requests GET /setup THEN the server SHALL return the self-contained setup page with HTTP 200. WEB-23
2. WHEN the browser requests GET /api/setup/catalog THEN the handler SHALL return the cached model catalog and its fresh, offline, or unavailable status without starting discovery. WEB-24
3. WHEN the user requests catalog refresh THEN the page SHALL show “Discovering models...” until the protected refresh response completes. WEB-25
4. WHILE catalog discovery is in progress THEN concurrent refresh requests SHALL share the same discovery promise. WEB-26
5. WHEN the browser posts valid selections to /api/setup/dry-run THEN the handler SHALL return a SetupEnvelope-like proposal, diff, and validations. WEB-27
6. WHEN the browser posts selections to /api/setup/dry-run THEN the handler SHALL leave the config file unchanged. WEB-28
7. WHEN validated selections with a non-empty diff are posted to /api/setup/apply THEN the handler SHALL save the proposed config and return resultado.status=applied with saved=true. WEB-29
8. WHEN the proposal diff is empty THEN the apply handler SHALL return resultado.status=unchanged with saved=false and SHALL skip the config write. WEB-30
9. IF a setup POST body is malformed, larger than 64 KiB, or has an invalid shape THEN the handler SHALL return HTTP 400 without saving config. WEB-31
10. IF setup validation fails THEN the handler SHALL return HTTP 422 with the existing validation code and saved=false. WEB-32
11. IF saving the config fails THEN the handler SHALL return HTTP 500 with saved=false and the config error message. WEB-33
12. WHEN codedeck setup runs without batch flags or --tui THEN it SHALL start the web setup at /setup. WEB-34
13. WHEN codedeck setup runs with --tui and no batch flags THEN it SHALL run the existing terminal wizard. WEB-35
14. WHEN codedeck setup runs with existing batch flags THEN it SHALL keep the runSetupBatch JSON, dry-run, bind, exit-code, and save contracts unchanged. WEB-36
15. WHEN the setup page is rendered THEN it SHALL offer harness and model choices for every role in ROLES. WEB-37
16. WHEN a selected role supports a reasoning-effort screen THEN the setup page SHALL offer that role's effort choice and SHALL omit the effort control for opencode. WEB-38
17. WHEN the setup page is rendered THEN it SHALL offer the orchestrator presets and investigate, selfWork, tools, and parallelism parameters. WEB-39
18. WHEN the setup page is rendered THEN it SHALL offer workspace-write and danger-full-access for sandbox. WEB-40
19. WHEN the setup page is rendered THEN it SHALL offer autocompact on and off. WEB-41
20. WHEN setup starts with --profile <name> THEN the page SHALL identify that target and apply its proposal only to that profile. WEB-42
21. IF model discovery fails for one harness THEN the catalog response SHALL include that harness error with the other catalog results. WEB-59

**Independent Test**: Load the setup page, refresh the catalog, submit a dry-run, and assert its proposal and diff. Submit the same valid selection to apply and verify the selected global or profile config changes. Assert malformed, invalid, unchanged, and save-error paths do not claim a save.

### P5: Browser usage analytics

**User Story**: As a user reviewing agent costs, I want a browser dashboard with the same filters as the CLI and all available breakdowns so that I can inspect usage without a full-screen terminal.

**Why P5**: This depends on the pending usage-origin data change and keeps the existing usage TUI and command outputs intact.

**Acceptance Criteria**:
1. WHEN the browser requests GET /usage THEN the server SHALL return the self-contained usage page with HTTP 200. WEB-43
2. WHEN GET /api/usage receives filters THEN it SHALL map them to the CLI's UsageQueryParams, including all before today before days precedence, the 3d, 7d, and 30d period mappings, other positive days as local-midnight since, and current overriding repo. WEB-44
3. WHEN a usage query succeeds THEN the page SHALL display every field in UsageTotals. WEB-45
4. WHEN a usage query succeeds THEN the page SHALL display the byDay buckets. WEB-46
5. WHEN a usage query succeeds THEN the page SHALL display the byRepository buckets. WEB-47
6. WHEN a usage query succeeds THEN the page SHALL display the byModel buckets. WEB-48
7. WHEN a usage query succeeds THEN the page SHALL display the byAgent buckets. WEB-49
8. WHEN a usage query succeeds THEN the page SHALL display the byRun buckets. WEB-50
9. WHERE the merged UsageQueryResult contains byOrigin THEN the page SHALL display the byOrigin buckets. WEB-51
10. IF UsageQueryResult has no byOrigin field THEN the page SHALL render the other usage sections without an error. WEB-52
11. WHILE the usage page is open THEN it SHALL refresh the current filters every 2 seconds unless --interval supplied a different interval. WEB-53
12. WHEN codedeck usage runs with --web and without a run ID THEN it SHALL open /usage with the supplied aggregate filters. WEB-54
13. WHEN codedeck usage runs without --web THEN it SHALL keep the current snapshot, TUI, watch, plain, and JSON paths unchanged. WEB-55
14. WHEN codedeck usage receives a positional run ID or --run THEN it SHALL keep the existing usage.get single-run result and statusline contract, including when --web is also present. WEB-56
15. IF a usage query fails after the page has rendered a result THEN the page SHALL show the query error and retain the last successful result. WEB-60

**Independent Test**: Query a fixture result with each current grouping array and optional byOrigin. Assert filter mapping and page output with byOrigin present and absent, then verify the browser refresh uses the same filter values every 2 seconds.

## Edge Cases

- IF the requested port is invalid or already in use THEN the command SHALL print the listen error and exit without claiming the server started.
- IF Host, Origin, or the token cookie fails validation THEN the route handler SHALL not run.
- IF model discovery fails for one harness THEN the catalog response SHALL keep that harness error beside other returned catalog entries.
- IF config validation rejects one selected binding THEN apply SHALL save none of the proposal.
- IF the usage query fails after the initial render THEN the page SHALL show the error and retain the last successful usage result.
- IF the server process exits THEN its per-start token SHALL no longer authorize requests.

## Requirement Traceability

| Requirement ID | Story | Phase | Status | Task |
| --- | --- | --- | --- | --- |
| WEB-01 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-02 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-03 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-04 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-05 | P1: Shared local server and home page | P1 | In Tasks | T3 |
| WEB-06 | P1: Shared local server and home page | P1 | In Tasks | T3 |
| WEB-07 | P1: Shared local server and home page | P1 | In Tasks | T3 |
| WEB-08 | P1: Shared local server and home page | P1 | In Tasks | T2, T4, T5 |
| WEB-09 | P1: Shared local server and home page | P1 | In Tasks | T1, T4 |
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
| WEB-20 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-21 | P3: Shared setup planning | P3 | In Tasks | T8 |
| WEB-22 | P3: Shared setup planning | P3 | In Tasks | T9 |
| WEB-23 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-24 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-25 | P4: Browser setup | P4 | In Tasks | T10, T11 |
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
| WEB-36 | P4: Browser setup | P4 | In Tasks | T12 |
| WEB-37 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-38 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-39 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-40 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-41 | P4: Browser setup | P4 | In Tasks | T10 |
| WEB-42 | P4: Browser setup | P4 | In Tasks | T10, T12 |
| WEB-43 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-44 | P5: Browser usage analytics | P5 | In Tasks | T14 |
| WEB-45 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-46 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-47 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-48 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-49 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-50 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-51 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-52 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-53 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-54 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-55 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-56 | P5: Browser usage analytics | P5 | In Tasks | T16 |
| WEB-57 | P1: Shared local server and home page | P1 | In Tasks | T1 |
| WEB-58 | P2: Local request security | P2 | In Tasks | T6, T7 |
| WEB-59 | P4: Browser setup | P4 | In Tasks | T11 |
| WEB-60 | P5: Browser usage analytics | P5 | In Tasks | T15 |
| WEB-61 | P3: Shared setup planning | P3 | In Tasks | T8 |

**Coverage**: 61 total requirements, 61 mapped to tasks, 0 unmapped.

## Success Criteria

- [ ] codedeck ui lists Review, Usage, and Setup, and each linked page returns HTTP 200.
- [ ] Invalid Host, Origin, or token requests return HTTP 403 before an action handler runs.
- [ ] Setup dry-run returns a proposal and never writes config; apply writes only validated changes.
- [ ] Existing tests for setup wizard, setup CLI contract, review, usage JSON, and statusline behavior pass without changing their current cases.
- [ ] After feat/orchestrator-usage merges, the usage page renders all available breakdowns and refreshes the active query every 2 seconds by default.
