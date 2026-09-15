# Run report: agy-empty-profile-swap

Autonomous run covering two reported bugs: Antigravity sessions surfacing as an empty string, and setup with --profile showing another profile's content. Both fixed, verified, and proposed as draft PR #84.

## Done

- Branch: [fix/agy-empty-profile-swap](https://github.com/4ndreello/codedeck/tree/fix/agy-empty-profile-swap)
- Commit: [8772491](https://github.com/4ndreello/codedeck/commit/8772491) (tip; base `07e693f` = origin/main)
- PR: https://github.com/4ndreello/codedeck/pull/84 (MERGED via merge commit [ba05b32](https://github.com/4ndreello/codedeck/commit/ba05b32fef5003431473a65f827b82a77aedebf0); branch deleted locally and remotely)
- Commit 1 `b7efe19` fix(profile): 5 files, 187 insertions, 10 deletions. `profile save` resolves the explicit target instead of the active profile, new `--profile` setups start from base with an empty agent map, role pin respects `loaded.defaultAgent`.
- Commit 2 `9b3c130` fix(antigravity): 3 files, 807 insertions, 6 deletions. Stateful per-session delta accumulation with message reconstruction, `session.failed` on empty/whitespace-only results, lifecycle resets plus bounded replay of consumed output on reattach.
- Discovery: `2bbf` (reviewer/antigravity, completed) reproduced the empty bug live with `result.response: ""` and zero `text.delta`; `050c` (auditor/antigravity, completed) ranked 4 profile root causes with file:line evidence. Both diffs empty (read-only).
- Fixes: `05fb` (opencode, completed exit 0, 134 events) delivered the profile fix including a corrective cycle for 3 reviewer regressions; `e80c` (codex, stopped after delivery, 304 events) delivered the antigravity fix through 3 read-only review rounds (`798b`, `6a3a`, `4dab`, all completed success).
- Verification quoted from the integration worktree: `Test Files 4 passed (4), Tests 172 passed (172)`, `tsc --noEmit` clean, `git diff --check` clean. Mutation probe: M1 (empty branch to completed) killed by 13 tests, M2 (restore root-agent leak) killed by 1 test; 2 kills, 0 survivors; scratch reverted.
- CI fix after PR: SonarCloud failed the gate on `new_duplicated_lines_density` 16.2% (all 161 lines in `tests/antigravity-driver.test.ts`). Two test-only dedup commits (`2038078` helpers, `8772491` it.each + shared replay helper) brought it to 0.0%; full gate green with no src changes.

## Assumptions I made

- Bucket 1 (reversible, taken): per-session delta accumulation and empty-to-failed semantics; `{ ...baseConfig(loaded), agents: {} }` for new profiles; `loaded.defaultAgent` for the role pin; chunked accumulator with cap plus truncation marker; bounded fd-based replay read; notes/bootstrap files under `.specs/`.
- Bucket 1 (process): nested `--role reviewer` runs landing on the root Claude binding instead of low-cost Antigravity was treated as lucky routing-around, not as license to use Antigravity for implementation.
- Fixes were integrated by applying `codedeck diff 05fb` (299 lines) and `codedeck diff e80c` (935 lines) onto a fresh `origin/main` worktree, keeping the arcade agent's uncommitted checkout untouched.

## Deferred / waiting for you

- Merge PR #84 (publishing/sharing is bucket 2; the draft is ready for human review).
- Decide the `profile save` fork semantics: `use a; save a-copy` no longer forks the active setup (documented in the save description; README line 196 still says "current setup" and was left untouched as outside owned files).
- Decide what `unset` roles in a partial profile should mean at launch (currently falls back to driver defaults with a visible `general unset` line).
- Probe why nested `codedeck run --role reviewer --no-worktree` from fix worktrees resolved to root Claude instead of active-profile Antigravity while `run.ts:55` reads correct; sessions `cff7`, `798b`, `6a3a`, `4dab`, `35c2` carry the exact commands.

## Blocked / failed

- `2bbf` delivered no finding text because the Antigravity harness itself returned `""` (299s, 820k input tokens); treated as live reproduction, profile diagnosis `050c` carried the reporting.
- Fix worktrees ship no `node_modules`, so `pnpm vitest` fails there (`ERR_PNPM_IGNORED_BUILDS` / missing package); both fix workers correctly refused installs (bucket 2) and verification ran in the integration worktree via a temporary `node_modules` symlink (removed before commit).
- `e80c` entered scope churn on its 4th review cycle (diff 361 to 807 insertions); capped with a complete-now directive and snapshotted. Residual 4dab perf notes (quadratic past-cap append, head-drop marker wording, driver-lifecycle mutation coverage) are partly addressed; anything further is follow-up.
- Pre-existing, not a regression: `classifyFailure` throws on non-string `result.error` (4dab finding 5); `profile.ts:127` freezing inherited keys on re-save of partial profiles matches HEAD behavior.

## Not covered

- No live `agy` turn was ever spent (model spend, all evidence from parser/runtime/probes); empty-response shape against agy 1.2.2 in the wild stays unverified, as does `--conversation` init-frame behavior gating one stale-text scenario.
- No full suite (repo batching rule); only `tests/antigravity-driver.test.ts` (43 tests), `tests/profiles.test.ts` (20), `tests/setup-cli-contract.test.ts` (26), `tests/setup-wizard.test.ts` (83).
- No `dist/` rebuild check, no `gh pr checks` / SonarCloud (uncommitted at review time; CI will run on PR #84).
- Picker rendering, `doctor`/`open`/`web` profile consumption beyond call-site reads, and empty-response handling in non-antigravity drivers.
