# Web console design

**Spec**: .specs/features/web-console/spec.md

**Status**: Draft

---

## Architecture Overview

Each CLI entry starts the same in-process HTTP server with a command-specific root path and route table. The shared router checks Host before dispatch. Action routes also check the per-start token and Origin. The server closes when its CLI command receives SIGINT or SIGTERM.

The UI command serves the home page and all registered pages. Review keeps its current root behavior when invoked as codedeck review. Setup and Usage open their page routes directly. Every page stays a self-contained HTML string.

~~~mermaid
flowchart LR
    C[CLI commands] --> S[Shared server and route table]
    S --> H[Host check]
    H --> O[Origin and token check on POST]
    O --> R[Route handler]
    R --> RP[Review page and API]
    R --> SP[Setup page and API]
    R --> UP[Usage page and API]
    SP --> P[Pure setup planner]
    P --> W[Config writer]
    UP --> Q[fetchUsageQuery]
    Q --> I[Daemon IPC]
    Q --> D[Read-only SQLite fallback]
~~~

The route table receives handlers from the CLI commands. This keeps the router independent of setup, usage, and review internals. The server remains in the CLI process and does not start or delegate work to the daemon.

## Research Notes

The repository already uses Node's built-in HTTP server in review.ts and declares Node 24 or newer in package.json. The official Node 24 HTTP docs cover createServer, listen, request headers, and server close. The official crypto docs cover randomBytes for the per-start token. No HTTP or frontend dependency is needed.

- Node.js v24 HTTP documentation: https://nodejs.org/download/release/latest-v24.x/docs/api/http.html
- Node.js v24 crypto documentation: https://nodejs.org/download/release/latest-v24.x/docs/api/crypto.html
- Context7 MCP was not available in this session.
- .specs/STATE.md is absent, so there are no active project decision entries to apply.

## Code Reuse Analysis

### Existing components to leverage

| Component | Location | How to use |
| --- | --- | --- |
| Review port parsing, browser opening, and request behavior | src/cli/commands/review.ts:7-135 | Move the shared server concerns into src/web/server.ts and keep review route behavior in the review handler. Preserve its default port and CLI flags. |
| Review HTML | src/web/review-page.ts:8-662 | Serve the existing string without adding assets or changing page behavior. |
| Usage query and fallback | src/cli/commands/usage.ts:37-77 | Inject fetchUsageQuery into the web usage handler so the page uses daemon IPC and the existing read-only SQLite fallback. |
| Usage request and result types | src/daemon/protocol.ts:160-211 | Use UsageQueryParams and UsageQueryResult. Add the optional byOrigin rendering only after feat/orchestrator-usage merges. |
| Setup wizard and selection rules | src/cli/commands/setup.ts:580-801 | Keep the existing wizard, but have it pass completed selections through the shared planner before saving. |
| Setup profile and config helpers | src/config/config.ts:48-76, :103-137, :237-257, :543-548 | Reuse RunAgentConfig, profile snapshot helpers, SetupConfigRead, SetupConfigStore, and saveConfig. |
| Setup proposal and diff behavior | src/cli/commands/setup.ts:1000-1036, :1229-1245, :1257-1332 | Move the pure proposal, diff, and binding validation logic into the shared planner while preserving SetupEnvelope fields and status values. |
| Model discovery | src/core/models.ts:151-190 | Use the cached catalog for GET and invoke getCachedOrDiscoverModels with refresh=true from the protected refresh route. |
| Existing review, setup, and usage tests | tests/review.test.ts, tests/review-command.test.ts, tests/setup-wizard.test.ts, tests/setup-cli-contract.test.ts, tests/usage*.test.ts | Preserve current assertions and add focused tests beside the new server, handlers, pages, and command wiring. |

### Integration points

| System | Integration method |
| --- | --- |
| CLI command registration | Add codedeck ui in src/cli/index.ts; keep web startup in the existing review, setup, and usage commands. |
| Review data | Keep GET /api/review read-only and delegate to the current local review loader. |
| Setup config | The handler reads through the existing config store, calls the pure planner, then saves only after validation passes. |
| Setup model catalog | GET returns cached status and models. A protected POST starts or joins discovery and shows the page's discovering state while it is pending. |
| Usage analytics | The handler translates URL filters to UsageQueryParams and calls the same fetchUsageQuery used by the CLI. |
| Daemon | No changes. Usage continues to use the current IPC query and SQLite fallback from the CLI process. |

## Components

### Shared web server

- **Purpose**: Start a loopback-only Node HTTP server, dispatch a route table, print the URL, and close with the command.
- **Location**: src/web/server.ts
- **Interfaces**:
  - createWebServer(options): creates the route listener with a command-specific root page.
  - startWebServer(options): listens on 127.0.0.1, opens the requested URL unless --no-open is set, and returns a close handle.
  - parseWebPort(value): validates integer ports from 1 through 65535; review re-exports or delegates to this parser.
- **Dependencies**: node:http, node:child_process, route handlers, and the security guard.
- **Reuses**: The current listener, browser opener, and port behavior in src/cli/commands/review.ts.

### Route security

- **Purpose**: Reject requests with an invalid Host and protect every POST route with a per-start token and same-origin check.
- **Location**: src/web/security.ts
- **Interfaces**:
  - createWebSecurity(boundPort): creates a 32-byte random token and a request guard.
  - checkWebRequest(request, routePolicy): returns an allow result or HTTP 403.
- **Dependencies**: node:crypto and node:http request headers.
- **Reuses**: The server receives normalized lower-case header names from Node's IncomingMessage.

Use a host-only cookie named codedeck_ui_token with HttpOnly, SameSite=Strict, and Path=/. Set it on HTML responses. Compare its value with the token created for this server process. Reject every POST whose Origin is missing or whose HTTP origin does not match the request Host and bound port. The only accepted Host values are 127.0.0.1:<bound-port> and localhost:<bound-port>. Do not add CORS response headers.

### Home page

- **Purpose**: List links to Review, Usage, and Setup.
- **Location**: src/web/home-page.ts
- **Interfaces**: HOME_PAGE is a self-contained HTML string.
- **Dependencies**: None.
- **Reuses**: The inline HTML, CSS, and JavaScript style in src/web/review-page.ts.

### Setup planner

- **Purpose**: Apply a complete selection set to the resolved config target and return a proposal, diff, and validations without I/O.
- **Location**: src/config/setup-plan.ts
- **Interfaces**:
  - buildSetupPlan(input): returns proposedConfig, diff, and validations.
  - SetupPlanInput carries the current config read, resolved profile target, complete setup selections, and catalog validation result.
  - SetupPlanResult carries the complete proposed config, config diff, and validation details used by SetupEnvelope.
- **Dependencies**: Existing config, profile, role binding, orchestrator, sandbox, autocompact, and model catalog types.
- **Reuses**: Existing config merge rules, profile snapshot helpers, diffConfig, and validateBindings behavior from src/cli/commands/setup.ts.

Keep file reads, catalog discovery, and writes outside buildSetupPlan. The terminal wizard and setup web handler pass the same selection model to this function. The existing runSetupBatch stays on its current contract.

When autocompact is turned on, the planner sets enabled=true and keeps other fields. When it is turned off, it sets enabled=false only if the current config already has an autocompact block; otherwise it keeps that block absent. This matches the current wizard behavior.

### Setup web page

- **Purpose**: Show the full wizard selection set, catalog state, proposal diff, and apply result.
- **Location**: src/web/setup-page.ts
- **Interfaces**: SETUP_PAGE is a self-contained HTML string that submits JSON to the setup API routes.
- **Dependencies**: Browser fetch, setup catalog and proposal endpoints.
- **Reuses**: The role, effort, orchestrator, sandbox, autocompact, and profile semantics in src/cli/commands/setup.ts.

### Setup web handlers

- **Purpose**: Load catalog state, refresh discovery, produce dry-run proposals, and apply validated setup changes.
- **Location**: src/web/setup-routes.ts
- **Interfaces**:
  - createSetupRoutes(dependencies): returns GET page/catalog and POST refresh/dry-run/apply routes.
  - createSetupHandler(dependencies): exposes the same routes as an HTTP request listener when a command needs only setup.
- **Dependencies**: Config store, model registry, getBatchModels, getCachedOrDiscoverModels, and buildSetupPlan.
- **Reuses**: SetupEnvelope statuses, validation codes, profile targeting, and config persistence.

Bound request bodies to 64 KiB. A refresh route keeps one in-flight discovery promise and shares it with concurrent refresh callers. Read and validate the current config immediately before the synchronous plan-and-save section so two requests in this process do not both apply a proposal based on an older read.

For an explicit --profile target with no saved snapshot, use the existing setup target resolution and profile defaults. Do not add a profile selector or profile editor to the page.

### Usage web page

- **Purpose**: Display usage totals and every available breakdown, with periodic refresh.
- **Location**: src/web/usage-page.ts
- **Interfaces**: USAGE_PAGE is a self-contained HTML string that serializes selected filters into GET /api/usage.
- **Dependencies**: Browser fetch and the usage API response.
- **Reuses**: The current UsageQueryResult fields and the usage query controls from src/cli/commands/usage.ts.

### Usage web handler

- **Purpose**: Translate the browser query into UsageQueryParams and return the CLI usage query result.
- **Location**: src/web/usage-routes.ts
- **Interfaces**:
  - createUsageHandler(fetchQuery): returns a GET /api/usage handler.
  - parseUsageWebQuery(searchParams, cwd): maps the supported CLI filter names to UsageQueryParams.
- **Dependencies**: An injected fetchUsageQuery function.
- **Reuses**: UsageQueryParams, UsageQueryResult, UsageTotals, and UsageMetricBucket from src/daemon/protocol.ts.

The handler does not import the CLI command module. Both codedeck usage --web and codedeck ui inject fetchUsageQuery, avoiding a web-to-CLI import cycle. The page checks for byOrigin at runtime so it still renders against results produced before the pending merge.

Map aggregate query flags with the existing CLI precedence: --all, then --today, then --days, then the default today period when there is no since value. Map 3, 7, and 30 days to their period values; map another positive day count to a local-midnight since value. --current overrides --repo. Keep until, model, and agent filters.

### CLI wiring

- **Purpose**: Select the correct root route and keep existing command branches stable.
- **Location**: src/cli/commands/ui.ts, src/cli/commands/review.ts, src/cli/commands/setup.ts, src/cli/commands/usage.ts, and src/cli/index.ts
- **Interfaces**:
  - codedeck ui opens the home page.
  - codedeck review opens the review page at both / and /review.
  - codedeck setup opens /setup unless --tui or batch options select an existing path.
  - codedeck usage opens /usage only when --web is supplied and no run ID is present.
- **Dependencies**: Shared server, page constants, and route handlers.
- **Reuses**: Existing commander registration and command option parsing.

## Data Models

### Setup selection

~~~typescript
interface SetupSelection {
  agents: Partial<Record<Role, RoleBinding>>
  orchestrator: OrchestratorMode
  defaultSandbox?: RunAgentConfig["defaultSandbox"]
  autocompact?: RunAgentConfig["autocompact"]
}
~~~

Profile target is supplied by the CLI command and is not accepted from the browser request body. A selected profile updates the profile snapshot produced by the existing profile helpers.

### Setup plan

~~~typescript
interface SetupPlanInput {
  configRead: SetupConfigRead
  profile?: string
  selections: SetupSelection
  catalog: BatchModelsResult
}

interface SetupPlanResult {
  proposedConfig: RunAgentConfig
  diff: SetupDiff
  validations: SetupValidations
}
~~~

SetupDiff and SetupValidations are the pure setup core's result types. The CLI adapts them into the current SetupEnvelope fields. The names can follow nearby code conventions during implementation, but the input and output responsibilities stay fixed. The planner is synchronous and has no file or network dependencies.

### Usage result

The route returns the same UsageQueryResult as the CLI. After feat/orchestrator-usage merges, byOrigin is optional and uses UsageMetricBucket[]. Before that merge, the page must render the five current breakdowns without requiring that property.

## Error Handling Strategy

| Error scenario | Handling | User impact |
| --- | --- | --- |
| Host, token, or Origin rejected | Return HTTP 403 before route handler invocation. | No protected action runs. |
| Invalid port or listen failure | Print the error and exit with code 1. | No command claims that a server is available. |
| Malformed or oversized setup body | Return HTTP 400 and do not write config. | The page can correct or retry the request. |
| Setup selection validation fails | Return HTTP 422 with the existing validation code and saved=false. | The user sees the failed binding and can revise the selection. |
| Config save fails | Return HTTP 500 with saved=false and the existing save error. | The proposal remains visible and the config is not reported as saved. |
| One model harness cannot be discovered | Return its existing HarnessModels error with other catalog results. | The page can still show catalogs from other harnesses. |
| Usage query fails | Return HTTP 500 with a JSON error; the page keeps the last successful result and shows the error. | Existing IPC and read-only SQLite fallback remain in use. |
| One catalog harness fails discovery | Keep its HarnessModels error in the catalog response beside successful results from other harnesses. | The user can configure roles whose catalogs are available. |

## Risks & Concerns

| Concern | Location (file:line) | Impact | Mitigation |
| --- | --- | --- | --- |
| The review command currently combines server lifecycle, routing, port parsing, and browser opening. | src/cli/commands/review.ts:7-135 | A careless extraction can change the existing review URL or command behavior. | Keep review route tests and command tests in the same task that rewires the command. |
| Setup selection and persistence currently live inside a long wizard function. | src/cli/commands/setup.ts:625-801 | Duplicated web planning could drift in merge, profile, or save behavior. | Extract a pure planner, reuse it from the wizard, and cover it with unit tests. |
| The current review server has no Host, token, or Origin checks. | src/cli/commands/review.ts:49-87, :110-124 | Adding action endpoints without a shared guard could expose config writes to forged browser requests. | Guard all routes at the shared server before route dispatch; protect POST routes with token and Origin. |
| Model discovery may take seconds and writes a model cache. | src/cli/commands/setup.ts:634-648; src/core/models.ts:151-190 | A refresh can look frozen or be triggered more than once. | Show a visible discovering state and coalesce concurrent refreshes. |
| Usage origin data is not present at the current HEAD. | src/daemon/protocol.ts:199-211 | P5 will not compile or can hide current usage data if it assumes the pending field. | Sequence P5 after feat/orchestrator-usage merges and render byOrigin conditionally. |
| There are no browser handler tests in the current test set. | tests/review.test.ts, tests/setup-cli-contract.test.ts, tests/usage-query.test.ts | New routes could diverge from CLI behavior without coverage. | Add scoped HTTP integration tests for setup and usage handlers and page tests for HTML behavior. |

## Tech Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Home page command | codedeck ui | The home page gets a clear entry while codedeck review keeps its root route. |
| Root routing | Route table has a command-specific root page. | codedeck review can keep / and /review as review pages while codedeck ui uses / for home. |
| Token transport | HttpOnly host-only cookie with SameSite=Strict and Path=/. | Same-origin browser fetch sends it without exposing the token to page JavaScript. |
| Action methods | Use POST for catalog refresh, dry-run, and apply. | Refresh can write the model cache; every action therefore receives the same token and Origin checks. |
| Setup refresh state | The page displays “Discovering models...” while its refresh request is pending. | This uses a normal request and avoids a separate discovery job lifecycle. |
| Usage refresh | Poll the current query every 2 seconds by default. | It matches the existing CLI watch default and replaces the need for --watch in a browser. |
| Usage route dependency | Inject fetchUsageQuery into the web handler. | The same query and fallback logic serve the CLI and browser without a module cycle. |
| Setup --refresh flag | Open /setup and start a protected refresh when the page loads. | This preserves the existing refresh option when setup becomes browser-first. |
| --watch with --web | The browser refreshes itself; --interval changes its timer and --watch does not select terminal rendering. | The user gets a live browser view without the terminal watch loop. |

## Phase Dependencies

| Phase | Scope | Depends on |
| --- | --- | --- |
| P1 | Shared server, review compatibility, home page, and codedeck ui | None |
| P2 | Host, token, and Origin enforcement | P1 |
| P3 | Pure setup planner and wizard reuse | P2 |
| P4 | Setup page, handlers, and command wiring | P3 |
| P5 | Usage page and handlers | P4 and merge of feat/orchestrator-usage |

The required CodeDeck command and page behavior is specified in spec.md. These artifacts stop at planning; implementation and implementation-time verifier reports are outside this docs-only task.
