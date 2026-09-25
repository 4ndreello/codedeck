# Web setup roster

## Goal

Rebuild `/setup` around direct editing: one row per role that you change in place, a comparison table for the
orchestrator policy, and a review drawer that shows the server's dry run before anything is written. Replaces the
Keep current / Change toggle, the native datalist, the preview button, and the native `confirm()` dialog from
`web-setup-redesign`. Mocks: roster layout (A) with the Compare policy (C).

## Out of scope

- Changes to the setup API routes, request bodies, or the envelope and its Portuguese keys.
- Changes to `buildSetupSelection` semantics, `src/config/*`, or the CLI `codedeck setup` flow.
- Changes to `/usage`, Home, Review, or the web server.
- New runtime dependencies. The page stays one server-rendered string with inline CSS, SVG, and script.

## Requirements

### R1. Chrome and assets

- R1.1 The page SHALL keep `BRAND_CSS`, `LOGO_FAVICON_HREF`, and `renderTopBar` with Setup active, and the
  setup-only navigation default when no page list is supplied.
- R1.2 The page SHALL embed one inline SVG sprite with a logo for each harness in `AGENT_IDS` and the line icons
  the page uses. Every use of an icon SHALL reference the sprite with `<use>`.
- R1.3 The header SHALL show the config path from `/api/setup/state` and the catalog status with a refresh button.

### R2. Role rows

- R2.1 The page SHALL render one row per role with its name, a one-line description, a model button, an effort
  meter, and a state cell.
- R2.2 The model button SHALL show the harness logo, the harness id, and the model id in monospace. An unbound role
  SHALL show `Choose a model`.
- R2.3 WHEN the model button is activated THEN a picker SHALL open with a search field and the catalog models
  grouped by harness. The saved model SHALL be tagged `saved` and the draft model SHALL be checked.
- R2.4 WHEN a harness is unavailable THEN its picker group SHALL say so and offer no models.
- R2.5 WHEN the search text is `harness:model` for a known harness and the model is not in its catalog THEN the
  picker SHALL offer to use it, tagged as not in the catalog.
- R2.6 The picker SHALL support ArrowUp, ArrowDown, Enter, and Escape. Escape SHALL return focus to the button.
- R2.7 The effort meter SHALL offer the five `REASONING_EFFORTS` levels. WHEN the catalog lists
  `reasoningEfforts` for the draft model THEN levels outside that list SHALL be disabled.
- R2.8 WHEN the draft harness is `opencode` THEN the meter SHALL be replaced by text saying opencode sets its own
  effort.
- R2.9 WHEN a role's draft differs from its saved binding or effort THEN its row SHALL be marked changed and its
  state cell SHALL show the saved value and an Undo action that restores it.

### R3. Orchestrator policy

- R3.1 The policy SHALL render as a table whose columns are the presets and Custom, and whose rows are
  investigate, self work, and tools. Each cell SHALL show an icon and a label.
- R3.2 Each column header SHALL carry a glyph drawn from that column's three values.
- R3.3 Activating a preset header SHALL set the draft policy to that preset. The Custom column cells SHALL offer
  the three values of their row and SHALL switch the policy to custom.
- R3.4 The active column SHALL be highlighted by one element that moves between columns with a transition.
- R3.5 The Custom picks SHALL move their selection with a transition, and changed labels SHALL animate in.
- R3.6 A parallel workers field SHALL say the value is guidance in the orchestrator prompt and that blank means no
  limit.
- R3.7 WHEN no policy is saved and none is chosen THEN no column SHALL be active.

### R4. Runtime settings

- R4.1 Sandbox SHALL be a two-option control with icons whose selection moves with a transition. Full access SHALL
  show a warning sentence.
- R4.2 Autocompact SHALL be a switch.
- R4.3 WHEN a setting has no saved value and is untouched THEN it SHALL be sent as unchanged.

### R5. Save flow

- R5.1 A sticky bar SHALL show the number of unsaved changes and their names, a Discard action, and a Review and
  save action. Both actions SHALL be disabled when nothing changed or while loading or saving.
- R5.2 Review and save SHALL open a drawer and request `/api/setup/dry-run` with the current selection.
- R5.3 The drawer SHALL render one row per change from `mudancas`, a line diff of the keys Setup manages built
  from `proposta`, and the config, catalog, and binding validations.
- R5.4 WHEN a changed binding is not in an available harness catalog THEN the drawer SHALL show a per-role
  confirmation checkbox, and saving SHALL stay disabled until each one is checked.
- R5.5 Saving SHALL request `/api/setup/apply` with `offCatalogConfirmed` for the confirmed roles.
- R5.6 WHEN apply returns `applied` THEN the drawer SHALL close, a toast SHALL confirm the save, and the page SHALL
  reload the saved state so no row stays marked changed.
- R5.7 WHEN a request fails THEN the drawer SHALL show the error. A 403 SHALL show the expired-session message.
- R5.8 Values inserted with `innerHTML` SHALL be escaped. Legacy `profiles` and `activeProfile` SHALL NOT appear
  outside the collapsed raw response.

### R6. Motion and layout

- R6.1 The drawer and scrim SHALL slide and fade. The picker SHALL fade in.
- R6.2 Under `prefers-reduced-motion: reduce`, transitions and animations SHALL be disabled.
- R6.3 At 390px the rows SHALL stack, the policy table SHALL scroll inside its own container, and
  `document.documentElement.scrollWidth` SHALL be no greater than 390.

### R7. Preserved behavior

- R7.1 `buildSetupSelection` SHALL keep its semantics and signature.
- R7.2 The controller SHALL keep `state`, `start`, `refreshCatalog`, `buildSelection`, `dryRun`, and `apply`.
- R7.3 Setup API paths, methods, and body shapes SHALL stay unchanged.
