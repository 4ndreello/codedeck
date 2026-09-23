# Web console design

**Spec**: .specs/features/web-console/spec.md

**Status**: Draft

---

## Architecture overview

Each web command starts the shared Node HTTP server in the CLI process. The server binds to 127.0.0.1, obtains its actual port after listen, creates the per-start security instance for that port, then opens or prints a token-bearing URL. The route table owns page registration and supplies its registered page links to the home renderer. Review keeps its existing root and /review aliases.

Every request passes a Host check before route dispatch. POST routes also require the per-port session cookie and a matching HTTP Origin. A valid token query on an HTML GET bootstraps the cookie and redirects to the URL without the query token. The server closes with its owning command.

Setup uses a pure planner that accepts a RunAgentConfig and selections, then returns a proposal and diff. Config reading, binding validation, and writing remain separate. The web apply path validates only bindings whose harness or model changed. Batch keeps validating only its winning --bind values. The terminal wizard continues accepting typed and off-catalog models without catalog validation.

Usage shares one pure query parameter builder between the CLI and the web API. The page keeps its view-state, filter, and polling transitions in testable TypeScript functions and injects those function sources into its self-contained HTML string.

~~~mermaid
flowchart LR
    C[CLI commands] --> S[Shared loopback server]
    S --> H[Host guard]
    H --> O[Token and Origin guard on POST]
    O --> R[Registered route table]
    R --> P[Self-contained pages]
    R --> A[HTTP API handlers]
    A --> SP[Setup planner]
    A --> V[Separate setup validation]
    V --> W[Config writer]
    A --> U[Usage query parameter builder]
    U --> Q[fetchUsageQuery]
    Q --> I[Daemon IPC]
    Q --> D[Read-only SQLite fallback]
~~~

## Research notes

The existing review command uses Node's built-in HTTP server and browser opener. The repository uses Node 24 or newer. The server and token can use node:http and node:crypto without another dependency.

- Node.js v24 HTTP documentation: https://nodejs.org/download/release/latest-v24.x/docs/api/http.html
- Node.js v24 crypto documentation: https://nodejs.org/download/release/latest-v24.x/docs/api/crypto.html
- Context7 MCP was not available in this session.
- .specs/STATE.md is absent, so there are no active project decision entries to apply.

## Code reuse analysis

### Existing components to leverage

| Component | Location | How to use |
| --- | --- | --- |
| Review port parsing, browser opening, and request behavior | src/cli/commands/review.ts:7-135 | Move server startup, port parsing, and browser opening into src/web/server.ts. Keep review data handling and both existing page routes. |
| Review page | src/web/review-page.ts:8-662 | Serve the current self-contained HTML string without adding assets. |
| Setup wizard selections | src/cli/commands/setup.ts:499-801 | Keep its harness, model, effort, orchestrator, sandbox, autocompact, skip, and profile choices. Pass completed selections through the planner before saving. |
| Picker free-text behavior | src/cli/picker-state.ts:113-141 | Preserve typed harness:model values, including models absent from the catalog. |
| Profile target resolution | src/cli/commands/setup.ts:831-853 | Use the current explicit and active profile rules for setup state and planning. |
| Setup batch validation | src/cli/commands/setup.ts:1402-1459 | Keep validation on winning --bind values in the batch caller and use the shared helpers from src/config/setup.ts. |
| Setup config reads | src/config/config.ts:391-405, 531-540 | Use readConfigForSetup for web state and apply so invalid JSON and read errors are not replaced by default config. Do not use loadConfig for apply. |
| Setup diff, target, envelope, and validation helpers | Current implementations are src/cli/commands/setup.ts:831-853, 1000-1036, 1229-1302; profile helpers are src/config/config.ts:48-76, 103-137, 237-257, 543-548 | Move resolveSetupTarget, SetupEnvelope, diffConfig, catalogContains, and validateBindings into src/config/setup.ts so both CLI and web callers import them without a config-to-CLI dependency. |
| Model catalog | src/core/models.ts:276-389 | Use getBatchModels for catalog reads and refresh. |
| Usage query and fallback | src/cli/commands/usage.ts:65-105 | Reuse fetchUsageQuery so CLI and web keep daemon usage.query and read-only SQLite fallback behavior. |
| Usage query and result types | src/daemon/protocol.ts:169-221 | Use UsageQueryParams and UsageQueryResult. Main already requires byOrigin at 80ec486 (#103); tolerate its absence only when an older daemon process answers over IPC. |
| Existing command and behavior tests | tests/review.test.ts, tests/review-command.test.ts, tests/setup-wizard.test.ts, tests/setup-cli-contract.test.ts, tests/usage-cli.test.ts | Preserve current contract assertions and add focused tests for new server, page logic, route handlers, and CLI options. |
| Setup README section | README.md:149-186 | Replace the picker-first description with web setup as the default and retain --tui and --refresh guidance. |

### Integration points

| System | Integration method |
| --- | --- |
| CLI command registry | Register codedeck ui while preserving the current review, setup, and usage command contracts. |
| Review data | Keep GET /api/review read-only and delegate to the current review loader. |
| Setup config | Read with readConfigForSetup, resolve the target, plan from RunAgentConfig, validate changed bindings separately, then save only a valid proposal. |
| Setup catalog | GET calls getBatchModels with allowNetwork:false. Protected refresh calls it with refresh:true, allowNetwork:true, and timeoutMs:12000. |
| Usage query | Convert URL filters to the options accepted by buildUsageQueryParams, then inject the result into fetchUsageQuery. |
| Daemon | No changes. HTTP stays in the CLI process; usage keeps its existing IPC and SQLite fallback. |

## Components

### Shared web server

- **Purpose**: Start a loopback server, dispatch registered routes, open or print its URL, and close it with the CLI command.
- **Location**: src/web/server.ts
- **Interfaces**:
  - createWebServer(options) creates a listener from a route table and injectable server dependencies.
  - startWebServer(options) listens on 127.0.0.1 and returns its actual address, URL, and close operation.
  - parseWebPort(value) accepts integer user ports from 1 through 65535.
- **Dependencies**: node:http, node:child_process, page and API route handlers, and the security guard.
- **Reuses**: Current listener, browser opener, and port behavior in src/cli/commands/review.ts.

The injected server seam may listen on port 0 for tests. After listen, read server.address().port and pass that actual port to createWebSecurity before opening or printing the URL. The CLI parser still rejects port 0. Inject both server close and process exit functions so signal handling can be tested without process.exit.

The browser opener and --no-open output use the initial route URL with ?t=<token>. If opening fails, print that full URL and keep serving. SIGINT and SIGTERM close the server, then call the injected exit function. An occupied port reports the listen error and never reports a started URL.

The route table identifies page routes separately from API routes and may attach a navigation label to a page. codedeck ui renders links only from its registered page routes. The review command selects the review page at both / and /review; codedeck ui selects the home page at /.

### Request security

- **Purpose**: Check Host on every request and protect each mutating route with a token cookie and Origin validation.
- **Location**: src/web/security.ts
- **Interfaces**:
  - createWebSecurity(boundPort) creates one cryptographically random 32-byte token after listen.
  - checkWebRequest(request, routePolicy) returns an allow result or HTTP 403.
  - getTokenUrl(url, token) adds the out-of-band t query parameter to an initial HTML page URL.
- **Dependencies**: node:crypto and Node request headers.
- **Reuses**: Node's normalized IncomingMessage headers and the port resolved by the server.

Accept only Host values 127.0.0.1:<bound-port> and localhost:<bound-port>, compared case-insensitively. Every POST requires an HTTP Origin whose host and port match that request Host and the bound port. A missing or mismatched Host, cookie, or Origin returns 403 before the route handler runs.

Only an HTML GET with the valid t query token sets the host-only HttpOnly cookie named codedeck_ui_token_<port>, with SameSite=Strict and Path=/. That response uses HTTP 303 and redirects to the same path without t. An HTML GET without a valid token does not set the cookie. The cookie value is checked against the current server token on every POST. Do not add CORS response headers.

Every HTML response includes Content-Security-Policy: frame-ancestors 'none'. This applies to the home, review, setup, and usage pages.

### Home page

- **Purpose**: List links to pages registered by the active route table.
- **Location**: src/web/home-page.ts
- **Interfaces**: renderHomePage(pageRoutes) returns a self-contained HTML string for the passed route labels and paths.
- **Dependencies**: Registered page route metadata.
- **Reuses**: Inline HTML and CSS in src/web/review-page.ts.

The home page does not hard-code future routes. The initial ui command links only the page routes it registers. Adding the setup and usage routes adds their links through the same route metadata.

### Setup planner

- **Purpose**: Apply setup selections to RunAgentConfig and return a proposed config and diff without I/O or catalog validation.
- **Location**: src/config/setup.ts
- **Interfaces**:
  - buildSetupPlan(currentConfig, targetProfile, selections) returns proposedConfig and diff.
  - resolveSetupTarget applies explicit and active profile rules.
  - SetupSelection represents selected bindings, effort values, optional orchestrator mode and parameters, sandbox, autocompact, and per-role off-catalog confirmation.
  - SetupEnvelope, diffConfig, catalogContains, and validateBindings are exported for the CLI and web routes.
- **Dependencies**: RunAgentConfig, Role, role binding, orchestrator, sandbox, and autocompact types; profile snapshot helpers; cached catalog result types.
- **Reuses**: Existing setup merge, target resolution, envelope, binding validation, and config diff behavior.

Config reads happen before planning through readConfigForSetup. The shared config helper resolves explicit and active profiles using the current rules. An absent active profile keeps the existing SetupUsageError. A first-run target with all roles skipped keeps agents: {} as the empty sentinel. Turning autocompact off writes enabled=false only when the target already has an autocompact block. An omitted orchestrator selection preserves the target's current value or its absence, so an otherwise untouched selection has an empty diff.

The planner does not produce binding validation results. Batch continues to validate only the winning --bind value for each role. Web apply compares each selected binding with the resolved target, then validates changed harness:model bindings against getBatchModels with allowNetwork:false. It does not validate effort-only changes. If a changed model is absent from that cached catalog, apply returns HTTP 422 unless the request includes offCatalogConfirmed[role]=true. The page sends that per-role confirmation only after an explicit user confirmation, matching the wizard's second Enter. An unchanged off-catalog binding does not block a sandbox or other unrelated change.

### Setup page and API

- **Purpose**: Show the current target and all wizard selections, produce a dry-run proposal, and save only a validated proposal.
- **Page location**: src/web/setup-page.ts
- **API location**: src/web/setup-routes.ts
- **Interfaces**:
  - SETUP_PAGE is a self-contained HTML string with inline CSS and injected setup page behavior.
  - createSetupRoutes(dependencies) returns the setup page, catalog, state, refresh, dry-run, and apply route definitions.
  - buildSetupState(configRead, profileOption) returns the resolved target and current values needed for prefill.
- **Dependencies**: readConfigForSetup, resolveSetupTarget, getBatchModels, separate binding validation, buildSetupPlan, and the config writer.
- **Reuses**: Existing setup config, profile, diff, validation codes, and SetupEnvelope.

GET /api/setup/state reads with readConfigForSetup and reports whether the resolved target is global or a named profile. It returns current bindings, per-role effort, orchestrator, sandbox, and autocompact values. Invalid config JSON returns code 14, and a config read error returns code 15. An active profile name without a snapshot returns the existing SetupUsageError with code 14 on apply. An explicit profile without a saved snapshot uses the current profile defaults.

GET /api/setup/catalog calls getBatchModels with allowNetwork:false and returns its models, status, source, ageMs, cacheWriteFailed, and discoveryError when present. The protected POST /api/setup/catalog/refresh calls getBatchModels with refresh:true, allowNetwork:true, and timeoutMs:12000. If discovery is incomplete or a requested harness reports an error, getBatchModels returns its refresh fallback and discoveryError without partial network results. A refresh can return unavailable without previously fresh cache entries because getBatchModels drops fresh entries from its refresh fallback; the page keeps its already loaded catalog and shows discoveryError in that case. Concurrent refresh requests share one in-flight promise.

Dry-run calls the planner and separate validator, then returns an object with the exact SetupEnvelope fields proposta, validacoes, mudancas, and resultado. It never writes config. Invalid JSON returns resultado.code=14 and a read error returns resultado.code=15. Apply uses the same proposal and validation steps, and writes only if the diff is non-empty and every changed binding validates. An empty diff returns unchanged without a write.

The route reads config through readConfigForSetup, never loadConfig. Dry-run and apply return resultado.code=14 for invalid JSON and resultado.code=15 for a read error, without writing. GET /api/setup/state returns the matching code in its JSON error. Malformed or oversized requests return HTTP 400. Binding validation failures return HTTP 422 with the existing code and saved=false. Save failures return HTTP 500 with saved=false. The setup API has one route factory, createSetupRoutes.

Setup selection, error rendering, and refresh state live in pure TypeScript page behavior functions. The HTML string injects those same function sources with Function.prototype.toString(). Node tests call the functions with fake fetch and timer adapters, then assert state changes and requests directly. Tests also extract the inline script from SETUP_PAGE and USAGE_PAGE, evaluate it in node:vm with a clean context plus stubbed fetch, timers, and document, then call the page functions from that context. This proves the injected code runs without module-scope dependencies. HTML substring checks may cover static markup but do not stand in for these behavior tests. A protected POST 403 changes setup page state to the reload/restart message from WEB-73.

### Usage query parameter builder

- **Purpose**: Produce identical UsageQueryParams for the CLI and the web API from the same options, working directory, and clock value.
- **Location**: src/core/usage-query.ts
- **Interfaces**:
  - buildUsageQueryParams(opts, cwd, now) returns UsageQueryParams.
- **Dependencies**: UsageQueryParams and UsagePeriod from src/daemon/protocol.ts.
- **Reuses**: The aggregate filter logic currently in src/cli/commands/usage.ts:175-211.

The CLI passes parsed options, process.cwd(), and the current date. The web handler converts its query string to the same option shape and passes its working directory and current date to the builder. The builder keeps the existing precedence: --all, --today, --days, then default today when since is absent. It maps 3, 7, and 30 to named periods, other positive day counts to a local-midnight since value, lets --current override --repo, and passes through since, until, model, and agent.

### Usage page and API

- **Purpose**: Return aggregate usage for browser filters and display results with all available breakdowns.
- **Page location**: src/web/usage-page.ts
- **API location**: src/web/usage-routes.ts
- **Interfaces**:
  - USAGE_PAGE is a self-contained HTML string with inline CSS and injected usage page behavior.
  - createUsageRoutes(dependencies) returns GET /usage and GET /api/usage handlers.
  - parseUsageWebQuery(searchParams, cwd) maps the URL fields to the option shape for buildUsageQueryParams.
- **Dependencies**: buildUsageQueryParams and injected fetchUsageQuery.
- **Reuses**: UsageQueryParams, UsageQueryResult, UsageTotals, and UsageMetricBucket from src/daemon/protocol.ts.

The endpoint returns the same UsageQueryResult as the aggregate CLI. Main already has the required byOrigin type at src/daemon/protocol.ts:220 from commit 80ec486 (#103). The page reads result.byOrigin ?? [] only because an older daemon process over IPC may omit the property.

The page has controls for period, repo, model, agent, since, and until. A change to any control re-queries with the current filter set. The selected --by value is the initial highlighted breakdown; the page keeps every breakdown section accessible. It shows every UsageTotals field and the byDay, byRepository, byModel, byAgent, byRun, and when present byOrigin arrays.

The page behavior functions own query state, filter changes, polling, render data, and error state. The HTML injects the same function source that Node tests import and call with fake fetch, timers, and render callbacks. Tests assert re-query-on-change, interval normalization, polling, origin-present and origin-absent results, and retention of the last good result after a failed query.

Polling uses Math.max(1, Number(opts.interval) || 2). Commander supplies the default string "2", so the implementation cannot distinguish an omitted option from explicit --interval 2. Zero and NaN resolve to 2 seconds; negative values and positive values below 1 resolve to 1 second. For aggregate --web calls, the page refreshes itself; --watch does not select terminal rendering. A positional run ID or --run stays on usage.get and starts no server even with --web. --backfill also runs before web startup. --observe and --json retain their current single-run behavior.

### CLI wiring

- **Purpose**: Select the matching command path and preserve existing non-web contracts.
- **Locations**: src/cli/commands/ui.ts, src/cli/commands/review.ts, src/cli/commands/setup.ts, src/cli/commands/usage.ts, and src/cli/index.ts
- **Interfaces**:
  - codedeck ui starts the home route table.
  - codedeck review keeps /, /review, and GET /api/review.
  - Interactive codedeck setup with a TTY opens /setup unless --tui selects the frozen wizard. Without both TTYs, no-batch setup keeps its current exit code 1 and terminal message.
  - Setup batch flags continue to call runSetupBatch with their current output and status contracts.
  - Aggregate codedeck usage opens /usage only with --web.
  - When --backfill is absent, positional or --run usage IDs keep usage.get and do not start the server, including usage <id> --web --json. --by origin remains aggregate-only.
- **Dependencies**: Shared server, route factories, page constants, query builder, and existing CLI parser.
- **Reuses**: Existing Commander registrations and branches.

## Data models

### Setup selection

~~~typescript
interface SetupSelection {
  agents: Partial<Record<Role, RoleBinding>>
  orchestrator?: OrchestratorMode
  sandbox?: RunAgentConfig["defaultSandbox"]
  autocompact?: RunAgentConfig["autocompact"]
  offCatalogConfirmed?: Partial<Record<Role, boolean>>
}
~~~

Missing role entries mean the user skipped that role. An omitted orchestrator preserves its current value or absence. offCatalogConfirmed records explicit per-role confirmation for changed models absent from the cached catalog. A profile name is supplied by CLI target resolution and is never accepted from the browser request body. A first-run config with no selected roles retains the agents: {} sentinel.

### Setup plan

~~~typescript
interface SetupPlanResult {
  proposedConfig: RunAgentConfig
  diff: SetupDiff
}
~~~

The current config input is RunAgentConfig. Catalog validation and SetupConfigRead are not planner inputs. The CLI route adapts the result, separate validation result, and config status into the existing SetupEnvelope fields.

### Usage result

The route returns UsageQueryResult. The type in main requires byOrigin and contains UsageMetricBucket[]. At runtime, the page treats an absent field as an empty origin breakdown only for an older daemon process.

## Error handling strategy

| Error scenario | Handling | User impact |
| --- | --- | --- |
| Host, token, or Origin rejected | Return HTTP 403 before route handler invocation. | No protected action runs. |
| Stale session after server restart | Return HTTP 403; page shows the reload/restart message. | The user opens the new token URL if reload does not restore the session. |
| Invalid port or listen failure | Print the error and exit with code 1. | The command does not claim that a server is available. |
| Malformed or oversized setup body | Return HTTP 400 and do not write config. | The user can correct or retry the request. |
| Invalid setup config JSON | Return code 14 and do not write. | Existing invalid config remains available for repair. |
| Setup config read error | Return code 15 and do not write. | The user sees the original read error. |
| Changed binding validation fails | Return HTTP 422 with the existing validation code and saved=false. | The page can identify the changed binding that failed. |
| Config save fails | Return HTTP 500 with saved=false and the existing save error. | The server does not report that the proposal was saved. |
| Catalog discovery is incomplete or errors | Return getBatchModels fallback and discoveryError, without partial network results. | The page shows the actual cache or unavailable state. |
| Usage query fails | Return HTTP 500 with JSON error; preserve the last successful page result. | A later poll or filter change can recover. |

## Risks & concerns

| Concern | Location (file:line) | Impact | Mitigation |
| --- | --- | --- | --- |
| The review command combines server lifecycle, routing, port parsing, and browser opening. | src/cli/commands/review.ts:7-135 | A careless extraction can change the current review behavior. | Keep review route and command tests in the rewiring task. |
| Setup selection and persistence live in a long wizard command. | src/cli/commands/setup.ts:625-801 | Duplicated planning could change profiles, skips, or config merge behavior. | Extract one pure planner and test it against current setup behavior. |
| loadConfig swallows read and parse errors. | src/config/config.ts:531-540 | Web apply could treat invalid config as defaults and overwrite it. | Use readConfigForSetup and test codes 14 and 15 before any write. |
| The current review handler calls process.exit during shutdown. | src/cli/commands/review.ts:128-131 | Signal handling is hard to assert and can terminate a test runner. | Inject close and exit functions into the shared server. |
| Model discovery can return incomplete results after network errors. | src/core/models.ts:329-389 | A UI that displays partial provider data would imply a complete catalog. | Use getBatchModels only and render its fallback plus discoveryError. |
| UsageQueryResult in main requires byOrigin, but an older daemon process can answer IPC without the field. | src/daemon/protocol.ts:208-221; commit 80ec486 (#103) | Direct access can crash page rendering against an older process. | Keep the type required and use a runtime fallback only for that daemon response. |
| Page behavior currently has no DOM test dependency. | tests/review.test.ts, tests/setup-wizard.test.ts | Static markup checks cannot prove polling or state transitions. | Test exported pure page functions with fake fetch and timers in Node. |

## Tech decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Home command | codedeck ui | It gives the route table a dedicated entry and keeps review at its current root. |
| Home links | Build from registered page routes. | P1 must not advertise a page that is not registered until its phase is complete. |
| Shared port | Default 3100; user values 1 through 65535; test seam may bind port 0. | This preserves review behavior while allowing ephemeral integration-test ports. |
| Bound port | Read server.address().port after listen, then create security with that value. | Host checks and cookie names must use the actual bound port. |
| Shutdown | Inject close and exit functions; close before exit. | Signal tests can assert both operations without terminating Vitest. |
| Token | 32 cryptographically random bytes, sent only in the initial URL query. | The page does not need to embed the token in HTML or JavaScript. |
| Token cookie | codedeck_ui_token_<port>, host-only, HttpOnly, SameSite=Strict, Path=/. | Cookie storage does not isolate by port, so each server port gets a distinct name. |
| Token bootstrap | On valid token HTML GET, set the cookie and return HTTP 303 to the same route without t. | This removes the token from the visible URL after establishing the session. |
| Action security | Host-check every route; require cookie and matching HTTP Origin on every POST. | Read routes remain locally constrained and all mutating routes share one rule. |
| HTML framing | Add Content-Security-Policy: frame-ancestors 'none' to every HTML response. | Local pages should not be embedded by another origin. |
| Catalog source | Use getBatchModels for both GET and refresh. | One helper defines cache, discovery timeout, incomplete-result, and fallback behavior. |
| Setup apply catalog | Call getBatchModels with allowNetwork:false when validating changed bindings. | Apply checks the cache and does not start discovery. |
| Planner boundary | Accept RunAgentConfig and selections; return proposed config and diff only. | Validation depends on the selected catalog and belongs in separate callers. |
| Validation | Web validates changed harness:model pairs against the cached catalog with allowNetwork:false and requires per-role confirmation for off-catalog models; batch validates winning --bind entries; wizard adds no catalog validation. | This keeps web apply offline, preserves explicit user choice, and leaves existing wizard behavior intact. |
| Page tests | Export behavior functions from the page module and inject their source into HTML. | Node tests call the functions directly and run extracted inline scripts in node:vm without a DOM package. |
| Usage query params | Extract buildUsageQueryParams into src/core/usage-query.ts and call it from CLI and web. | A pure shared function makes filter mapping and parity testable. |
| Usage origin | Use the required byOrigin type already present in main at 80ec486 (#103); handle a missing runtime field only from an older daemon process. | Current callers use the complete type while IPC remains compatible with an earlier running daemon. |
| Aggregate usage --json | With --web, open /usage and print the token URL; retain JSON for aggregate calls without --web and for single-run calls. | The web option selects the aggregate interface while run-id callers retain their exact JSON path. |
| Usage --by | Use --by as the initially highlighted breakdown and keep all sections accessible. | The browser can show other metrics without discarding the CLI preference. |
| Usage polling | Use Math.max(1, Number(opts.interval) || 2); --watch does not select terminal output with --web. | This retains the current CLI normalization and default string behavior. |
| Setup --refresh | Open /setup and start a protected catalog refresh on page load. | It retains the existing flag without adding a discovery job API. |
| Setup --json with --port | Reject before starting a web server. | --json selects the batch interface and --port selects the web interface. |
| Setup batch flags with --port | Reject --dry-run and --non-interactive with --port before starting a server. | Both flags select the batch path. |
| Usage --web with --tui | Return a usage error before starting a web server. | One invocation cannot select the browser and terminal dashboard together. |
| Setup request size | Limit JSON bodies to 64 KiB. | The complete role selection is bounded and parseable before planning. |
| Setup HTTP status | Use 400 for malformed input, 422 for validation failures, and 500 for save failures. | Browser callers receive stable transport statuses while resultado.code retains CLI codes. |

## Phase dependencies

| Phase | Scope | Depends on |
| --- | --- | --- |
| P1 | Shared server, review compatibility, home page, and codedeck ui | None |
| P2 | Host, token, Origin, CSP, and server guard | P1 |
| P3 | Pure setup planner and wizard reuse | P2 |
| P4 | Setup page, routes, command wiring, and README update | P3 |
| P5 | Usage page, routes, command wiring, and query parity | P4 |

These artifacts stop at planning. They do not authorize source, test, plugin, or README changes during this documentation correction.
