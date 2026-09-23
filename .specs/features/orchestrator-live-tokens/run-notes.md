# Run notes: orchestrator-live-tokens

Append-only. One entry per decision or event.

## Before autonomous activation (human-approved)

- S0. Investigation: in `codedeck open` the statusline `tok` field counts worker tokens only; reproduced `ctx 60% · 0 tok · run $2.10` with a fake payload and a fake `codedeck usage`.
- S0. Found Codex cached tokens double counted in `tok` and `queryUsage` totals. Fixed by worker f830 (commit ab2bcbb), PR #110 opened with the human's approval before autonomous mode.
- S0. Human decisions: cache tokens count in `tok`; orchestrator live tokens via incremental transcript read; spec cuts approved: in-memory cursor and dedupe (no SQLite tables), simplified path validation, `CLAUDE_CONFIG_DIR` out of scope.
- S0. Spec v1 by worker e174 (commit a87d632). Worker 76f5 merged the fix branch (7a3f067) then died on a backend 503; its queued `send` never delivered because the session was `failed`. Superseded by worker 6ff1 with the same briefing.

## Autonomous run

- A1. Autonomous mode activated by the human (`/codedeck:autonomous`). Bucket 2 from here on: no push, no PR, no network writes. Implementation stays on local branches.
- A2. Spec v2 + tasks.md accepted from worker 6ff1 (commit 1ed891c): LIVE-09 removed, cursor/dedupe in memory, simplified path validation, CLAUDE_CONFIG_DIR out of scope. Worker 6ff1 retired.
- A3. Decision (bucket 1): run T4 in parallel with T1 and T2 instead of after T3. Reason: the statusline only needs the fixed `--transcript` flag name and the `totalTokens` fields already on `RunUsageSummary`; its tests use a fake `codedeck` binary. Files are disjoint.
- A4. Decision (bucket 1): workers symlink `/home/andreello/dev/codedeck/node_modules` instead of running `npm install` (network fetch is bucket 2 in autonomous mode). Dependencies are unchanged on these branches.
- A5. Dispatched T1 bf8b (ra/live-tokens-t1-reader-bf8b), T2 b09d (ra/live-tokens-t2-cli-b09d), T4 6d82 (ra/live-tokens-t4-statusline-6d82), all based on 1ed891c. T3 waits for T1 and T2.
- A6. T1 accepted: commit 6a548f0, 2 owned files, `npx vitest run tests/claude-transcript.test.ts` 11/11 (re-run by orchestrator), mutation (dedupe key on message.id only) killed. Worker bf8b retired.
- A7. T2 accepted: commit 5e4c4f5, 3 owned files, `npx vitest run tests/usage-cli.test.ts` 13/13 (re-run by orchestrator), mutation (split at last `=`) killed. Worker b09d retired.
- A8. Merged T1 and T2 into the integration branch (1318ecc). Dispatched T3 60bc (ra/live-tokens-t3-daemon-60bc) based on 1318ecc.
- A9. T4 accepted: commit f81683b, 3 owned files, `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts` 28/28 (re-run by orchestrator). The old `input+output+cached` fallback for a summary without `totalTokens` was removed on purpose (LIVE-11: omit `tok`). Worker 6d82 retired; merged into integration.
- A10. T3 accepted: commit 05517f6, 2 owned files, `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-ledger.test.ts` 40/40 (re-run by orchestrator), mutation (drop path containment check) killed per worker log. Worker 60bc retired; merged into integration (bca85ce).
- A11. Integration verification on bca85ce: batch 1 `npx vitest run tests/claude-transcript.test.ts tests/pricing.test.ts tests/usage.test.ts tests/usage-query.test.ts tests/usage-ledger.test.ts` 60/60; batch 2 `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-daemon.test.ts` 43/43; batch 3 `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts tests/usage-cli.test.ts` 41/41; `npx tsc --noEmit -p .` clean.
- A12. Dispatched final read-only review 2730 (reviewer role) over 6344eeb..bca85ce.
- A13. Final review 2730: no blocker or major; 137 tests across 9 scoped files passed in its run. Minor 1 (earlier-id reconciliations pile up concurrently on every usage.get): accepted as a fix slice, dispatched 0309. Minor 2 (keyless assistant lines recounted after inode change or shrink): left as the spec open question, recorded as known risk. Minor 3 (redundant outer active-row check): no change, behaviour correct. Reviewer retired.
- A14. Fix de71eea accepted: 2 owned files, `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-ledger.test.ts` 40/40 (re-run by orchestrator), mutation (remove in-flight filter) killed: 2 reconciliations instead of 1. Correction reviewed by the orchestrator (diff read). Worker 0309 retired; fast-forwarded integration to de71eea.
- A15. Decision (bucket 1): renamed the local integration branch `ra/orchestrator-live-tokens-spec-e174` to `feat/orchestrator-live-tokens`. Not pushed (bucket 2).
- A16. Post-merge check on de71eea: `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-daemon.test.ts` 43/43; `npx tsc --noEmit -p .` clean. All workers of run c18d retired.
