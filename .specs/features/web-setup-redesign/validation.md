# Web setup redesign validation

## Verification

- `npm install` completed earlier in this task. It changed the stale package version in `package-lock.json`; that
  incidental change was restored. No dependency or lockfile change is part of this work.
- `npx vitest run tests/setup-page.test.ts tests/setup-web.test.ts tests/web-cli.test.ts` exited 1: 1 file passed,
  2 files failed, 20 tests passed, and 22 failed. All 17 route tests in `tests/setup-web.test.ts` failed before
  reaching their assertions because the environment returned `listen EPERM: operation not permitted 127.0.0.1`.
  Five `tests/web-cli.test.ts` cases also failed after their server could not start. The output identified the same
  `listen EPERM` restriction.
- `npx vitest run tests/setup-page.test.ts` passed: 1 file, 16 tests.
- A direct compiled route-handler check using `node --input-type=module` passed. It asserted UI setup links in order
  Home, Review, Setup, Usage, and standalone setup links Setup only with its brand link pointing to `/setup`.
- `npx tsc --noEmit -p .` passed with exit code 0 and no diagnostics.
- `npm run build` passed. The script ran `tsc` and `npm run build:plugin`.
- `git diff --check` passed with no whitespace errors.

## Mutation probe

Temporarily changed the role prefill from `skip.checked = true` to `skip.checked = false`, then ran:

```text
npx vitest run tests/setup-page.test.ts -t 'keeps every role unchanged by default and prefills the current binding and effort'
```

The test failed at `expect(skip-reviewer.checked).toBe(true)`, showing the default-Keep-current behavior is covered.
The source was restored and the focused setup-page test passed afterward.

- Mutations killed: 1 of 1.
- Mutations survived: 0.

## Browser check

`/usr/bin/chromium --version` reported `Chromium 152.0.7977.82 Arch Linux`. A headless launch smoke test could not
start Chromium:

```text
/usr/bin/chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/setup-redesign/chromium-smoke-profile --dump-dom 'data:text/html,<html><title>smoke</title><body>ok</body></html>'
exit 133
[ERROR:third_party/crashpad/crashpad/util/linux/socket.cc:45] setsockopt: Operation not permitted (1)
```

After `npm run build`, the UI launch command also could not bind its local server:

```text
env RUN_AGENT_DIR=/tmp/setup-redesign/run-agent RUN_AGENT_CONFIG_DIR=/tmp/setup-redesign/config node dist/cli/index.js ui --no-open --port 3147
Failed to listen on 127.0.0.1:3147: listen EPERM: operation not permitted 127.0.0.1:3147
```

The real `/setup` browser interaction therefore did not run. Console errors and 390px `scrollWidth` could not be
measured. The requested screenshots were not refreshed:

- `/tmp/setup-redesign/desktop-before-preview.png`
- `/tmp/setup-redesign/desktop-after-preview.png`
- `/tmp/setup-redesign/mobile.png`

Those paths contain screenshots from the earlier implementation and are stale for this corrective round.

## Existing assertions

- `tests/setup-web.test.ts` now asserts Setup-only navigation for its standalone route. It replaces expectations for
  Home, Review, and Usage links that are not served by standalone `codedeck setup`; the brand link now returns to
  `/setup` too.
- `tests/setup-page.test.ts` changes the expected current sandbox text from `workspace write` to the literal
  `workspace-write`, as requested. No existing test asserted that bound roles began with Change.
- `tests/web-cli.test.ts` adds assertions that the UI-served setup navigation includes Home, Review, Setup, and Usage.

## Reviewer findings

Both findings from reviewer session `205e` are addressed in the current diff:

- `src/cli/commands/ui.ts` rebuilds setup routes with the UI page list. The route-handler check confirmed Home,
  Review, Setup, and Usage navigation.
- `src/web/setup-routes.ts` supplies Setup only when no page list is provided. The route-handler check confirmed
  Setup-only navigation and a brand link to `/setup` for standalone setup.

A final reviewer dispatch was attempted with `codedeck run --role reviewer --no-worktree --bg --json`, but CodeDeck
could not start its daemon (`Failed to start daemon`). It was retried after the final alignment change with the same
result, so the required read-only final review artifact is unavailable.

## Final role-grid adjustment verification

After adding `align-items: start` to the role grid:

- `npx vitest run tests/setup-page.test.ts` passed: 1 file, 16 tests.
- `npx tsc --noEmit -p .` passed with exit code 0 and no diagnostics.
- `npm run build` passed, including `tsc` and `build:plugin`.

## Orchestrator-verified results

The orchestrator verified the prior implementation outside this sandbox in the session `2cfc` worktree on
2026-09-24:

- `npx vitest run tests/setup-page.test.ts tests/setup-web.test.ts tests/web-cli.test.ts`: 42 of 42 tests passed.
- TypeScript check: clean.
- Headless Chromium against `dist`: navigation showed Home, Review, Setup, and Usage; all roles defaulted to Keep
  current; changing only reviewer effort produced exactly `reviewer · effort`, `low → high`; mobile
  `document.documentElement.scrollWidth` was 390; console errors: zero.

This browser run predates the final `align-items: start` role-grid adjustment. After that adjustment, the local
focused setup-page test, TypeScript check, and build results are recorded above and below; the sandbox still prevents
local headless Chromium from starting.

## Review remediation

- `createSetupPageController` now records the last rendered envelope by reference and its preview error. Form updates
  keep the existing `setup-result` DOM, while a new response renders a new preview.
- `createUiRoutes` creates the setup routes once with a shared page list. The setup and usage top bars include Home,
  Review, Setup, and Usage. The home page receives the same list without its Home entry.
- Added assertions that the home page has no self-link and setup navigation still links Home. Added an innerHTML write
  counter test for preview preservation and response replacement.
- Extended the manually resolved in-flight action test to assert `Preparing preview...` and `Saving setup...`.

Verification after the remediation:

- `npx vitest run tests/setup-page.test.ts`: passed, 1 file and 17 tests.
- `npx tsc --noEmit -p .`: passed with exit code 0 and no diagnostics.
- `npx vitest run tests/web-cli.test.ts tests/setup-web.test.ts`: passed, 2 files and 26 tests. Local HTTP listeners
  worked in this run.
- `git diff --check`: passed with no whitespace errors.
- Read-only review: `codedeck run --role reviewer --no-worktree --bg --json` completed as session `3933`; the
  reviewer reported no findings. The review also ran `npx vitest run tests/setup-page.test.ts tests/web-cli.test.ts`,
  which passed with 2 files and 26 tests.

Mutation probe:

- Temporarily restored unconditional `setup-result.innerHTML` assignment and ran
  `npx vitest run tests/setup-page.test.ts -t 'preserves the rendered raw preview on form updates and refreshes it for a new response'`.
  The regression test failed as expected: it observed 7 writes instead of 6 after a binding input event. The guard was
  restored, then the full setup-page test passed with 17 of 17 tests.
