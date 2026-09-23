# Web usage redesign

## Goal

Replace the current `/usage` page of `codedeck ui` with the approved "mock D" design: a black + blue analytics
dashboard in the Cloudflare/Vercel language, with masked numbers, charts and working controls. Introduce the
CodeDeck brand (edge-on deck logo, palette) as a shared web module so later pages can reuse it.

The approved visual reference was a static mock ("mock D") built from real local usage data. It is kept out of
the repository because that data names private repositories. Where the mock and this spec disagree, this spec
wins. The known mock defects are listed under R9 and must not ship.

## Out of scope

- Restyling Home, Setup and Review pages (a follow-up feature reuses the brand module).
- A sessions endpoint and the "Recent sessions" widget from the mock (dropped: the usage API has no sessions).
- Fixing the repository grouping that reports worktree/cwd basenames (`e174`, `.claude`, `dev`) as repositories.
- Changes to the daemon, the usage query, the store, or `/api/usage` response shape.
- New runtime dependencies. The page stays a self-contained server-rendered string with inline CSS, SVG and script.

## Brand (source of truth for tokens)

- Colors: `--bg #000000`, `--surface #0a0a0a`, `--surface-hover #111111`, `--surface-raised #161616`,
  `--border #1f1f1f`, `--border-strong #2e2e2e`, `--grid #1a1a1a`, `--text #ededed`, `--text-muted #a1a1a1`,
  `--text-faint #6b6b6b`, `--blue #0070f3`, `--blue-chart #3b82f6`, categorical ramp
  `#3b82f6 #93c5fd #1d4ed8 #60a5fa #bfdbfe #1e3a8a`, other `#737373 #404040`, success `#10b981`, error `#e5484d`.
- Type: sans `"Geist", "Inter", ui-sans-serif, system-ui, sans-serif`; mono `"Geist Mono", ui-monospace, "JetBrains Mono", monospace`.
- Logo "edge-on deck" (viewBox 0 0 64 64):
  cards `m13 25 34-8 6 4-34 8zM13 32l34-8 6 4-34 8zM13 39l34-8 6 4-34 8zM13 46l34-8 6 4-34 8z` fill `#000`, stroke `#ededed`;
  top card `m13 25 34-8 6 4-34 8z` fill and stroke `#0070f3`. Stroke width scales up as size drops
  (about 2.2 at 64px, 5 at 20px, 6 at 16px). Wordmark: lowercase `codedeck`, sans 600.

## Requirements

### R1. Page loads data in a real browser

- R1.1 WHEN the usage page script runs in a browser THEN it SHALL call `fetch`, `setInterval` and `clearInterval`
  with the global object as receiver, so a native `fetch` never throws "Illegal invocation".
- R1.2 WHEN `/usage` is opened in headless Chromium against a running `codedeck ui` THEN the console SHALL log no
  uncaught error and the page SHALL show the totals of the default range.

### R2. Brand and chrome

- R2.1 The page SHALL render a 52px top bar with the edge-on deck logo, the `codedeck` wordmark, the page name and
  quiet nav links to every page registered in the route table, with Usage marked active.
- R2.2 The page SHALL declare the edge-on deck logo as its favicon (inline data URI), replacing `data:,`.
- R2.3 The palette and type tokens above SHALL live in one shared web module that exports the CSS custom
  properties, the logo SVG (sized) and the top bar renderer, and the usage page SHALL consume them from there.
- R2.4 The page SHALL render exactly one range picker.

### R3. Number masks

- R3.1 Token and count values ≥ 1,000,000,000 SHALL render as `1.19B`, ≥ 1,000,000 as `16.8M`, ≥ 10,000 as `842K`;
  smaller counts SHALL render with thousands separators (`2,427`).
- R3.2 Currency SHALL render as `$1,865.42` (two decimals, thousands separators); axis ticks SHALL use at most two decimals.
- R3.3 Percentages SHALL render with one decimal (`47.8%`) and name the base they are a share of ("of spend", "of sessions").
- R3.4 Every masked value SHALL carry its unmasked value in a `title` attribute.
- R3.5 WHEN `costComplete` is false THEN the cost SHALL render as `≥ $X` next to a neutral pill "`N` unpriced" using
  `sessionsWithoutCost`; a bare trailing `?` SHALL NOT appear anywhere on the page.

### R4. Range, filters and refresh

- R4.1 The range picker SHALL offer Today, Last 3 days, Last 7 days, Last 30 days, All time and Custom; Custom SHALL
  reveal since/until date inputs. Changing it SHALL re-query `/api/usage` with the same parameters the page accepts today.
- R4.2 "Add filter" SHALL open a menu to add a repository, model or agent filter; an applied filter SHALL render as a
  removable chip, and adding or removing a chip SHALL re-query with that filter.
- R4.3 WHILE Live refresh is on the page SHALL poll at the configured interval; WHEN it is toggled off THEN polling SHALL stop.
- R4.4 A background poll SHALL NOT replace rendered content with a loading state; a loading indicator SHALL appear only
  for the first load and for user-initiated changes.
- R4.5 IF a query fails THEN the page SHALL keep the last good data visible and show the error in a dismissible banner.
- R4.6 WHEN `/usage` is opened with `period`, `repo`, `model`, `agent`, `since`, `until` or `by` in its query string THEN
  the page SHALL start with those values.
- R4.7 WHEN the range, a filter or the breakdown tab changes THEN the page SHALL update its URL query with
  `history.replaceState` so "Copy link" copies a URL that reopens the same view.

### R5. KPI row

- R5.1 The page SHALL show four KPI cards: Spend, Sessions, Total tokens, Cache hit rate (cached / (input + cached)),
  each with a sparkline from `byDay` bleeding to the card's bottom edge.
- R5.2 WHEN the range is 3d, 7d or 30d THEN each KPI SHALL show a delta arrow and percentage versus the immediately
  preceding window of equal length, labeled "vs previous 7d" (or 3d/30d), from a second `/api/usage` query with
  explicit since/until.
- R5.3 WHEN the range is Today, All time or Custom, or the previous window has zero for that metric, THEN the delta SHALL be hidden.

### R6. Charts

- R6.1 "Spend over time" SHALL plot `byDay` as a line with area fill and dashed grid, with a legend switch between
  Spend, Tokens and Sessions, and a crosshair tooltip showing date and masked value.
- R6.2 "Spend by model" SHALL be a donut of `byModel.costUsd` with the top 6 models plus one "Other" slice, its center
  showing the masked total spend, and a legend with model id (mono), value and share of spend.
- R6.3 "Spend by repository" SHALL list `byRepository` by cost descending with a thin blue bar scaled to the top row,
  scrolling inside its card.
- R6.4 "Sessions by outcome" SHALL show completed, failed, active and other (sessions minus the three) as one
  segmented bar with counts and share of sessions; failed SHALL use the error color.
- R6.5 "Harness" SHALL show, per `byAgent` key, share of spend and share of sessions, both labeled, each on one line at 1440px.
- R6.6 "Origin" SHALL show worker vs orchestrator share of sessions and of spend, both labeled.
- R6.7 Every chart segment or point SHALL have a hover tooltip; SVG text SHALL never be stretched
  (no `preserveAspectRatio="none"` on any SVG containing text) and charts SHALL re-render on resize.
- R6.8 WHEN a breakdown or series is empty THEN its card SHALL show "No usage in this range" instead of an empty chart.

### R7. Breakdown table

- R7.1 Tabs Day, Repository, Model, Agent, Run, Origin SHALL switch the table rows to the selected breakdown, and only
  the selected breakdown SHALL be visible.
- R7.2 Clicking a column header SHALL sort by that column, toggling ascending/descending.
- R7.3 The table SHALL show the top 10 rows and a "Show all N" toggle when there are more.
- R7.4 A search input SHALL filter the visible rows by label; pressing `/` outside an input SHALL focus it.
- R7.5 Columns SHALL be Name, Sessions, Spend, Tokens, Share of spend (thin bar left-aligned in its own column).

### R8. Layout

- R8.1 At 1440px wide the layout SHALL follow the mock order: header, filter bar, KPI row (4), spend over time,
  model + repository row, outcome + harness + origin row, breakdown.
- R8.2 At 390px wide the page SHALL have no page-level horizontal scroll (`document.documentElement.scrollWidth <= 390`),
  cards SHALL stack in one column, and axis labels SHALL render at 10px or larger.
- R8.3 Cards in the same row SHALL size to content without leaving a region taller than 120px empty.

### R9. Mock defects that must not ship

- R9.1 No native control SHALL render with a light/white background (profile or range selects included).
- R9.2 The donut center SHALL show total spend as currency, never a token/count abbreviation.
- R9.3 No duplicated control (range picker, refresh) SHALL appear.
