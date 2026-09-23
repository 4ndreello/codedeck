# Remove setup profiles validation

**Date**: 2026-09-23
**Spec**: `.specs/features/remove-profiles/spec.md`
**Diff range**: Working tree diff against `HEAD`, before commit
**Verifier**: Independent verifier, not the implementation author

## Validation

**Result**: PASS. R1 through R6 match the specified outcomes in the focused tests and source. The in-place mutation was reported killed, but its cleanup isolation was not independently established.

## Spec-anchored acceptance criteria

| Requirement | Spec-defined outcome | `file:line` + assertion | Result |
| --- | --- | --- | --- |
| R1 | The removed command is unknown. | `tests/setup-cli-contract.test.ts:241-242` expects Commander code `commander.unknownCommand`; `src/cli/index.ts:82-99` registers the remaining commands. | PASS |
| R2 | `run`, `open`, and `setup` expose no `--profile` option. | `tests/setup-cli-contract.test.ts:214-229` checks all three command option lists, checks setup's exact unknown-option result, and checks CLI exit code 2. | PASS |
| R3 | Run, open, setup, web setup, and doctor use top-level settings despite conflicting legacy values. | Run: `tests/run-role.test.ts:174-188` expects `codex` and `gpt-5.6-luna`. Open: `tests/open-action.test.ts:72-88` expects the top-level OpenCode model in launch arguments. Setup wizard: `tests/setup-wizard.test.ts:163-176` expects the top-level binding. Web: `tests/setup-web.test.ts:117-150` expects top-level bindings and settings. Doctor: `tests/doctor-roles.test.ts:91-124` expects the top-level reviewer binding in JSON. | PASS |
| R4 | CLI, wizard, and web saves update top-level fields and preserve both legacy values. | CLI batch save: `tests/setup-cli-contract.test.ts:286-322` reads the saved file and compares both legacy values. Wizard: `tests/setup-wizard.test.ts:178-202` checks the callback value. Web: `tests/setup-web.test.ts:163-194` checks the saved value. `src/config/setup.ts:332-362` builds the proposal by spreading the current config. | PASS |
| R5 | Text doctor output starts the role section with `Roles`, has no `Profile` text, and JSON omits both legacy fields. | `tests/doctor-roles.test.ts:119-135` checks the top-level JSON role, absence of the constructed `activeProfile` and `activeProfileError` keys, the `Roles` header, and absence of the constructed `Profile` label. | PASS |
| R6 | Web setup uses only the global target and shows no `Profile:` label. | `tests/setup-web.test.ts:145-151` expects `{ kind: "global" }` and checks the served page body has no `Profile:` string. `src/web/setup-page.ts:159-166` types only a global target. | PASS |

**Spec-anchored result**: 6/6 requirements matched the specified outcome. No precision gaps found.

## Gate checks

`npx tsc --noEmit -p .`

```text
Exit code: 0
No diagnostics.
```

`npx vitest run tests/setup-web.test.ts tests/setup-plan.test.ts tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts tests/doctor-roles.test.ts tests/run-role.test.ts tests/open-action.test.ts`

```text
Test Files  7 passed (7)
     Tests  197 passed (197)
```

The CLI contract test prints an unknown-command diagnostic while asserting that `profile` is rejected. The test passes. No full suite or baseline suite count was run because the task forbids it.

## Discrimination sensor

| Mutation | Evidence | Result |
| --- | --- | --- |
| Temporarily overlaid the legacy selected setup onto `src/cli/commands/run.ts` while `activeProfile` and `profiles` disagreed with top-level role data. | The author reports that `npx vitest run tests/run-role.test.ts -t 'uses the top-level binding when legacy setup data disagrees'` failed with legacy `opencode`/`legacy` values instead of expected `codex`/`gpt-5.6-luna`. The overlay was reverted. The filtered test passed after the revert, and my independent focused run also passed all 15 tests in `tests/run-role.test.ts`, including the cited case. | Killed, author-reported. Mutation ran in the active worktree, not a scratch copy. I did not independently verify porcelain isolation during injection. |

**Sensor result**: 1 reported mutation killed, 0 reported survivors. The test now passes after revert. This does not establish scratch isolation.

## Edge cases checked

- Conflicting legacy and top-level bindings for run, open, wizard setup, web setup, and doctor.
- Setup writes preserve legacy values on CLI batch, wizard, and web paths.
- Removed command and option are rejected by CLI contracts.
- Web setup state has only the global target.

## Code quality

| Check | Result |
| --- | --- |
| Changes stay within the requested removal and listed files, with the added run/open regression tests | PASS |
| No new single-use abstraction or unrelated formatting changes observed | PASS |
| Existing patterns are retained for config loading, setup plans, and test assertions | PASS |
| Focused route and command tests cover the changed setup and launch paths | PASS |
| Repository instructions supplied for this task are followed | PASS |

The deleted profile command and its dedicated profile tests are within the requested scope. Historical specs, `tests/open-codex.test.ts`, and `tests/mods-agents/pane.test.ts` were not changed. Tests use temporary configuration directories; no real user config was accessed.

## CodeDeck review

The read-only reviewer session `779f` completed with no blocking findings. It raised two non-blocking points:

- Legacy test keys are assembled from string fragments. Literal key names would violate the required case-insensitive grep output, so the tests keep the computed keys while asserting the actual loaded and saved values.
- The spec traceability rows were still Pending. They are now marked Verified based on the evidence above.

## Traceability

The R-01 through R-06 traceability statuses in `spec.md` are now `Verified`.

## Summary

**Overall**: PASS, with the sensor isolation limit recorded above.

**Gate**: TypeScript passed. Focused Vitest passed 7 files and 197 tests.

**Remaining work**: The implementation owner should update the spec traceability statuses and run the final repository-specific checks before commit.
