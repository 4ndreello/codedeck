# Web setup redesign

## Goal

Redesign `/setup` as a clear setup dashboard that uses the CodeDeck brand and the visual language of `/usage`.
The page must make current settings readable, explain edits as human changes, and preserve the setup controller and
API behavior.

## Out of scope

- Changes to the setup API envelope or its Portuguese keys.
- Changes to CLI `codedeck setup`, `src/config/*`, or `src/cli/*` except the `/setup` route wiring in `ui.ts`.
- Changes to `/usage`, Home, Review, or the web server.
- Removal or migration of legacy `profiles` data from a user's config.
- New runtime dependencies. The page remains one server-rendered string with inline CSS, SVG, and script.

## Requirements

### R1. Brand and chrome

- R1.1 The setup page SHALL include `BRAND_CSS` from `src/web/brand.ts`.
- R1.2 The setup page SHALL use `LOGO_FAVICON_HREF` as its favicon.
- R1.3 The setup page SHALL render its top bar with `renderTopBar` from `src/web/brand.ts`.
- R1.4 The top bar SHALL mark Setup as the active page.
- R1.5 The top bar SHALL link to every page registered with the UI route table, including Home, Review, Setup, and Usage.
- R1.6 WHEN `/setup` is rendered without options THEN the exported `SETUP_PAGE` constant SHALL remain usable by existing callers.
- R1.7 The `/setup` route SHALL pass the registered pages to `renderSetupPage`.
- R1.8 Cards, buttons, pills, inputs, and selects SHALL use the `/usage` palette and control styling.
- R1.9 Model identifiers SHALL use a monospace font.
- R1.10 No native control SHALL render with a light background.
- R1.11 WHEN the setup page is rendered without a supplied page list THEN its navigation SHALL contain only Setup.
- R1.12 WHEN the setup page is rendered without a supplied page list THEN its brand link SHALL target `/setup`.

### R2. Current state

- R2.1 Each role card SHALL show a current binding as a harness pill, model identifier, and effort value.
- R2.2 WHEN a role has no current binding THEN its card SHALL show `not set` as the current binding.
- R2.3 The current orchestrator SHALL show a matching `ORCHESTRATOR_PRESETS` preset name when it matches a preset.
- R2.4 WHEN the current orchestrator matches no preset THEN it SHALL show `custom` and readable field values.
- R2.5 Current orchestrator values SHALL NOT be rendered as JSON.
- R2.6 Current sandbox state SHALL use words instead of JSON.
- R2.7 Current autocompact state SHALL use words instead of JSON.
- R2.8 Current sandbox state SHALL show the literal configuration value in monospace.

### R3. Role editing

- R3.1 Each role card SHALL offer explicit `Keep current` and `Change` choices.
- R3.2 The role choice SHALL retain the `skip-<role>` checkbox ID and checked semantics.
- R3.3 WHEN the selected role binding uses the `opencode` harness THEN its effort select SHALL be hidden.
- R3.4 Each role SHALL start with its `skip-<role>` checkbox checked, including unbound roles.
- R3.5 WHEN a role is set to Keep current THEN its binding and effort controls SHALL be hidden.
- R3.6 WHEN a role is set to Change THEN its binding and effort controls SHALL be shown and prefilled from current state.
- R3.7 WHEN a current role's effort is the only edited field THEN its selection SHALL preserve the current harness and model.
- R3.8 WHEN a role has no current effort THEN its effort select SHALL default to Keep current.
- R3.9 Each role card SHALL show its title in a normal header inside the card.

### R4. Preview and result

- R4.1 WHEN a dry run or apply response contains `mudancas` THEN the page SHALL render one row for each change.
- R4.2 Each change row SHALL format paths such as `/agents/reviewer/effort` as `reviewer · effort`.
- R4.3 Each change row SHALL show the before value, an arrow, and the after value when both values are present.
- R4.4 WHEN `beforePresent` is false THEN the change row SHALL label the change as added.
- R4.5 WHEN `afterPresent` is false THEN the change row SHALL label the change as removed.
- R4.6 WHEN `mudancas` is empty THEN the preview SHALL say `No changes`.
- R4.7 A dry-run result SHALL show the status `Preview only, nothing written`.
- R4.8 An applied result SHALL show the status `Saved`.
- R4.9 An unchanged result SHALL show the unchanged status and any supplied message.
- R4.10 An error result SHALL show the error status and its supplied message.
- R4.11 The config, catalog, and binding validations SHALL render as compact status pills or rows.
- R4.12 A validation message SHALL render only when the response supplies one.
- R4.13 The default preview SHALL NOT print the complete proposed config.
- R4.14 The default preview SHALL NOT print legacy `profiles` or `activeProfile` values.
- R4.15 The full raw response MAY be available inside a collapsed `details` element named `Raw response`.
- R4.16 Values inserted into the preview with `innerHTML` SHALL be HTML-escaped.
- R4.17 Each change row SHALL group the before value, arrow, and after value together after its friendly path.

### R5. Actions

- R5.1 Preview and Apply SHALL appear in one action bar.
- R5.2 Apply SHALL be the primary blue action.
- R5.3 Preview and Apply SHALL be disabled while a request is in flight.
- R5.4 Preview and Apply SHALL be disabled until setup state is loaded.
- R5.5 The action bar SHALL stick to the viewport bottom and show selection, loading, in-flight, or error status on its left.
- R5.6 The sticky action bar SHALL NOT cover the last page content at 390px.

### R6. Layout

- R6.1 At 1440px, role cards SHALL use a four-column grid or a two-by-two grid when space is constrained.
- R6.2 At 390px, role cards SHALL stack in one column.
- R6.3 At 390px, `document.documentElement.scrollWidth` SHALL be no greater than 390.

### R7. Preserved behavior

- R7.1 `buildSetupSelection` SHALL retain its current selection semantics.
- R7.2 The setup controller SHALL retain its public `start`, `refreshCatalog`, `buildSelection`, `dryRun`, and `apply` methods.
- R7.3 Every existing element ID used by the controller SHALL remain in the rendered page.
- R7.4 Every existing element ID used by setup tests SHALL remain in the rendered page unless the test only asserts obsolete copy.
- R7.5 The off-catalog apply confirmation SHALL remain per role.
- R7.6 A protected action that returns 403 SHALL show the existing expired-session message.
- R7.7 Setup API request paths, methods, and body shapes SHALL remain unchanged.
- R7.8 Existing tests SHALL continue to pass, except markup-only assertions may change to match the new copy.
