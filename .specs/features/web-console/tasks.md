# Web console tasks

## Execution Protocol (mandatory)

Implement these tasks with the tlc-spec-driven skill. Follow its Execute flow, per-task gates, atomic commits, and final verifier. The implementation stays within the source and test files named by each task. Do not change plugin files, add a frontend framework, or run the full Vitest suite.

---

**Design**: .specs/features/web-console/design.md

**Status**: Draft

## Test Coverage Matrix

> Generated from the current Vitest setup, repository instructions, and spec. Tests run under Node and live in tests/. The current project instructions require scoped Vitest commands and prohibit the full suite.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Web server/router | Integration | Loopback binding, port parsing, route dispatch, review aliases, browser-open fallback, and close behavior | tests/web-server.test.ts, tests/review.test.ts, tests/review-command.test.ts | npx vitest run tests/web-server.test.ts tests/review.test.ts tests/review-command.test.ts |
| Security | Integration | Accepted and rejected Host, token, and Origin combinations; rejected requests never invoke handlers | tests/web-security.test.ts, tests/web-server.test.ts | npx vitest run tests/web-security.test.ts tests/web-server.test.ts |
| Setup core | Unit and integration | Pure planner results for each setup field, profile targeting, diff and validation results, wizard compatibility, and existing setup contracts | tests/setup-plan.test.ts, tests/setup-wizard.test.ts, tests/setup-cli-contract.test.ts | npx vitest run tests/setup-plan.test.ts tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts |
| Setup web handlers | Integration | Catalog reads and refresh, dry-run without writes, apply, unchanged apply, malformed body, validation failure, and save failure | tests/setup-web.test.ts | npx vitest run tests/setup-web.test.ts |
| Usage web handler | Integration | Every supported filter mapping, query success, and IPC plus SQLite error handling | tests/usage-web.test.ts | npx vitest run tests/usage-web.test.ts |
| HTML pages | Unit | Home links, setup controls, visible discovery state, usage totals and breakdowns, optional byOrigin, and refresh interval | tests/web-pages.test.ts | npx vitest run tests/web-pages.test.ts |
| CLI wiring | Command contract | ui, review, setup, and usage flags; setup batch output; usage JSON and single-run statusline behavior | tests/web-cli.test.ts, tests/review-command.test.ts, tests/setup-cli-contract.test.ts, tests/usage-statusline-contract.test.ts | npx vitest run tests/web-cli.test.ts tests/review-command.test.ts tests/setup-cli-contract.test.ts tests/usage-statusline-contract.test.ts |

## Gate Check Commands

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Task | After each task | Run the scoped command in that task's Gate field. |
| P1 | After shared server and home wiring | npx vitest run tests/web-server.test.ts tests/web-pages.test.ts tests/review.test.ts tests/review-command.test.ts tests/web-cli.test.ts |
| P2 | After security integration | npx vitest run tests/web-security.test.ts tests/web-server.test.ts |
| P3 | After setup core extraction | npx vitest run tests/setup-plan.test.ts tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts |
| P4 | After setup web wiring | npx vitest run tests/setup-web.test.ts tests/web-pages.test.ts tests/web-cli.test.ts tests/setup-cli-contract.test.ts |
| P5 | After usage web wiring and feat/orchestrator-usage merge | npx vitest run tests/usage-web.test.ts tests/web-pages.test.ts tests/web-cli.test.ts tests/usage-statusline-contract.test.ts |

## Execution Plan

Phases run in P1 to P5 order. Tasks run sequentially within each phase. P5 must not start until feat/orchestrator-usage has merged into the implementation base.

### Phase 1: Shared server and home page

```text
T1 -> T2
T1 -> T3
T1 -> T4
T2 -> T4
T3 -> T4
T4 -> T5
```

### Phase 2: Security

```text
T1 -> T6 -> T7
T1 -> T7
```

### Phase 3: Shared setup planner

```text
T8 -> T9
```

### Phase 4: Setup web

```text
T8 -> T10
T9 -> T10
T7 -> T11
T8 -> T11
T9 -> T12
T10 -> T12
T11 -> T12
T12 -> T13
```

### Phase 5: Usage web

```text
T7 -> T14
T13 -> T14 -> T15 -> T16 -> T17
T14 -> T16
T13 -> T17
```

## Task Breakdown

### T1: Extract the shared server and router

**What**: Add the loopback server, route table, port parser, browser opener, URL output, and signal shutdown.
**Where**: src/web/server.ts
**Depends on**: None
**Reuses**: src/cli/commands/review.ts
**Requirement**: WEB-01, WEB-02, WEB-03, WEB-04, WEB-09, WEB-57
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The server binds to 127.0.0.1 and accepts a validated port from 1 through 65535.
- The default port is 3100.
- A failed browser open or --no-open prints the full URL while the process keeps serving.
- SIGINT and SIGTERM close the server.
- An occupied port prints a listen error and exits with code 1 before reporting a started URL.
- Route tests cover successful dispatch, unknown paths, listen errors, and close behavior.

**Tests**: Integration, tests/web-server.test.ts
**Gate**: npx vitest run tests/web-server.test.ts

### T2: Add the home page

**What**: Add a self-contained home page with links to Review, Usage, and Setup.
**Where**: src/web/home-page.ts
**Depends on**: T1
**Reuses**: src/web/review-page.ts
**Requirement**: WEB-08
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The page contains links to /review, /usage, and /setup.
- The page has no external CSS, JavaScript, image, or font dependency.
- Page tests assert each link target.

**Tests**: Unit, tests/web-pages.test.ts
**Gate**: npx vitest run tests/web-pages.test.ts

### T3: Rewire the review command

**What**: Move review server startup to the shared server while preserving the handler exports and current review routes.
**Where**: src/cli/commands/review.ts
**Depends on**: T1
**Reuses**: src/web/review-page.ts and src/git/review.ts
**Requirement**: WEB-05, WEB-06, WEB-07
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- GET / and GET /review still serve the current review page.
- GET /api/review keeps ref=HEAD as its default and passes file when supplied.
- Existing review command options and exported test seams remain available.
- Existing review route and command tests pass without changing their current assertions.

**Tests**: Integration, tests/review.test.ts and tests/review-command.test.ts
**Gate**: npx vitest run tests/review.test.ts tests/review-command.test.ts

### T4: Add the ui command

**What**: Start the shared server with the home page as root and the review route available.
**Where**: src/cli/commands/ui.ts
**Depends on**: T1, T2, T3
**Reuses**: Shared server and review handler
**Requirement**: WEB-08, WEB-09
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- codedeck ui opens / by default.
- The route table serves /review.
- --port and --no-open use the shared server options.
- Command tests assert the home path, flags, printed URL, and browser-open failure behavior.

**Tests**: Command contract, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts

### T5: Register ui with the CLI

**What**: Register the ui command with the root Commander program.
**Where**: src/cli/index.ts
**Depends on**: T4
**Reuses**: Existing command registration order in src/cli/index.ts
**Requirement**: WEB-08
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- codedeck --help lists ui.
- CLI tests invoke the registered command.

**Tests**: Command contract, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts

### T6: Add the request security guard

**What**: Generate the per-start token and validate Host, token cookie, and Origin.
**Where**: src/web/security.ts
**Depends on**: T1
**Reuses**: Node request headers and the configured bound port
**Requirement**: WEB-10, WEB-11, WEB-12, WEB-13, WEB-58
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- Each server security instance creates a 32-byte random token.
- HTML responses can set the host-only HttpOnly, SameSite=Strict, Path=/ cookie.
- The guard accepts only the two allowed Host values with the bound port.
- Missing or stale token and missing or mismatched Origin return 403 for POST routes.
- A cookie from a prior server process is rejected by the current security instance.
- Security tests assert that rejected requests do not reach route handlers.

**Tests**: Integration, tests/web-security.test.ts
**Gate**: npx vitest run tests/web-security.test.ts

### T7: Apply security before route dispatch

**What**: Integrate the security guard into the shared server so every request gets a Host check and every POST gets token and Origin checks.
**Where**: src/web/server.ts
**Depends on**: T1, T6
**Reuses**: Route policies from src/web/security.ts
**Requirement**: WEB-10, WEB-12, WEB-13, WEB-58
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The guard runs before route dispatch.
- Valid GET routes remain Host-checked and do not require a mutation token.
- Every POST route is rejected with 403 when its token or Origin check fails.
- A token issued by a previous server process cannot authorize a POST.
- Server-level tests cover the guard and route handler call count.

**Tests**: Integration, tests/web-security.test.ts and tests/web-server.test.ts
**Gate**: npx vitest run tests/web-security.test.ts tests/web-server.test.ts

### T8: Create the pure setup planner

**What**: Add a synchronous planner for full role, orchestrator, sandbox, autocompact, and profile selections.
**Where**: src/config/setup-plan.ts
**Depends on**: None
**Reuses**: Existing config and profile helpers, diffConfig, and binding validation
**Requirement**: WEB-14, WEB-15, WEB-16, WEB-17, WEB-18, WEB-19, WEB-20, WEB-21, WEB-61
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The planner returns the whole proposed config, diff, and validation results.
- It performs no file, network, or discovery I/O.
- Autocompact on sets enabled=true; off sets enabled=false only when the current config already has an autocompact block.
- Tests cover each field, preservation of unselected values, profiles, diff paths, and rejected bindings.
- Rejected bindings cannot produce a saveable success result.

**Tests**: Unit, tests/setup-plan.test.ts
**Gate**: npx vitest run tests/setup-plan.test.ts

### T9: Reuse the planner from the terminal wizard

**What**: Replace wizard-local config assembly with the shared planner and keep the same save boundary.
**Where**: src/cli/commands/setup.ts
**Depends on**: T8
**Reuses**: Existing wizard selection and persistence flow
**Requirement**: WEB-22
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The wizard delegates completed selections to the planner.
- Discovery, abort, skip, save-failure, and profile behavior remain unchanged.
- Existing setup wizard and setup CLI contract cases remain unchanged and pass.

**Tests**: Integration, tests/setup-wizard.test.ts and tests/setup-cli-contract.test.ts
**Gate**: npx vitest run tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts

### T10: Add the setup page

**What**: Add the self-contained setup page with all controls represented by the current wizard.
**Where**: src/web/setup-page.ts
**Depends on**: T8, T9
**Reuses**: Setup selection semantics in src/cli/commands/setup.ts
**Requirement**: WEB-23, WEB-25, WEB-37, WEB-38, WEB-39, WEB-40, WEB-41, WEB-42
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The page offers every role's harness and model selection.
- It offers effort only for roles whose wizard has an effort screen.
- It offers all orchestrator parameters, both sandbox values, and both autocompact values.
- It displays the selected --profile target.
- Refresh shows “Discovering models...” until the response completes.
- Page tests assert controls, route requests, and no external assets.

**Tests**: Unit, tests/web-pages.test.ts
**Gate**: npx vitest run tests/web-pages.test.ts

### T11: Add setup catalog and mutation handlers

**What**: Implement GET catalog and protected POST refresh, dry-run, and apply handlers.
**Where**: src/web/setup-routes.ts
**Depends on**: T7, T8
**Reuses**: Config store, getBatchModels, getCachedOrDiscoverModels, and buildSetupPlan
**Requirement**: WEB-24, WEB-25, WEB-26, WEB-27, WEB-28, WEB-29, WEB-30, WEB-31, WEB-32, WEB-33, WEB-59
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- GET catalog returns cached catalog data and status without discovery.
- POST refresh starts discovery and concurrent callers share its promise.
- A discovery error for one harness stays beside the other returned catalog entries.
- Dry-run returns a proposal, diff, and validations without writing.
- Apply writes only a valid non-empty proposal; an empty diff returns unchanged without writing.
- Malformed, oversized, invalid, and save-failure requests return the specified status and envelope.
- HTTP integration tests verify the saved config and every no-write path.

**Tests**: Integration, tests/setup-web.test.ts
**Gate**: npx vitest run tests/setup-web.test.ts

### T12: Make web setup the default command path

**What**: Add setup web flags and route startup while preserving --tui and the existing batch path.
**Where**: src/cli/commands/setup.ts
**Depends on**: T9, T10, T11
**Reuses**: Existing argument parser and runSetupBatch
**Requirement**: WEB-34, WEB-35, WEB-36, WEB-42
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- codedeck setup without batch flags or --tui opens /setup.
- --tui selects the existing terminal wizard.
- Batch flags still call runSetupBatch and keep JSON, dry-run, binding, exit-code, and save behavior.
- --profile and --refresh reach the intended web setup target and catalog refresh.
- Existing setup CLI contract cases pass without changes.

**Tests**: Command contract, tests/web-cli.test.ts and tests/setup-cli-contract.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts tests/setup-cli-contract.test.ts

### T13: Add setup routes to ui

**What**: Register the setup page and setup API routes in the home command's route table.
**Where**: src/cli/commands/ui.ts
**Depends on**: T12
**Reuses**: Existing home and review route registrations
**Requirement**: WEB-08, WEB-23
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- codedeck ui serves /setup and its API routes.
- The home page setup link returns the setup page.
- Command tests assert page status and route registration.

**Tests**: Integration, tests/web-cli.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts

### T14: Add the usage query handler

**What**: Translate browser filters into UsageQueryParams and call an injected usage query function.
**Where**: src/web/usage-routes.ts
**Depends on**: T7, T13
**Reuses**: UsageQueryParams and fetchUsageQuery
**Requirement**: WEB-44
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The handler maps every supported aggregate filter to the same value used by the CLI.
- --current resolves to the command process working directory.
- Query errors return a JSON error response.
- Tests cover each filter and the successful query result.

**Tests**: Integration, tests/usage-web.test.ts
**Gate**: npx vitest run tests/usage-web.test.ts

### T15: Add the usage page

**What**: Add the self-contained usage page with totals, all current breakdowns, optional byOrigin, and polling.
**Where**: src/web/usage-page.ts
**Depends on**: T14
**Reuses**: UsageQueryResult and UsageMetricBucket
**Requirement**: WEB-43, WEB-45, WEB-46, WEB-47, WEB-48, WEB-49, WEB-50, WEB-51, WEB-52, WEB-53, WEB-60
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- The page renders every UsageTotals field and each of the five existing breakdown arrays.
- It renders byOrigin when present and renders the other sections when absent.
- It polls the active filter set every 2 seconds by default and honors --interval.
- Query errors leave the last successful result visible and show the error.
- Page tests cover origin-present, origin-absent, polling, and error states.

**Tests**: Unit, tests/web-pages.test.ts
**Gate**: npx vitest run tests/web-pages.test.ts

### T16: Add usage --web command wiring

**What**: Add --web, --port, and --no-open behavior to aggregate usage while preserving CLI output paths.
**Where**: src/cli/commands/usage.ts
**Depends on**: T14, T15
**Reuses**: Existing usage option parser, fetchUsageQuery, and single-run branch
**Requirement**: WEB-54, WEB-55, WEB-56
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- --web opens /usage and forwards aggregate filters.
- Without --web the existing snapshot, TUI, watch, plain, and JSON paths remain in place.
- Positional and --run IDs keep the current single-run branch, including when --web is also supplied.
- Usage and statusline command contract tests pass unchanged.

**Tests**: Command contract, tests/web-cli.test.ts and tests/usage-statusline-contract.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts tests/usage-statusline-contract.test.ts

### T17: Add usage routes to ui

**What**: Register the usage page and API route in the home command's route table.
**Where**: src/cli/commands/ui.ts
**Depends on**: T13, T16
**Reuses**: Existing home, review, and setup route registrations
**Requirement**: WEB-08, WEB-43
**Tools**: MCP none; Skill tlc-spec-driven

**Done when**:

- codedeck ui serves /usage and /api/usage.
- The home page usage link returns the usage page.
- Command tests assert page status and route registration.

**Tests**: Integration, tests/web-cli.test.ts and tests/web-server.test.ts
**Gate**: npx vitest run tests/web-cli.test.ts tests/web-server.test.ts
