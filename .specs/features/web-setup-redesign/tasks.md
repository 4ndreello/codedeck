# Web setup redesign: tasks

Source of truth: `spec.md` in this folder.

## Design notes

- Keep `renderSetupPage(options)` as a self-contained HTML string. Export `SETUP_PAGE = renderSetupPage()` for
  callers that need the default markup.
- Reuse `BRAND_CSS`, `LOGO_FAVICON_HREF`, and `renderTopBar`; copy only the setup-specific CSS into this page.
- Keep `buildSetupSelection` and the controller's public methods and request shapes unchanged.
- Browser-time helpers used by the controller must live inside `createSetupPageController`, because that function
  is serialized into the page's inline script.
- Escape every dynamic value inserted into `innerHTML`, including preview fields and raw response content.
- Render a concise default preview from `resultado`, `mudancas`, and `validacoes`. Keep the full response behind
  a collapsed disclosure if it is retained.
- Preserve the existing element IDs, including `skip-<role>`, even when their labels and styles change.

## T1. Specify the redesign

- Requirement: R1-R7.
- Files: `.specs/features/web-setup-redesign/spec.md`, `.specs/features/web-setup-redesign/tasks.md`.
- Produce one acceptance criterion per observable behavior and a coverage matrix at the end of this file.

## T2. Render the branded setup page

- Requirement: R1-R3, R6.
- Files: `src/web/setup-page.ts`, `src/web/setup-routes.ts`.
- Render the shared brand chrome and dark usage-style controls. Add `renderSetupPage(options)` and preserve the
  `SETUP_PAGE` export. Pass registered pages from the UI route handler, and use a setup-only navigation default for
  the standalone setup server.
- Show role bindings, effort, orchestrator preset or readable custom fields, sandbox, and autocompact as human text.
- Replace the role skip copy with explicit Keep current / Change affordance while retaining its ID and behavior.
  Default each role to Keep current, collapse its fields, and prefill current binding and effort for Change.
- Keep opencode effort hidden and make the layout responsive.

## T3. Render readable preview and status

- Requirement: R4-R5, R7.
- Files: `src/web/setup-page.ts`, `tests/setup-page.test.ts`.
- Render a status banner, change rows, and compact validation state from the existing API envelope.
- Keep the raw response collapsed if shown. Escape all dynamic preview content.
- Put Preview and Apply in one sticky bottom action bar with a selection and request status on the left. Disable both
  while loading or while an action is in flight.
- Add focused tests for current-state text, change rendering, validation states, escaping, and action availability.
- Update existing tests only when they pin old markup text, and record each changed assertion with its reason.

## T4. Wire registered page links

- Requirement: R1.3-R1.7.
- Files: `src/cli/commands/ui.ts`, `src/web/setup-routes.ts`, `tests/setup-web.test.ts`, `tests/web-cli.test.ts`.
- Pass the UI route table's page list into the setup renderer. Give standalone setup only its Setup link and point its
  brand link back to `/setup`.
- Verify the UI route links to Home, Review, Setup, and Usage and standalone setup links only to Setup.

## T5. Verify behavior and browser layout

- Requirement: R1-R7.
- Commands: `npx vitest run tests/setup-page.test.ts tests/setup-web.test.ts tests/web-cli.test.ts`; `npx tsc --noEmit -p .`;
  `npm run build`; scoped mutation probe; Chromium browser check at 1440x900 and 390x844.
- Record exact commands, pass/fail counts, mutation kills/survivors, console errors, scroll width, and screenshots in
  `validation.md`.
- Dispatch a read-only CodeDeck reviewer on the final diff, read its artifact, and address its findings.

## Coverage matrix

| Layer | Test type | File | Command |
| --- | --- | --- | --- |
| Role selection and current-state formatting | unit | `tests/setup-page.test.ts` | `npx vitest run tests/setup-page.test.ts` |
| Preview, validations, escaping, and actions | unit | `tests/setup-page.test.ts` | `npx vitest run tests/setup-page.test.ts` |
| Setup route and registered-page navigation | route unit | `tests/setup-web.test.ts` | `npx vitest run tests/setup-web.test.ts` |
| UI route navigation | route unit | `tests/web-cli.test.ts` | `npx vitest run tests/web-cli.test.ts` |
| Setup page and API regression | focused tests | `tests/setup-page.test.ts`, `tests/setup-web.test.ts`, `tests/web-cli.test.ts` | `npx vitest run tests/setup-page.test.ts tests/setup-web.test.ts tests/web-cli.test.ts` |
| Type checking | compiler | TypeScript project | `npx tsc --noEmit -p .` |
| Browser output and responsive width | manual e2e | no committed test | `npm run build`, launch UI, Chromium at 1440x900 and 390x844 |
