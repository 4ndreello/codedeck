# Run report: orchestrator-live-tokens

Goal: in `codedeck open`, the Claude statusline `tok` field counted worker tokens only, so a run without workers showed `0 tok` while `run $` already included the orchestrator. This run makes `tok` equal worker `totalTokens` plus orchestrator `totalTokens`, with the orchestrator read live from its transcript, and fixes the Codex cached-token double count found on the way.

## Done

- Branch (local only, not pushed): [feat/orchestrator-live-tokens](https://github.com/4ndreello/codedeck/tree/feat/orchestrator-live-tokens)
- Commit: [de71eea1fc9a5e062524fddb773bfe6bf89ffe95](https://github.com/4ndreello/codedeck/commit/de71eea1fc9a5e062524fddb773bfe6bf89ffe95)
- The links resolve only after the branch is pushed. Base: `6344eeb`. Diff: 20 files, 2096 insertions, 49 deletions.
- The run notes and this report are committed on top of that commit.

| Commit | Worker | Slice | Evidence checked by the orchestrator |
| --- | --- | --- | --- |
| ab2bcbb | f830 | `fix(usage)`: count Codex cached tokens once (`totalTokensFor`, `RunUsageSummary.totalTokens`). Also pushed as PR #110 before autonomous mode. | 6 files, 74/74 tests; mutation (always add cached) killed |
| a87d632, 1ed891c | e174, 6ff1 | spec, design, tasks (LIVE-01..15, LIVE-09 removed) | docs only |
| 6a548f0 | bf8b | T1: `consumeTranscriptChunk`, 1 MiB chunk cap, 4 MiB pending-line cap, dedupe by `message.id`+`requestId` across chunks | `tests/claude-transcript.test.ts` 11/11; mutation (key on `message.id` only) killed |
| 5e4c4f5 | b09d | T2: `--transcript <id>=<path>` CLI flag, `usage.get` `transcript` param | `tests/usage-cli.test.ts` 13/13; mutation (split at last `=`) killed |
| f81683b | 6d82 | T4: statusline forwards `transcript_path`, `tok` = worker + orchestrator `totalTokens`, omits `tok` when a run is active but the summary is unavailable | statusline + contract tests 28/28; mutation (drop orchestrator term) killed |
| 05517f6 | 60bc | T3: daemon live ingestion: in-memory cursor per native id, per-id lock, realpath containment under `~/.claude/projects`, `<id>.jsonl` basename, regular file, reset on inode change or shrink, ledger commit before cursor swap, earlier-id reconciliation after the response | daemon + ledger tests 40/40; mutation (drop containment check) killed |
| de71eea | 0309 | review fix: skip duplicate in-flight earlier-id reconciliations | daemon + ledger tests 40/40; mutation (remove in-flight filter) killed |

Integration checks on the merged branch (`bca85ce`, then `de71eea`):
- `npx vitest run tests/claude-transcript.test.ts tests/pricing.test.ts tests/usage.test.ts tests/usage-query.test.ts tests/usage-ledger.test.ts`: 5 files, 60 tests passed
- `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-daemon.test.ts`: 2 files, 43 tests passed (re-run after de71eea)
- `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts tests/usage-cli.test.ts`: 3 files, 41 tests passed
- `npx tsc --noEmit -p .`: clean

The final read-only review (reviewer 2730, over `6344eeb..bca85ce`) found no blocker and no major issue. It ran 9 scoped files with 137 passing tests and found no drift outside each task's owned files. It reported three minor points: one was fixed in de71eea, and the other two are listed below.

## Assumptions I made

- The human approved these before autonomous mode: cache tokens count in `tok`; the orchestrator's live tokens come from an incremental transcript read; cursor and dedupe state stay in memory (no SQLite tables); path validation is simplified; `CLAUDE_CONFIG_DIR` is out of scope.
- Bucket 1: T4 ran in parallel with T1 and T2 instead of after T3. The statusline needs only the fixed flag name and the `totalTokens` fields, and its tests use a fake `codedeck` binary.
- Bucket 1: workers symlinked `/home/andreello/dev/codedeck/node_modules` instead of running `npm install`, because a network fetch is bucket 2. Dependencies are unchanged.
- Bucket 1: T4 removed the old `input + output + cached` fallback for a summary without `totalTokens`. Per LIVE-11, `tok` is omitted instead. The CLI and the plugin ship in the same package, so a version mismatch between them is not expected.
- Bucket 1: renamed the integration branch to `feat/orchestrator-live-tokens`.
- Bucket 1: the review fix for concurrent earlier-id reconciliations was applied without asking.

## Deferred / waiting for you

- Push `feat/orchestrator-live-tokens` and open its PR. This is bucket 2: publishing commits.
- Order against PR #110: the feature branch already contains `ab2bcbb`. Merge #110 first, or close it and ship everything through the feature PR.
- Delete the scratch directories that workers left in `/tmp`: `codedeck-t1-mutation.*`, `codedeck-t4-mutant.*`, `codedeck-usage-reconcile-probe.*`, `codedeck-token-mutation-*`. Their sandbox refused `rm -rf`. Deleting files is bucket 2.
- Open product questions that remain in the spec:
  - Should keyless assistant lines get a fallback dedupe key? Today they can be recounted after an inode change or a shrink; this is the known risk in the next section.
  - Is 1 MiB per refresh enough on slow disks?
  - What pruning policy should in-memory cursors follow beyond release cleanup?

## Blocked / failed

- Worker 76f5 (spec v2) failed on a backend 503 (`Unable to verify Daybreak Blue access`). The merge it had already made (7a3f067) was kept. `codedeck send` to the failed session stayed queued and was never delivered. The worker was superseded by 6ff1, which completed. The undelivered queued `send` to a `failed` session may be a CodeDeck send-queue gap. It was not investigated.
- Known risk, not fixed (review minor 2): an assistant line without `message.id` or `requestId` is counted again when the transcript's inode changes or the file shrinks below the saved offset. A daemon restart is not affected, because the ledger high-water marks absorb the lower re-read totals.

## Not covered

- No end-to-end run against a real `codedeck open` session, real daemon and real transcript. Coverage comes from integration tests with fixture transcripts and a fake `codedeck` binary.
- The `dist/` gates (`scripts/pty-gate.sh`, theme and rename gates) were not run, and there was no `npm run build`.
- The full test suite was not run, by the machine constraint. Only the files listed above ran.
- Read latency of the 1 MiB cap on a slow disk was not measured.
- After a daemon restart, a transcript of about 30 MB takes about a minute of 2 s refreshes to catch up. The displayed total does not drop meanwhile. This behaviour is in the design and was not measured.
