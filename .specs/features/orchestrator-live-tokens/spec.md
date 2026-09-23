# Orchestrator live tokens specification

## Problem Statement

In `codedeck open`, the Claude statusline shows worker tokens but omits the orchestrator's tokens. A run with no workers can therefore show `0 tok` while its cost already includes the orchestrator. The statusline cannot use `context_window.total_*_tokens` as a session total because Claude Code reports the current context window there. This feature reads the session transcript incrementally and adds its cumulative token usage to the run summary.

The current statusline submits cost through `codedeck usage` and has a one-second command timeout, but it does not submit `transcript_path` or read transcript tokens (`plugin/statusline.sh:180-225`). Its aggregate token field is worker-only (`plugin/statusline.sh:248-256`). The existing transcript reader streams the full file at release and keeps message dedupe keys only for that read (`src/core/claude-transcript.ts:88-167`).

## Relationship to existing specifications

This feature extends `.specs/features/orchestrator-usage/spec.md`. It replaces that spec's "Live orchestrator token counts" out-of-scope entry. It also replaces the token-source clause in `.specs/features/run-usage-statusline/spec.md` acceptance criterion 5, which sources orchestrator tokens from the local context window, and the worker-only token total in acceptance criterion 9. When `CODEDECK_RUN_ID` is set but the run query is unavailable, it replaces the local-token fallback in criterion 9 and the fallback in criterion 11. When `CODEDECK_RUN_ID` is absent, the local-token fallback remains. The cost value still comes from `payload.cost.total_cost_usd`; `.specs/features/orchestrator-usage/spec.md` defines its storage and attribution. Other requirements in those specifications remain in force.

## Goals

- Show cumulative worker and orchestrator tokens in the Claude `open` statusline.
- Read a bounded amount of new transcript data per refresh and continue later without losing or double-counting token observations.
- Keep live transcript tokens and release-time transcript reconciliation on the same per-native-session high-water ledger.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Input, output, or cache breakdown on the statusline | The agreed display is one total token count. |
| Live tokens in statuslines for Codex, OpenCode, or OMP | This feature covers the Claude orchestrator started by `codedeck open`. |
| Replacing transcript totals with `context_window` token values | Those values describe the current context window, not the cumulative session. |
| Durable cursor and dedupe storage | The daemon keeps live reader state in memory. Its usage ledger keeps the per-field high-water marks. |
| Non-default Claude config roots through `CLAUDE_CONFIG_DIR` | CodeDeck accepts only `~/.claude/projects` for this feature. The repository does not set or read `CLAUDE_CONFIG_DIR` in `src/` or `plugin/hooks/`. |

## Assumptions & Open Questions

| Decision | Chosen behavior | Rationale |
| --- | --- | --- |
| Run summary token fields | Use `RunUsageSummary.totalTokens` and `RunUsageSummary.orchestrator.totalTokens`, both present on this branch after commit `7a3f067`. | The statusline consumes the run aggregate instead of recalculating harness-specific cache rules. |
| Transcript read cap | Read at most 1,048,576 new bytes per native id per `usage.get` request. | A fixed byte bound limits work under the statusline's one-second timeout. |
| Restart after daemon exit | Keep the byte offset, pending line, cumulative totals, and seen keys in daemon memory only. After restart, begin at byte zero and reread in capped chunks. | The persisted per-field ledger ignores lower partial totals until the reread passes each high-water mark, so the displayed total does not drop. |
| Large transcript catch-up | A 30 MB transcript takes about 30 refreshes, or roughly one minute at the current two-second refresh interval, after a daemon restart. | The 1 MiB request cap remains in place; the existing high-water marks keep displayed totals stable during catch-up. |
| Transcript path | Resolve the projects root and supplied path with `realpath`. Accept only a regular file below the resolved root whose resolved basename is `<native-id>.jsonl`. | The statusline and daemon run as the same local user. A caller able to submit a malicious path can already read that file. Canonical containment, basename, and file-type checks keep observations tied to the expected transcript tree without per-component symlink rejection or descriptor identity checks. |
| Rejected transcript path | Skip transcript reading and leave its cursor and token observations unchanged. A valid cost observation in the same request remains eligible for recording. | A bad transcript path must not suppress the existing cost path or make the statusline fail. |
| Partial JSONL line | Keep an incomplete line up to 4 MiB in memory. If it grows beyond that cap, drop the fragment and skip bytes through the next newline. | The read cap bounds new bytes per request. This also bounds retained partial-line memory. |
| Same-file rewrite detection | Compare the current stat device and inode with the cursor identity, and compare size with the saved offset. Restart at byte zero if the identity changes or the file shrinks below the offset. | These cheap checks catch replacement and truncation. A same-identity rewrite that remains at least as large as the saved offset is not detected. |

**Open questions:**

1. Which minimum Claude Code version must CodeDeck support for `transcript_path`? If the field is absent, live transcript reading is skipped.
2. Should assistant usage lines missing `message.id` or `requestId` get a fallback dedupe key after a transcript rewrite? The existing reader counts such lines once per read and this feature keeps that rule.
3. Is the 1,048,576-byte cap enough for each refresh on slower disks? The cap is fixed for this design; no latency measurement was requested.

## User Stories

### P1: Show live orchestrator tokens

**User story**: As a person using `codedeck open`, I want the statusline token count to include the orchestrator so that `tok` and `run $` describe the same run.

**Why P1**: The orchestrator can account for most of a run's usage, but the current statusline displays only worker tokens.

**Acceptance criteria**:

1. **LIVE-01**: WHEN the Claude statusline receives a valid `session_id` and a non-empty `transcript_path` THEN it SHALL pass both values in the same `codedeck usage <run-id> --json` invocation.
2. **LIVE-02**: WHEN the usage CLI receives `--transcript <native-id>=<path>` THEN it SHALL forward the native id and path in the `usage.get` request, preserving every path character after the first `=`.
3. **LIVE-03**: WHEN the daemon validates a transcript observation THEN it SHALL resolve the real path of `~/.claude/projects` and the supplied path, require the supplied path's resolved target to be a descendant of the resolved projects root, require the resolved basename `<native-id>.jsonl`, and require a regular file. Symlink components are allowed when the resolved target passes these checks.
4. **LIVE-04**: IF the transcript parameter has the wrong shape, transcript path validation fails, or open fails THEN the daemon SHALL skip transcript reading and leave the in-memory cursor map and transcript token observations unchanged. A valid cost observation in the same request remains eligible for recording.
5. **LIVE-05**: IF a request contains cost and transcript observations with different native ids THEN the daemon SHALL reject the transcript observation and still apply the valid cost observation.
6. **LIVE-06**: WHEN the daemon reads a transcript for one native id during a `usage.get` request THEN it SHALL consume no more than 1,048,576 new transcript bytes for that native id.
7. **LIVE-07**: WHEN the read cap is reached before end of file THEN the reader SHALL retain the byte offset and parser continuation state in daemon memory, including an incomplete trailing line or the oversize-line skip flag, return totals for complete lines processed so far, and resume at that offset on the next request. After a daemon restart, it begins at byte zero; the usage ledger SHALL ignore lower partial observations until each reread field passes its high-water mark.
8. **LIVE-08**: WHEN an assistant usage line has both `message.id` and `requestId` THEN the reader SHALL add its token usage only once per native id while its in-memory state is live, including when a duplicate appears in a later read batch.
9. **LIVE-09**: WHEN a transcript batch is accepted THEN the daemon SHALL submit its cumulative token totals through `UsageLedger.observe` and advance the in-memory cursor only after the ledger transaction commits. If the transaction fails, it SHALL retain the prior cursor so the next request rereads the bytes.
10. **LIVE-10**: WHEN the transcript file's device or inode changes, or its size falls below the saved offset, THEN the reader SHALL reset the offset, pending line, and oversize-line skip state while preserving cumulative totals and seen message keys.
11. **LIVE-11**: IF `CODEDECK_RUN_ID` is set and the run summary is unavailable THEN the statusline SHALL omit `tok` instead of showing the current `context_window` token snapshot.
12. **LIVE-12**: WHEN live transcript tokens and release-time transcript tokens are observed for the same native id THEN the system SHALL use the same `claude-open:<native-id>` source and retain each field's highest cumulative value, attributing only a positive difference above its high-water mark.
13. **LIVE-13**: WHEN the usage CLI returns a run summary with finite, non-negative `totalTokens` values for both the worker and orchestrator THEN the Claude statusline SHALL render `<T> tok` from `summary.totalTokens + summary.orchestrator.totalTokens`. IF either value is absent, nonnumeric, non-finite, or negative THEN it SHALL omit `tok` for that refresh.
14. **LIVE-14**: IF the usage CLI fails or reaches its one-second timeout THEN the statusline SHALL render the remaining valid local fields and exit with status 0.
15. **LIVE-15**: WHEN a `usage.get` request links a native id that has earlier unreconciled ids THEN the daemon SHALL return the live request without waiting for full transcript reads of those earlier ids.

**Independent test**: Feed the statusline a fixture payload with `session_id` and `transcript_path`, then serve a fixture transcript in chunks. Verify the returned statusline total includes worker and orchestrator `totalTokens`, a repeated assistant line in a later chunk contributes once, an oversized partial line is dropped through its next newline, and a timed-out or malformed active-run query omits `tok` instead of falling back to the smaller context snapshot. Verify invalid worker or orchestrator `totalTokens` values omit `tok`, while a statusline without `CODEDECK_RUN_ID` retains its local token fallback. Reconcile a `cost-state` fixture whose input total is below the live input total and whose output total is above the live output total; verify the ledger retains the per-field maxima and adds only the output difference. Also verify an in-root symlink resolving to the expected transcript is accepted, a path resolving outside the root is rejected, malformed transcript parameters and path rejection preserve a valid cost observation, a malformed cost observation returns `INVALID` without processing a valid transcript parameter, mismatched native ids reject transcript ingestion, a device/inode change resets the cursor while preserving totals and seen keys, a daemon restart rereads from byte zero without lowering displayed totals, a failed ledger observation leaves the in-memory cursor unchanged, post-release requests skip transcript ingestion, in-flight ingestion is serialized before cleanup, every linked id is cleaned after successful reconciliation only when no active row uses it, failed reconciliation retains all cursors, and earlier full transcript reads do not block the live request.

## Edge cases

- An absent or empty `transcript_path` leaves the stored run summary in place.
- An incomplete final JSONL line remains pending up to 4 MiB. If it exceeds the cap, the reader drops the fragment and skips through its next newline.
- A complete invalid JSON line is skipped and advances the byte offset.
- Paths outside the resolved projects root, paths whose resolved basename does not match the native id, and non-regular files are rejected. A symlink path is accepted only when its resolved target passes the same checks.
- A first read larger than the byte cap returns totals for processed complete lines; later refreshes continue from the in-memory offset.
- After a daemon restart, the in-memory cursor begins at zero. A 30 MB transcript takes about one minute of two-second refreshes to reread. The persisted ledger keeps the displayed total from dropping while partial totals catch up.
- A same-device, same-inode rewrite whose size remains at least the saved offset is not detected by the stat checks.
- Replaying a partial batch after a failed ledger observation starts from the prior in-memory offset and does not skip unread bytes.
- A malformed present `observe` parameter keeps the existing strict `INVALID` response and prevents transcript processing in that request.
- Live transcript ingestion runs only for active Claude `open` rows. Recheck row status inside the per-native-id serializer so a post-release request skips ingestion and an in-flight read finishes before cleanup.
- After a successful full release reconciliation, consider cleanup for every id linked to that released session. If any reconciliation step fails, retain all cursors, including ids reconciled earlier in the pass.

## Coverage matrix

These are the focused implementation test targets. They are not run as part of this documentation change.

| Code layer | Test type | Test file | Scoped Vitest command |
| --- | --- | --- | --- |
| Statusline script | Integration: invocation arguments, token rendering, timeout and invalid-total fallback | `tests/statusline.test.ts`, `tests/usage-statusline-contract.test.ts` | `npx vitest run tests/statusline.test.ts tests/usage-statusline-contract.test.ts` |
| Usage CLI | Integration: option parsing and IPC request contract | `tests/usage-cli.test.ts` | `npx vitest run tests/usage-cli.test.ts` |
| IPC protocol | Type and request contract through the usage CLI and daemon seam | `tests/usage-cli.test.ts`, `tests/orchestrator-usage-daemon.test.ts` | `npx vitest run tests/usage-cli.test.ts tests/orchestrator-usage-daemon.test.ts` |
| Daemon | Integration: path validation, chunk ingestion, live-to-release high-water reconciliation, reset, and failure behavior | `tests/orchestrator-usage-daemon.test.ts` | `npx vitest run tests/orchestrator-usage-daemon.test.ts` |
| Usage ledger | Integration: per-field high-water attribution | `tests/usage-ledger.test.ts` | `npx vitest run tests/usage-ledger.test.ts` |
| Incremental transcript reader | Unit: byte boundaries, partial-line cap, token mapping, and dedupe | `tests/claude-transcript.test.ts` | `npx vitest run tests/claude-transcript.test.ts` |

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| LIVE-01 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-02 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-03 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-04 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-05 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-06 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-07 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-08 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-09 | P1: Show live orchestrator tokens | Design, Tasks | Pending, rewritten for in-memory cursor ordering |
| LIVE-10 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-11 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-12 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-13 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-14 | P1: Show live orchestrator tokens | Design, Tasks | Pending |
| LIVE-15 | P1: Show live orchestrator tokens | Design, Tasks | Pending |

**Coverage**: 15 total, all 15 mapped to Design and Tasks. LIVE-09 keeps its ID with the in-memory equivalent; no acceptance-criterion IDs were removed.

## Success criteria

- [ ] With a fixture transcript and no workers, the statusline shows the orchestrator's cumulative `totalTokens` instead of `0 tok`.
- [ ] With workers and an orchestrator, the displayed token total equals worker `totalTokens` plus orchestrator `totalTokens`, with cached tokens counted once.
- [ ] Replaying a transcript chunk, restarting the daemon, or reconciling at release never lowers totals or counts a keyed assistant usage record twice.
- [ ] Every `usage.get` transcript read consumes no more than 1,048,576 new bytes per native id.
- [ ] A timeout during an active run never replaces the aggregate token total with the smaller local context-window snapshot.

## External dependencies

| Resource | Identifier | System | Verified | Evidence |
| --- | --- | --- | --- | --- |
| Claude statusline payload field | `transcript_path` | Claude Code | yes | [Official statusline documentation](https://code.claude.com/docs/en/statusline), "Available data" lists the field and the full JSON example includes it. |
| Claude transcript location | `~/.claude/projects/<project>/<session>.jsonl` | Claude Code | yes | [Official application-data documentation](https://code.claude.com/docs/en/claude-directory), which lists project transcripts below `projects/`. |
| Claude projects root | `~/.claude/projects` | Claude Code | yes | [Official application-data documentation](https://code.claude.com/docs/en/claude-directory), which lists transcripts at `projects/<project>/<session>.jsonl`. |
| Claude live run id environment | `CODEDECK_RUN_ID` | repo | yes | `src/cli/commands/open.ts:924-934` passes the run id to Claude. |
