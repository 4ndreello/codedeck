# Web usage redesign: tasks

Source of truth: `spec.md` in this folder. The visual reference mock is local only (see `spec.md`).

## Design notes

- Keep the current architecture: `renderUsagePage` returns a self-contained HTML string; browser behavior is shipped
  by serializing named functions with `Function.prototype.toString` into the inline script. Every function the
  browser calls must be in that list and must not reference module imports or closures outside itself.
- Chart and formatting code are pure functions that return strings or plain data (for example `formatCompact`,
  `formatUsd`, `formatShare`, `previousWindow`, `computeDelta`, `donutSlices`, `renderDonutSvg`,
  `renderLineChartSvg`, `renderSparklineSvg`). DOM code only inserts their output. This keeps them unit-testable
  under vitest's node environment without a DOM library.
- `src/web/brand.ts` owns tokens, logo and top bar. It is server-side only (it renders strings into the page).
- The nav in the top bar comes from the route table: `createUiRoutes` already computes `pages`; pass them to the
  usage page through `UsageRoutesOptions.page`.
- Default range stays `today` (current behavior and existing tests).

## Coverage matrix

| Layer | Test type | Location | Command |
| --- | --- | --- | --- |
| Brand module `src/web/brand.ts` | unit | `tests/web-brand.test.ts` | `npx vitest run tests/web-brand.test.ts` |
| Usage pure logic (formatters, deltas, previous window, donut slices, SVG builders, controller) | unit | `tests/usage-page.test.ts` | `npx vitest run tests/usage-page.test.ts` |
| Usage inline script (serialized functions run, receiver binding) | unit via `node:vm` | `tests/usage-page.test.ts` | same as above |
| Route wiring (nav passed to usage page) | unit | `tests/usage-web.test.ts`, `tests/web-cli.test.ts` | `npx vitest run tests/usage-web.test.ts tests/web-cli.test.ts` |
| Rendered page in a real browser (R1.2, R8, R9) | manual e2e gate | none committed; evidence is screenshots + console log | T3 commands |

## T1. Brand module

- Requirement: R2.2, R2.3.
- Files: new `src/web/brand.ts`, new `tests/web-brand.test.ts`.
- Produces: `BRAND_CSS` (custom properties + base resets for black surfaces, native controls styled dark per R9.1),
  `renderLogoSvg(size: 16 | 20 | 64)`, `LOGO_FAVICON_HREF` (data URI), `renderTopBar({ pages, activePath, title })`
  with escaped labels.
- Tests: tokens present with exact hex values; logo contains both path data strings and the blue top card; stroke
  width grows as size drops; favicon is a `data:image/svg+xml` URI; top bar lists every page, marks the active one
  with `aria-current="page"`, escapes HTML in labels.
- Gate: `npx vitest run tests/web-brand.test.ts` passes; `npx tsc --noEmit` clean.

## T2. Usage page redesign

- Requirement: R1.1, R2.1, R2.4, R3.*, R4.*, R5.*, R6.*, R7.*, R8.1, R9.*.
- Files: `src/web/usage-page.ts`, `src/web/usage-routes.ts`, `src/cli/commands/ui.ts`, `tests/usage-page.test.ts`,
  `tests/usage-web.test.ts`, `tests/web-cli.test.ts` (only if the wiring assertion belongs there).
- Tests (ship with the code):
  - R1.1: in `node:vm`, run the page script with a `fetch`/`setInterval`/`clearInterval` that throw
    `TypeError("Illegal invocation")` when `this` is not the context global; start the page with a minimal fake DOM
    or call the environment wiring the script uses, and assert no throw and one fetch.
  - R3.*: table-driven cases for `formatCompact` (999, 10_000, 842_310, 16_756_717, 1_193_095_059), `formatUsd`
    (1865.421706 → `$1,865.42`), share formatting, incomplete-cost rendering (`≥` + unpriced pill, no bare `?`).
  - R5.2/R5.3: `previousWindow` for 3d/7d/30d returns an equal-length window ending where the current begins;
    `computeDelta` hides on zero base and for today/all/custom.
  - R6.2/R9.2: `donutSlices` returns top 6 + Other summing to the total; donut center renders currency.
  - R6.7: no SVG builder output that contains `<text` also contains `preserveAspectRatio="none"`.
  - R6.8: empty buckets render "No usage in this range".
  - R7.*: controller or pure table helpers: tab switch selects only that breakdown, sort toggles, top 10 + show all, search filter.
  - R4.3/R4.4: toggling live refresh off clears the interval; a poll-triggered refresh does not set the loading flag.
  - R2.1/R2.4: rendered HTML contains the top bar with Usage active, the favicon, exactly one range picker.
  - R4.6: the `/usage` route passes query values into the page options (test in `tests/usage-web.test.ts`).
  - R4.7: a pure `buildUsagePageSearch(state)` returns the query string the page writes; the controller calls the
    injected `replaceUrl` on range, filter and tab changes.
  - Update existing assertions that pinned the old markup; keep the behavior they protected (filters, re-query, error keeps last result).
- Gate: `npx vitest run tests/usage-page.test.ts tests/usage-web.test.ts tests/web-cli.test.ts tests/web-brand.test.ts tests/ui-render.test.ts` passes; `npx tsc --noEmit` clean; `npm run build` succeeds.

## T3. Browser gate

- Requirement: R1.2, R8.2, R8.3, R9.1, R9.3.
- Commands (after `npm run build`):
  1. `node dist/cli/index.js ui --no-open --port 3141` (prints a URL with `?t=<token>`).
  2. `chromium --headless=new --disable-gpu --hide-scrollbars --window-size=1440,2600 --virtual-time-budget=5000 --screenshot=<scratch>/usage-1440.png "<url>/usage?t=<token>&period=7d"`.
  3. Same at `--window-size=390,4200` → `usage-390.png`.
  4. `chromium --headless=new --disable-gpu --enable-logging=stderr --v=0 --virtual-time-budget=5000 --dump-dom "<url>" 2>&1 | grep -i -e uncaught -e "illegal invocation"` → empty.
  5. Stop the server.
- Tests: none (manual gate per the matrix).
- Gate: screenshots show real data with masked numbers and no white controls; no console errors; no page-level horizontal scroll at 390px.
