# Web console tasks

## Execution protocol

Implement these tasks with the tlc-spec-driven skill. Keep tests in the task that changes the code they cover. Run only the scoped commands below. Do not change plugin files or add a frontend framework. Do not run the full Vitest suite.

**Design**: .specs/features/web-console/design.md

**Status**: Done. T1-T9, T14 merged in #111 (feat/web-console-foundation); T10-T13, T15-T19 on feat/web-console-pages

## Test Coverage Matrix

> Generated from the feature requirements, repository test locations, and the project instruction to use scoped Vitest commands. The Node test environment has no DOM dependency.

| Code layer | Required test type | Coverage expectation | Location pattern | Run command |
| --- | --- | --- | --- | --- |
| Web server/router | Integration | Loopback bind, actual port after listen, port parsing, route dispatch, review aliases, browser URL, listen failure, and injected shutdown | tests/web-server.test.ts, tests/review.test.ts, tests/review-command.test.ts | npx vitest run tests/web-server.test.ts tests/review.test.ts tests/review-command.test.ts |
| Security | Integration | Allowed and rejected Host, token bootstrap and cookie, Origin, POST rejection before dispatch, and HTML framing header | tests/web-security.test.ts, tests/web-server.test.ts | npx vitest run tests/web-security.test.ts tests/web-server.test.ts |
| Setup core | Unit and integration | Planner fields and preservation, optional orchestrator, profile targets, skip behavior, no catalog validation in planner, config-owned shared helpers, separate changed-binding validation, wizard and batch compatibility | tests/setup-plan.test.ts, tests/setup-wizard.test.ts, tests/setup-cli-contract.test.ts | npx vitest run tests/setup-plan.test.ts tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts |
| Setup web handlers | Integration | State prefill and error codes, catalog cache and refresh fallback, dry-run no-write, apply, changed-only validation with per-role off-catalog confirmation, missing profile, malformed body, and save errors | tests/setup-web.test.ts | npx vitest run tests/setup-web.test.ts |
| Usage query builder | Unit and command contract | Existing CLI filter precedence and mappings, with fixed options, cwd, and clock | tests/usage-cli.test.ts | npx vitest run tests/usage-cli.test.ts |
| Usage web handler | Integration | Query mapping, every supported filter, CLI versus /api/usage parameter equality, query success, and query error response | tests/usage-web.test.ts | npx vitest run tests/usage-web.test.ts |
| HTML pages and page behavior | Unit | Direct Node tests of injected page functions plus node:vm execution of extracted SETUP_PAGE and USAGE_PAGE scripts with stubbed browser globals; setup state, free-text input, discovery errors, 403 message, filters, polling, rendering data, optional byOrigin, and retained result on error | tests/web-pages.test.ts, tests/setup-page.test.ts, tests/usage-page.test.ts | npx vitest run tests/web-pages.test.ts tests/setup-page.test.ts tests/usage-page.test.ts |
| CLI wiring | Command contract | ui, review, setup, and usage routes and flags; setup batch and non-TTY behavior; usage.get with --web --json without server startup | tests/web-cli.test.ts, tests/review-command.test.ts, tests/setup-cli-contract.test.ts, tests/usage-cli.test.ts, tests/usage-statusline-contract.test.ts | npx vitest run tests/web-cli.test.ts tests/review-command.test.ts tests/setup-cli-contract.test.ts tests/usage-cli.test.ts tests/usage-statusline-contract.test.ts |
| Documentation | none | Text-only README update; no test coverage required | None | git diff --check -- README.md |

## Gate Check Commands

| Gate level | When to use | Command |
| --- | --- | --- |
| Task | After each task | Run the scoped command in that task's Gate field. |
| P1 | After shared server and home wiring | npx vitest run tests/web-server.test.ts tests/web-pages.test.ts tests/review.test.ts tests/review-command.test.ts tests/web-cli.test.ts |
| P2 | After security integration | npx vitest run tests/web-security.test.ts tests/web-server.test.ts tests/web-pages.test.ts |
| P3 | After setup core extraction | npx vitest run tests/setup-plan.test.ts tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts |
| P4 | After setup web wiring | npx vitest run tests/setup-web.test.ts tests/setup-page.test.ts tests/web-cli.test.ts tests/setup-cli-contract.test.ts |
| P5 | After P4 | npx vitest run tests/usage-cli.test.ts tests/usage-web.test.ts tests/usage-page.test.ts tests/web-cli.test.ts tests/usage-statusline-contract.test.ts |

## Execution Plan

Phases run in dependency order. Within each phase, start a task after its listed dependencies pass. P5 starts after P4. Usage origin support is already in main at 80ec486 (#103).

### Phase 1: Shared server and home page

```text
T1 -> T2
T1 -> T3
T2 -> T4
T3 -> T4
T4 -> T5
```

### Phase 2: Request security

```text
T1 -> T6
T1 -> T7
T6 -> T7
```

### Phase 3: Shared setup planning

```text
T7 -> T8
T8 -> T9
```

### Phase 4: Browser setup

```text
T8 -> T10
T7 -> T11
T8 -> T11
T9 -> T12
T10 -> T12
T11 -> T12
T12 -> T13
T12 -> T19
```

### Phase 5: Browser usage

```text
T14 -> T15
T7 -> T15
T15 -> T16
T14 -> T17
T15 -> T17
T16 -> T17
T13 -> T18
T15 -> T18
T16 -> T18
```

## Task Breakdown

### T1: Extract the shared server and router

**What**: Move loopback server startup, route dispatch, port parsing, browser opening, and testable shutdown into the shared web server.
**Where**: src/web/server.ts
**Depends on**: None
**Reuses**: src/cli/commands/review.ts
**Requirement**: WEB-01, WEB-02, WEB-03, WEB-04, WEB-57, WEB-75

**Done when**:

- The server binds to 127.0.0.1 and defaults to port 3100.
- The user-facing parser accepts only integer ports from 1 through 65535; an injected test seam can listen on port 0.
- After listen, the server reads server.address().port and uses that actual value for its returned address.
- Signal handling calls the injected close function and then the injected exit function for SIGINT and SIGTERM.
- A listen failure reports the error and exits with code 1 without printing a started URL.
- Server tests cover route dispatch, unknown routes, ephemeral bound port, listen failure, and both shutdown callbacks.

**Tests**: Integration, tests/web-server.test.ts
**Gate**: npx vitest run tests/web-server.test.ts

### T2: Render the home page from registered routes

**What**: Add a self-contained home page renderer that receives the registered page routes and creates links only for those routes.
**Where**: src/web/home-page.ts
**Depends on**: T1
**Reuses**: src/web/review-page.ts
**Requirement**: WEB-08

**Done when**:

- The home renderer accepts route labels and paths instead of hard-coding future routes.
- Tests pass only /review as registered and assert there is no /usage or /setup link.
- The page uses inline CSS and has no external asset dependency.

**Tests**: Unit, tests/web-pages.test.ts
**Gate**: npx vitest run tests/web-pages.test.ts

### T3: Rewire the review command

**What**: Start review with the shared server and preserve its page and API behavior.
**Where**: src/cli/commands/review.ts
**Depends on**: T1
**Reuses**: src/web/review-page.ts and src/git/review.ts
**Requirement**: WEB-05, WEB-06, WEB-07

**Done when**:

- GET / and GET /review return the current review page with HTTP 200.
- GET /api/review keeps ref=HEAD as its default and passes file when supplied.
- Existing review options and test seams remain available.
- Existing review assertions pass unchanged.

**Tests**: Integration, tests/review.test.ts and tests/review-command.test.ts
**Gate**: npx vitest run tests/review.test.ts tests/review-command.test.ts

### T4: Add the ui command

**What**: Start the shared server with the home page at / and the registered review page.
**Where**: src/cli/commands/ui.ts
**Depends on**: T2, T3
**Reuses**: Shared server, home renderer, and review handler
**Requirement**: WEB-08

**Done when**:

- codedeck ui opens / by default.
- Its initial page route table registers the home page and /review.
- --port and --no-open use the shared server options.
- Command tests assert registered links, route status, and URL output.

**Tests**: Command contract, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts

### T5: Register ui with the CLI

**What**: Register codedeck ui with the root Commander program.
**Where**: src/cli/index.ts
**Depends on**: T4
**Reuses**: Existing command registration
**Requirement**: WEB-08

**Done when**:

- codedeck --help lists ui.
- A command test invokes the registered command and verifies the home route.

**Tests**: Command contract, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts

### T6: Add request security

**What**: Create the per-start token and route guard for Host, cookie, Origin, and HTML response policy.
**Where**: src/web/security.ts
**Depends on**: T1
**Reuses**: Node request headers and the actual bound port from the server
**Requirement**: WEB-10, WEB-11, WEB-12, WEB-13, WEB-71, WEB-72, WEB-74

**Done when**:

- Each security instance creates a token from 32 cryptographically random bytes.
- Host validation accepts only 127.0.0.1:<bound-port> and localhost:<bound-port>, case-insensitively.
- Every POST requires the codedeck_ui_token_<port> cookie and an HTTP Origin matching Host and the bound port.
- A valid t token on an HTML GET sets a host-only HttpOnly, SameSite=Strict, Path=/ cookie and returns HTTP 303 to the same path without t.
- An HTML GET without a valid token does not set the session cookie.
- HTML responses include Content-Security-Policy: frame-ancestors 'none'.
- Unit tests cover valid and invalid token bootstrap, Host, Origin, cookie name, redirect, and CSP behavior.

**Tests**: Integration, tests/web-security.test.ts
**Gate**: npx vitest run tests/web-security.test.ts

### T7: Apply security before route dispatch

**What**: Integrate the guard into the shared server before any handler can run.
**Where**: src/web/server.ts
**Depends on**: T1, T6
**Reuses**: Route policies from src/web/security.ts
**Requirement**: WEB-10, WEB-12, WEB-13, WEB-71, WEB-74, WEB-75

**Done when**:

- The server obtains the actual port after listen and creates security with that port before opening or printing the URL.
- Every route gets a Host check before route dispatch.
- Invalid POST cookie or Origin requests return 403 without invoking the route handler.
- The opened and printed initial page URL includes ?t=<token>; a browser-open failure prints the same full URL and keeps serving.
- Server tests prove rejected requests do not reach handlers and token URLs are passed to the browser opener and output.

**Tests**: Integration, tests/web-security.test.ts and tests/web-server.test.ts
**Gate**: npx vitest run tests/web-security.test.ts tests/web-server.test.ts

### T8: Extract shared setup logic into the config layer

**What**: Move shared setup planning, target resolution, diffing, envelope types, and binding validation from the CLI command into the config layer.
**Where**: src/config/setup.ts
**Depends on**: T7
**Reuses**: RunAgentConfig, profile helpers, role bindings, and existing catalog validation rules
**Requirement**: WEB-14, WEB-15, WEB-16, WEB-17, WEB-18, WEB-19, WEB-30, WEB-61, WEB-62, WEB-86, WEB-87

**Done when**:

- buildSetupPlan accepts RunAgentConfig, a resolved target, and selections; it returns proposedConfig and diff only.
- resolveSetupTarget, diffConfig, SetupEnvelope, catalogContains, and validateBindings are exported from src/config/setup.ts for CLI and web callers.
- No src/config module imports from src/cli.
- The planner does not read or write files, discover models, or call catalog validation.
- Separate binding validation can be invoked by web apply and batch without being called by the planner; the wizard path still adds no catalog validation.
- Planner tests omit orchestrator and assert preservation of both an existing value and its absence.
- Planner tests cover selected values, skipped roles, unrelated config keys, profiles, and diff paths for each setup field.
- Tests cover off-catalog selections in the planner, profile resolution, diffing, and separate binding validation.

**Tests**: Unit, tests/setup-plan.test.ts
**Gate**: npx vitest run tests/setup-plan.test.ts

### T9: Reuse planning and separate validation in setup paths

**What**: Route wizard config assembly through the pure planner and keep batch validation outside it.
**Where**: src/cli/commands/setup.ts
**Depends on**: T8
**Reuses**: Existing wizard selection, runSetupBatch, and config save flow
**Requirement**: WEB-22, WEB-36

**Done when**:

- The wizard passes its selections through buildSetupPlan before saving.
- The wizard keeps typed-model, role skip, effort skip, abort, discovery, save-failure, and profile behavior.
- runSetupBatch validates only the winning --bind value for each role outside the planner.
- Existing setup wizard and CLI contract cases pass unchanged.

**Tests**: Integration, tests/setup-wizard.test.ts and tests/setup-cli-contract.test.ts
**Gate**: npx vitest run tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts

### T10: Add the setup page and tested behavior logic

**What**: Add a self-contained setup HTML page whose exported TypeScript behavior functions also drive selection, refresh state, and 403 recovery in the browser.
**Where**: src/web/setup-page.ts
**Depends on**: T8
**Reuses**: Wizard selection semantics and the route contracts in spec.md
**Requirement**: WEB-23, WEB-25, WEB-37, WEB-38, WEB-39, WEB-40, WEB-41, WEB-64, WEB-65, WEB-66, WEB-67, WEB-68, WEB-73, WEB-88, WEB-89, WEB-90

**Done when**:

- The page has a free-text harness:model field for every role, with supported effort choices and no effort control for opencode.
- It has role skip controls, orchestrator presets and custom parameters, both sandbox values, and autocompact on/off.
- It asks for explicit per-role confirmation before sending an off-catalog model in offCatalogConfirmed.
- Its state logic preserves skipped roles and effort; a first-run all-role skip can produce agents: {}.
- Positive finite custom parallelism is kept as a number in the proposal.
- A pending refresh exposes “Discovering models...” until the response completes.
- An unavailable refresh keeps the previously loaded catalog and shows discoveryError.
- An untouched selection can omit orchestrator and preserves the current value or its absence.
- A protected POST response of 403 exposes the exact reload/restart message from WEB-73.
- The HTML injects its exported behavior function source; Node tests call those same functions with fake fetch and state callbacks without a DOM.
- Tests extract the inline script from SETUP_PAGE, evaluate it in node:vm with an empty context and stubbed fetch, timers, and document, then call the setup page functions from that context.

**Tests**: Unit, tests/setup-page.test.ts
**Gate**: npx vitest run tests/setup-page.test.ts

### T11: Add setup state, catalog, and mutation routes

**What**: Add the setup route factory for state and catalog reads plus refresh, dry-run, and apply actions.
**Where**: src/web/setup-routes.ts
**Depends on**: T7, T8
**Reuses**: readConfigForSetup, resolveSetupTarget, getBatchModels, buildSetupPlan, and separate binding validation
**Requirement**: WEB-20, WEB-21, WEB-24, WEB-26, WEB-27, WEB-28, WEB-29, WEB-30, WEB-31, WEB-32, WEB-33, WEB-59, WEB-63, WEB-76, WEB-77, WEB-84, WEB-85, WEB-88, WEB-89, WEB-90, WEB-91, WEB-92, WEB-93

**Done when**:

- GET /api/setup/state returns the global or named profile target and current bindings, effort, optional orchestrator, sandbox, and autocompact values for prefill; invalid JSON returns code 14 and a read error returns code 15.
- An active profile without a snapshot returns the existing SetupUsageError instead of selecting global config.
- Apply returns code 14 and saved=false without a write when the active profile has no saved snapshot.
- GET /api/setup/catalog calls only getBatchModels with allowNetwork:false and returns its actual result fields.
- Protected refresh calls getBatchModels with refresh:true, allowNetwork:true, and timeoutMs:12000; incomplete discovery returns the helper's refresh fallback and discoveryError without partial network results.
- Concurrent refresh callers share the in-flight promise.
- Dry-run returns an exact SetupEnvelope with proposta, validacoes, mudancas, and resultado and does not write config.
- Apply uses readConfigForSetup, validates only changed harness:model pairs with getBatchModels allowNetwork:false, does not validate effort-only changes, and does not block unrelated changes for an unchanged off-catalog binding.
- An off-catalog changed model returns HTTP 422 unless its role has offCatalogConfirmed=true in the request; a confirmed off-catalog model saves.
- Dry-run returns resultado.code=14 for invalid JSON and resultado.code=15 for a config read error; neither path writes config.
- GET /api/setup/state returns JSON code 14 for invalid JSON and code 15 for a config read error.
- Empty diffs return unchanged and do not write; valid non-empty diffs save; malformed bodies return 400; validation failures return 422; save failures return 500.
- Tests cover state, cache and refresh results, concurrency, exact envelope keys, changed and unchanged off-catalog bindings with and without confirmation, invalid/read errors, missing active profiles, and every no-write path.

**Tests**: Integration, tests/setup-web.test.ts
**Gate**: npx vitest run tests/setup-web.test.ts

### T12: Make interactive setup open the web console

**What**: Add setup web startup flags and preserve the confirmed TTY, TUI, and batch branches.
**Where**: src/cli/commands/setup.ts
**Depends on**: T9, T10, T11
**Reuses**: Existing argument parser and runSetupBatch
**Requirement**: WEB-09, WEB-34, WEB-35, WEB-36, WEB-42, WEB-69, WEB-70, WEB-94

**Done when**:

- With both TTYs, no batch flags, and no --tui, codedeck setup starts the server at /setup.
- With --tui and both TTYs, setup runs the existing terminal wizard.
- Without both TTYs and without batch flags, setup exits 1 with the existing terminal message and starts no server.
- Batch flags continue to call runSetupBatch without changing JSON, dry-run, bind, validation, save, or exit-code contracts.
- --profile targets the selected profile and --refresh starts the protected catalog refresh after /setup loads.
- --json with --port returns a usage error before server startup.
- --dry-run with --port and --non-interactive with --port return usage errors before server startup.
- --port, --no-open, open failure, and printed token URL are covered by web command tests.
- Tests assert --json, --dry-run, and --non-interactive each reject --port without starting a server.
- Existing setup CLI contract tests pass without changes.

**Tests**: Command contract, tests/web-cli.test.ts and tests/setup-cli-contract.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts tests/setup-cli-contract.test.ts

### T13: Register setup routes with ui

**What**: Add the setup page and API routes to the route table used by codedeck ui.
**Where**: src/cli/commands/ui.ts
**Depends on**: T12
**Reuses**: The registered review routes and setup route factory
**Requirement**: WEB-08, WEB-23, WEB-42, WEB-63

**Done when**:

- codedeck ui serves /setup, /api/setup/state, /api/setup/catalog, and the setup action routes.
- The home page includes /setup only after that page route is registered.
- Command tests assert setup status and route registration.

**Tests**: Integration, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts

### T19: Update setup instructions in README

**What**: Replace the picker-first setup description with browser setup as the interactive default and retain the --tui and --refresh options.
**Where**: README.md
**Depends on**: T12
**Reuses**: Existing setup section at lines 149-186
**Requirement**: WEB-82

**Done when**:

- The example at line 154 describes codedeck setup opening the web console.
- The text at line 186 describes --refresh and points to --tui for the frozen terminal picker.
- No unrelated README sections change.

**Tests**: none
**Gate**: git diff --check -- README.md

### T14: Extract shared usage query parameter construction

**What**: Extract buildUsageQueryParams(opts, cwd, now) from the aggregate CLI branch into the shared helper and use it from src/cli/commands/usage.ts.
**Where**: src/core/usage-query.ts
**Depends on**: None
**Reuses**: Existing aggregate filter precedence in src/cli/commands/usage.ts:175-211
**Requirement**: WEB-44

**Done when**:

- The pure function preserves all, today, days, default-today, current-over-repo, since, until, model, and agent behavior.
- src/cli/commands/usage.ts calls the shared function with parsed options, process.cwd(), and the current date.
- tests/usage-cli.test.ts covers the helper and existing CLI query contract.

**Tests**: Unit and command contract, tests/usage-cli.test.ts
**Gate**: npx vitest run tests/usage-cli.test.ts

### T15: Add the usage query route

**What**: Map GET /api/usage filters through buildUsageQueryParams and call the injected usage query function.
**Where**: src/web/usage-routes.ts
**Depends on**: T7, T14
**Reuses**: buildUsageQueryParams and fetchUsageQuery
**Requirement**: WEB-44

**Done when**:

- Query parsing maps period, repo, model, agent, since, until, all, today, days, and current to the shared builder input.
- --current resolves to the CLI process working directory and overrides repo.
- For identical parsed CLI options, cwd, and clock, tests compare the CLI UsageQueryParams with the parameters passed by GET /api/usage.
- Successful results retain the UsageQueryResult shape.
- Query errors return an HTTP 500 JSON error.
- tests/usage-web.test.ts covers each filter, the current override, success, and error response.

**Tests**: Integration, tests/usage-web.test.ts
**Gate**: npx vitest run tests/usage-web.test.ts

### T16: Add usage page and tested behavior logic

**What**: Add the self-contained usage page and its exported filter, render-state, and polling functions.
**Where**: src/web/usage-page.ts
**Depends on**: T15
**Reuses**: UsageQueryResult, UsageTotals, and UsageMetricBucket
**Requirement**: WEB-43, WEB-45, WEB-46, WEB-47, WEB-48, WEB-49, WEB-50, WEB-51, WEB-52, WEB-53, WEB-60, WEB-78, WEB-80, WEB-81

**Done when**:

- Page logic exposes every UsageTotals field and each of byDay, byRepository, byModel, byAgent, and byRun.
- It exposes byOrigin when present and handles its absence from an older running daemon process over IPC without throwing.
- Period, repo, model, agent, since, and until changes each issue a query with the updated filters.
- Polling refreshes the active filter set and normalizes the interval with Math.max(1, Number(opts.interval) || 2).
- A query error leaves the last successful result visible and stores the error state.
- --by origin selects origin initially while every available breakdown remains reachable.
- The HTML injects the exported behavior function source; tests directly call that function in Node with fake fetch, timer, and render adapters.
- Tests extract the inline script from USAGE_PAGE, evaluate it in node:vm with an empty context and stubbed fetch, timers, and document, then call the usage page functions from that context.

**Tests**: Unit, tests/usage-page.test.ts
**Gate**: npx vitest run tests/usage-page.test.ts

### T17: Add usage --web command wiring

**What**: Add aggregate usage web startup while keeping the existing single-run and aggregate CLI branches in order.
**Where**: src/cli/commands/usage.ts
**Depends on**: T14, T15, T16
**Reuses**: Shared server, usage route factory, and existing command options
**Requirement**: WEB-09, WEB-54, WEB-55, WEB-56, WEB-80, WEB-81, WEB-83, WEB-95

**Done when**:

- Aggregate usage with --web starts /usage and passes the same date, repository, model, agent, and --by filters.
- --port and --no-open use the shared server; --interval uses the existing normalization rule.
- --web --json for aggregate usage starts the page and prints its token URL.
- When --backfill is absent, positional ID or --run takes the usage.get path before web startup, preserves --observe and --json, ignores aggregate-only --by origin, and starts no server.
- --backfill runs before web startup and starts no server even with --web.
- --web with --tui returns a usage error and starts no server.
- tests/web-cli.test.ts asserts --web --tui returns a usage error without starting a server.
- Without --web, snapshot, TUI, watch, plain, JSON, --by origin, --observe, and --backfill contracts remain unchanged.
- tests/web-cli.test.ts proves usage <id> --web --json calls usage.get and starts no server.
- tests/usage-cli.test.ts covers --by origin, --observe, --backfill, and --interval contracts.

**Tests**: Command contract, tests/web-cli.test.ts and tests/usage-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts tests/usage-cli.test.ts

### T18: Register usage routes with ui

**What**: Register /usage and /api/usage after their route factories are available.
**Where**: src/cli/commands/ui.ts
**Depends on**: T13, T15, T16
**Reuses**: Existing ui route table and the home page renderer
**Requirement**: WEB-08, WEB-43

**Done when**:

- codedeck ui serves /usage and /api/usage.
- The home page links to /usage only after its page route is registered.
- tests/web-cli.test.ts asserts both route status and the home link.

**Tests**: Integration, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts


## Diagram-Definition Cross-Check

| Task | Depends on | Diagram edges | Status |
| --- | --- | --- | --- |
| T1 | None | None | Match |
| T2 | T1 | T1 -> T2 | Match |
| T3 | T1 | T1 -> T3 | Match |
| T4 | T2, T3 | T2 -> T4; T3 -> T4 | Match |
| T5 | T4 | T4 -> T5 | Match |
| T6 | T1 | T1 -> T6 | Match |
| T7 | T1, T6 | T1 -> T7; T6 -> T7 | Match |
| T8 | T7 | T7 -> T8 | Match |
| T9 | T8 | T8 -> T9 | Match |
| T10 | T8 | T8 -> T10 | Match |
| T11 | T7, T8 | T7 -> T11; T8 -> T11 | Match |
| T12 | T9, T10, T11 | T9 -> T12; T10 -> T12; T11 -> T12 | Match |
| T13 | T12 | T12 -> T13 | Match |
| T14 | None | None | Match |
| T15 | T7, T14 | T7 -> T15; T14 -> T15 | Match |
| T16 | T15 | T15 -> T16 | Match |
| T17 | T14, T15, T16 | T14 -> T17; T15 -> T17; T16 -> T17 | Match |
| T18 | T13, T15, T16 | T13 -> T18; T15 -> T18; T16 -> T18 | Match |
| T19 | T12 | T12 -> T19 | Match |

## Test Co-location Validation

| Task | Code layer | Matrix requires | Task tests | Status |
| --- | --- | --- | --- | --- |
| T1 | Web server/router | Integration | tests/web-server.test.ts | OK |
| T2 | HTML pages and page behavior | Unit | tests/web-pages.test.ts | OK |
| T3 | Web server/router | Integration | tests/review.test.ts, tests/review-command.test.ts | OK |
| T4 | CLI wiring | Command contract | tests/web-cli.test.ts | OK |
| T5 | CLI wiring | Command contract | tests/web-cli.test.ts | OK |
| T6 | Security | Integration | tests/web-security.test.ts | OK |
| T7 | Security | Integration | tests/web-security.test.ts, tests/web-server.test.ts | OK |
| T8 | Setup core | Unit | tests/setup-plan.test.ts | OK |
| T9 | Setup core | Integration | tests/setup-wizard.test.ts, tests/setup-cli-contract.test.ts | OK |
| T10 | HTML pages and page behavior | Unit | tests/setup-page.test.ts | OK |
| T11 | Setup web handlers | Integration | tests/setup-web.test.ts | OK |
| T12 | CLI wiring | Command contract | tests/web-cli.test.ts, tests/setup-cli-contract.test.ts | OK |
| T13 | CLI wiring | Command contract | tests/web-cli.test.ts | OK |
| T14 | Usage query builder | Unit and command contract | tests/usage-cli.test.ts | OK |
| T15 | Usage web handler | Integration | tests/usage-web.test.ts | OK |
| T16 | HTML pages and page behavior | Unit | tests/usage-page.test.ts | OK |
| T17 | CLI wiring | Command contract | tests/web-cli.test.ts, tests/usage-cli.test.ts | OK |
| T18 | CLI wiring | Command contract | tests/web-cli.test.ts | OK |
| T19 | Documentation | none | none | OK |
