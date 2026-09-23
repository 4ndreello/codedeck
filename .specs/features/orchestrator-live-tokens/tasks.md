# Orchestrator live tokens tasks

## Execution protocol

Implement each task with the `tlc-spec-driven` skill. Keep each task's source changes and tests together, run its scoped gate, and make one commit per task. Do not start a task until its dependencies are complete.

---

**Spec**: `.specs/features/orchestrator-live-tokens/spec.md`
**Design**: `.specs/features/orchestrator-live-tokens/design.md`
**Status**: Draft

## Test Coverage Matrix

> Generated from `CLAUDE.md`, `package.json`, `vitest.config.ts`, sampled tests, and the approved feature spec. The project uses Vitest files under `tests/**/*.test.ts`. Every gate scopes Vitest to named files and runs the TypeScript check. The full test suite is not part of these task gates.

| Code layer | Required test type | Coverage expectation | Test file | Run command |
| ---------- | ------------------ | -------------------- | ---------- | ----------- |
| Pure incremental transcript reader | Unit | Chunk boundary, keyed dedupe, invalid lines, 4 MiB partial-line cap, state immutability, and the 1 MiB input bound | `tests/claude-transcript.test.ts` | `npx vitest run tests/claude-transcript.test.ts` |
| Usage CLI | Integration | Valid and malformed `--transcript` values, first-equals parsing, optional cost observation, and exact `usage.get` params | `tests/usage-cli.test.ts` | `npx vitest run tests/usage-cli.test.ts` |
| IPC protocol | Integration | `usage.get` accepts the typed transcript parameter while preserving the existing cost observation | `tests/usage-cli.test.ts`, `tests/orchestrator-usage-daemon.test.ts` | `npx vitest run tests/usage-cli.test.ts tests/orchestrator-usage-daemon.test.ts` |
| Daemon live ingestion | Integration | Runtime parameter shapes, active-row checks, path containment and file type, symlink resolution, cost/transcript id mismatch, read cap, cursor resume/reset/cleanup, live-to-release high-water reconciliation, ledger failure, release overlap, and deferred earlier-id reads | `tests/orchestrator-usage-daemon.test.ts` | `npx vitest run tests/orchestrator-usage-daemon.test.ts` |
| Usage ledger high-water marks | Integration | Lower fields do not move marks; each higher field adds only its positive difference across rows | `tests/usage-ledger.test.ts` | `npx vitest run tests/usage-ledger.test.ts` |
| Statusline script | Integration | Exact CLI arguments, worker plus orchestrator token total, invalid summary token fields, active-run timeout behavior, and local fallback without a run id | `tests/statusline.test.ts`, `tests/usage-statusline-contract.test.ts` | `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts` |

## Gate Check Commands

| Gate | When to use | Command |
| ---- | ----------- | ------- |
| Task gate | After each task | `npx vitest run <task test files> && npx tsc --noEmit -p .` |

## Execution Plan

Phase 1 tasks have disjoint files and can run in parallel. Phase 2 starts after both finish. Phase 3 follows the daemon integration.

| Task | Deliverable | LIVE IDs | Files owned | Depends on | Parallel |
| ---- | ----------- | -------- | ----------- | ---------- | -------- |
| T1 | Pure incremental transcript reader | LIVE-07, LIVE-08 | `src/core/claude-transcript.ts`, `tests/claude-transcript.test.ts` | None | Yes, with T2 |
| T2 | Transcript CLI option and IPC parameter | LIVE-02 | `src/daemon/protocol.ts`, `src/cli/commands/usage.ts`, `tests/usage-cli.test.ts` | None | Yes, with T1 |
| T3 | Bounded daemon ingestion | LIVE-03, LIVE-04, LIVE-05, LIVE-06, LIVE-07, LIVE-08, LIVE-09, LIVE-10, LIVE-12, LIVE-15 | `src/daemon/daemon.ts`, `tests/orchestrator-usage-daemon.test.ts` | T1, T2 | No |
| T4 | Statusline transcript forwarding and combined tokens | LIVE-01, LIVE-11, LIVE-13, LIVE-14 | `plugin/statusline.sh`, `tests/statusline.test.ts`, `tests/usage-statusline-contract.test.ts` | T2, T3 | No |

```text
Phase 1:  T1       T2
Phase 2:  T1 -> T3
          T2 -> T3
Phase 3:  T2 -> T4
          T3 -> T4
```

## Task Breakdown

### Phase 1: Independent foundations

#### T1: Add the pure incremental transcript reader

**What**: Add a pure chunk consumer for live assistant token records while preserving the existing full-file release reader.
**Where**: `src/core/claude-transcript.ts`
**Files owned**: `src/core/claude-transcript.ts`, `tests/claude-transcript.test.ts`
**Depends on**: None
**Can run in parallel with**: T2
**Requirement**: LIVE-07, LIVE-08

**Exported interface**:

```typescript
export const TRANSCRIPT_CHUNK_LIMIT_BYTES = 1_048_576;
export const TRANSCRIPT_PENDING_LINE_LIMIT_BYTES = 4_194_304;

export interface IncrementalTranscriptState {
  pendingLine: Uint8Array;
  discardUntilNewline: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  seenMessageKeys: Set<string>;
}

export function consumeTranscriptChunk(
  state: IncrementalTranscriptState,
  bytes: Uint8Array,
): IncrementalTranscriptState;
```

**Done when**:

- [ ] The consumer rejects a chunk over `TRANSCRIPT_CHUNK_LIMIT_BYTES` with `RangeError` and does not mutate its input state.
- [ ] It parses only complete newline-terminated JSONL records, skips invalid JSON, and resumes a pending line when the next chunk completes it.
- [ ] Assistant input, output, cache-read, and cache-creation values accumulate with the existing token mapping.
- [ ] A `JSON.stringify([message.id, requestId])` key contributes once across chunks; records missing either id keep the existing one-pass behavior.
- [ ] A partial line that grows beyond 4 MiB is dropped through its next newline, and a valid following line is counted.
- [ ] Tests for these outcomes are added to `tests/claude-transcript.test.ts` in this task. Existing release-reader cases keep passing.
- [ ] Gate passes: `npx vitest run tests/claude-transcript.test.ts && npx tsc --noEmit -p .`

**Tests**: Unit tests in `tests/claude-transcript.test.ts`, written in this task.
**Gate**: `npx vitest run tests/claude-transcript.test.ts && npx tsc --noEmit -p .`
**Mutation probe**: Change the dedupe key to use only `message.id`. The test with one message id and two request ids must fail.
**Commit**: `feat(usage): Add the incremental transcript reader`

---

#### T2: Forward transcript observations through usage.get

**What**: Add the `--transcript <native-id>=<path>` CLI option and the optional transcript parameter to the existing usage request.
**Where**: `usage.get` request contract and usage option parsing
**Files owned**: `src/daemon/protocol.ts`, `src/cli/commands/usage.ts`, `tests/usage-cli.test.ts`
**Depends on**: None
**Can run in parallel with**: T1
**Requirement**: LIVE-02

**Exact request parameter shape**:

```typescript
export interface GetUsageRequest {
  method: "usage.get";
  params: {
    runId: string;
    observe?: { nativeId: string; costUsd: number };
    transcript?: { nativeId: string; path: string };
  };
}
```

**Done when**:

- [ ] `GetUsageRequest.params` has exactly the existing `runId` and `observe` fields plus optional `transcript` in the shape above.
- [ ] The CLI parses `--transcript` by splitting at its first `=`, preserving additional equals signs in the path.
- [ ] A valid transcript flag is sent in the same `usage.get` request as a valid cost observation. A transcript-only request is also forwarded.
- [ ] A malformed transcript flag is omitted without suppressing a valid cost observation or the returned run summary.
- [ ] Tests for the request shape and parsing behavior are added to `tests/usage-cli.test.ts` in this task.
- [ ] Gate passes: `npx vitest run tests/usage-cli.test.ts && npx tsc --noEmit -p .`

**Tests**: Integration tests in `tests/usage-cli.test.ts`, written in this task.
**Gate**: `npx vitest run tests/usage-cli.test.ts && npx tsc --noEmit -p .`
**Mutation probe**: Split the flag at its last `=` instead of its first. A path containing `=` must make the test fail.
**Commit**: `feat(usage): Forward transcript observations through usage.get`

---

### Phase 2: Daemon integration

#### T3: Ingest bounded live transcript chunks in the daemon

**What**: Validate and read transcript observations in `usage.get`, keep reader state in daemon memory, and submit cumulative token totals to the existing ledger.
**Where**: Daemon `usage.get` handler
**Files owned**: `src/daemon/daemon.ts`, `tests/orchestrator-usage-daemon.test.ts`
**Depends on**: T1, T2
**Requirement**: LIVE-03, LIVE-04, LIVE-05, LIVE-06, LIVE-07, LIVE-08, LIVE-09, LIVE-10, LIVE-12, LIVE-15

**Done when**:

- [ ] A `Map<string, LiveTranscriptCursor>` stores each native id's byte offset, parser state, device, and inode. The parser state includes pending bytes, the oversize-line flag, cumulative token totals, and the seen-key `Set`.
- [ ] A transcript parameter with a malformed runtime shape is ignored without rejecting the request or suppressing a valid cost observation.
- [ ] Process transcript observations only for an active Claude `open` row. Check the row status inside the per-native-id serializer before linking or reading; a terminal row skips transcript ingestion while preserving valid cost handling and the summary response.
- [ ] The daemon resolves the projects root and supplied path with `realpath`, requires the resolved transcript to be under the root with basename `<native-id>.jsonl`, and rejects non-regular files. An in-root symlink resolving to the expected file is accepted; a symlink resolving outside is rejected.
- [ ] Validation or open failure leaves the cursor and transcript token observations unchanged. A valid cost observation still applies when transcript validation fails or cost and transcript ids differ.
- [ ] A malformed present cost observation returns `INVALID` before processing a valid transcript parameter, preserving the existing strict daemon behavior.
- [ ] Each request reads at most 1 MiB for one native id. It resumes from the in-memory offset, stores partial parser state, and serializes transcript reads, cursor replacement, and release cleanup for that id.
- [ ] A device/inode change or file size below the saved offset resets offset, pending bytes, and oversize-line state while preserving cumulative totals and seen keys.
- [ ] The ledger receives cumulative fields on `openSourceKey(nativeId)`. Commit the ledger transaction before replacing the in-memory cursor. If ledger persistence fails, keep the old cursor so a retry rereads the chunk.
- [ ] A new daemon starts with an empty cursor map and reads from byte zero. Partial totals below the persisted ledger high-water marks do not lower displayed totals; later chunks catch up and add only new differences.
- [ ] Linking a new id does not wait for earlier full transcript reads. Send the current live response first, then queue earlier-id reconciliation. Existing release/startup reconciliation can retry from durable link state.
- [ ] Make `reconcileOpenUsageSafely` return `true` when the requested reconciliation pass completes without throwing, including a vanished transcript marked `missing` or an already reconciled link, and `false` when reconciliation or ledger persistence throws. Only the full `session.release` pass may use a `true` result for cursor cleanup, not a selected earlier-id pass from `usage.get`. After a `true` full pass, queue cleanup for every id linked to that released session through its per-id serializer and remove each cursor only when no active Claude `open` row remains linked to it. If the full pass returns `false`, retain all cursors even if some links were reconciled before the failure.
- [ ] Tests cover path handling, malformed transcript and cost params, terminal-row and post-release requests, chunking, reset, in-flight release overlap, cleanup for multiple ids after successful reconciliation, retaining all cursors after failed reconciliation, a missing transcript terminal mark, ledger failure, restart, deferred reconciliation, and a live observation followed by release `cost-state` values with lower input and higher output, verifying only the output difference is attributed. Add them to `tests/orchestrator-usage-daemon.test.ts` in this task. Existing isolated high-water cases in `tests/usage-ledger.test.ts` remain part of the gate.
- [ ] Gate passes: `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-ledger.test.ts && npx tsc --noEmit -p .`

**Tests**: Integration tests in `tests/orchestrator-usage-daemon.test.ts`, written in this task. Run the existing `tests/usage-ledger.test.ts` cases for the persisted high-water behavior.
**Gate**: `npx vitest run tests/orchestrator-usage-daemon.test.ts tests/usage-ledger.test.ts && npx tsc --noEmit -p .`
**Mutation probe**: Remove the resolved-path containment check. The outside-project transcript test must fail while its same-request valid cost observation still succeeds.
**Commit**: `feat(usage): Ingest live transcript token chunks`

---

### Phase 3: Statusline

#### T4: Forward the transcript path and display combined run tokens

**What**: Pass the statusline transcript path to the usage CLI and render worker plus orchestrator token totals.
**Where**: `plugin/statusline.sh`
**Files owned**: `plugin/statusline.sh`, `tests/statusline.test.ts`, `tests/usage-statusline-contract.test.ts`
**Depends on**: T2, T3
**Requirement**: LIVE-01, LIVE-11, LIVE-13, LIVE-14

**Done when**:

- [ ] When `session_id` and `transcript_path` are valid and non-empty, the statusline appends `--transcript <session_id>=<transcript_path>` to its existing `usage <run-id> --json` argument array.
- [ ] With a valid run summary, the `tok` field uses `summary.totalTokens + summary.orchestrator.totalTokens` and does not add `cachedTokens` a second time.
- [ ] If `CODEDECK_RUN_ID` is set and the usage call fails, times out, returns an invalid summary, or has an absent, nonnumeric, non-finite, or negative `totalTokens` value at either level, the statusline omits `tok`, keeps other valid local fields, and exits 0 without using context-window tokens.
- [ ] If both summary `totalTokens` values are finite and non-negative, the `tok` value is their exact sum; tests cover invalid worker and orchestrator values independently.
- [ ] With no `CODEDECK_RUN_ID`, the current local context-token fallback remains.
- [ ] The run summary contract tests include the merged worker and orchestrator `totalTokens` fields. Statusline and contract tests are updated in this task.
- [ ] Gate passes: `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts && npx tsc --noEmit -p .`

**Tests**: Integration tests in `tests/statusline.test.ts` and `tests/usage-statusline-contract.test.ts`, written in this task.
**Gate**: `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts && npx tsc --noEmit -p .`
**Mutation probe**: Render only `summary.totalTokens` and omit `summary.orchestrator.totalTokens`. The combined-total fixture must make the test fail.
**Commit**: `feat(statusline): Display live orchestrator token totals`

---

## Phase Execution Map

Phases run in order. T1 and T2 own disjoint files and can run in parallel. T3 waits for both interfaces; T4 waits for the CLI, protocol, and daemon behavior.

```text
Phase 1:  T1       T2
Phase 2:  T1 -> T3
          T2 -> T3
Phase 3:  T2 -> T4
          T3 -> T4
```

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1 | Pure chunk consumer in one module, with co-located unit tests | Granular |
| T2 | One request contract across protocol and CLI files, with co-located CLI tests | Cohesive, as required by the approved task shape |
| T3 | One daemon request path and its integration tests | Granular |
| T4 | One statusline behavior and its contract tests | Granular |

## Diagram-Definition Cross-Check

| Task | Depends on | Diagram shows | Status |
| ---- | ---------- | ------------- | ------ |
| T1 | None | None | Match |
| T2 | None | None | Match |
| T3 | T1, T2 | T1 -> T3; T2 -> T3 | Match |
| T4 | T2, T3 | T2 -> T4; T3 -> T4 | Match |

## Test Co-location Validation

| Task | Code layer | Matrix requires | Task says | Status |
| ---- | ---------- | --------------- | --------- | ------ |
| T1 | Pure incremental transcript reader | Unit | Unit tests in T1 | Match |
| T2 | Usage CLI and IPC request contract | Integration | Integration tests in T2 | Match |
| T3 | Daemon ingestion and usage ledger high-water behavior | Integration | Daemon tests in T3; existing ledger cases in its gate | Match |
| T4 | Statusline script and summary contract | Integration | Statusline and contract tests in T4 | Match |
