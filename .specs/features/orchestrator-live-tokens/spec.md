# Orchestrator live tokens specification

## Problem Statement

In `codedeck open`, the Claude statusline shows worker tokens but omits the orchestrator's tokens. A run with no workers can therefore show `0 tok` while its cost already includes the orchestrator. The statusline cannot use `context_window.total_*_tokens` as a session total because Claude Code reports the current context window there, so this feature reads the session transcript incrementally and adds its cumulative token usage to the run summary.

The current statusline submits cost through `codedeck usage` and has a one-second command timeout, but it does not submit `transcript_path` or read transcript tokens (`plugin/statusline.sh:180-225`). Its aggregate token field sums workers only (`plugin/statusline.sh:248-256`). The existing transcript reader streams the full file at release and keeps message dedupe keys only in memory for that read (`src/core/claude-transcript.ts:88-167`).

## Relationship to existing specifications

This feature extends `.specs/features/orchestrator-usage/spec.md`. It replaces that spec's "Live orchestrator token counts" out-of-scope entry. It also replaces the token-source clause in `.specs/features/run-usage-statusline/spec.md` acceptance criterion 5, which sources orchestrator tokens from the local context window, and the worker-only token total in acceptance criterion 9. When `CODEDECK_RUN_ID` is set but the run query is unavailable, it replaces the local-token fallback in criterion 9 and the fallback in criterion 11. When `CODEDECK_RUN_ID` is absent, the local-token fallback remains. The cost value still comes from `payload.cost.total_cost_usd`; `.specs/features/orchestrator-usage/spec.md` defines its storage and attribution. Other requirements in those specifications remain in force.

## Goals

- [ ] Show cumulative worker and orchestrator tokens in the Claude `open` statusline.
- [ ] Read only a bounded amount of new transcript data per refresh and continue later without losing or double-counting token observations.
- [ ] Keep live transcript tokens and release-time transcript reconciliation on the same per-native-session high-water ledger.

## Out of Scope

| Feature | Reason |
| --- | --- |
| An input, output, or cache breakdown on the statusline | The agreed display is one total token count. |
| Live tokens in statuslines for Codex, OpenCode, or OMP | This feature covers the Claude orchestrator started by `codedeck open`. |
| Replacing transcript totals with `context_window` token values | Those values describe the current context window, not the cumulative session. |

## Assumptions & Open Questions

| Assumption or decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Run summary token fields | The parallel usage-summary change provides `totalTokens` for workers and `orchestrator`, counting cached tokens once according to the harness rule. | The statusline must consume the agreed aggregate instead of recalculating it from overlapping fields. | yes, per the feature briefing |
| Transcript read cap | Read at most 1,048,576 new bytes per native id per `usage.get` request. Keep the cursor and continue on the next refresh. | A fixed byte bound limits work under the statusline's one-second timeout. The first read may span multiple two-second refreshes. | no, proposed for spec approval |
| Rejected transcript path | Skip transcript reading and leave its cursor and token observations unchanged. A valid cost observation in the same request remains eligible for recording. | The path is an input from another process. Rejecting it must not suppress the existing cost path or make the statusline fail. | no, proposed for spec approval |

Rows marked "no" are draft choices for review with this specification.

**Open questions:**

1. Should the daemon accept transcript paths under a non-default `CLAUDE_CONFIG_DIR` projects directory? This specification accepts only the resolved `~/.claude/projects` root; other roots are rejected until the supported configuration root is decided.
2. Which minimum Claude Code version must CodeDeck support for `transcript_path`? The current official statusline documentation lists the field but does not state its first supported version. If the field is absent, this feature skips live transcript reads and keeps the last stored total.
3. If a transcript is rewritten to a shorter file and an assistant usage line lacks either `message.id` or `requestId`, should the reader add a fallback dedupe key? The existing reader deduplicates only when both fields are present. This feature preserves that rule.
4. Is the proposed 1,048,576-byte per-refresh cap sufficient on slower disks? The cap is fixed in this draft, and subsequent refreshes continue the same transcript if the first read is incomplete.
5. What maximum size should the reader allow for a partial JSONL line? The byte cap bounds new file reads, but a line without a newline can span several refreshes.
6. How should cursor and dedupe rows be pruned after release reconciliation and transcript cleanup?
7. Should the cursor detect an in-place transcript rewrite that keeps the same file identity and has a size at least as large as the saved offset? This draft detects a changed device/inode or a size below the offset.

## User Stories

### P1: Show live orchestrator tokens

**User story**: As a person using `codedeck open`, I want the statusline token count to include the orchestrator so that `tok` and `run $` describe the same run.

**Why P1**: The orchestrator can account for most of a run's usage, but the current statusline displays only worker tokens.

**Acceptance criteria**:

1. **LIVE-01**: WHEN the Claude statusline receives a valid `session_id` and a non-empty `transcript_path` THEN it SHALL pass both values in the same `codedeck usage <run-id> --json` invocation.
2. **LIVE-02**: WHEN the usage CLI receives `--transcript <native-id>=<path>` THEN it SHALL forward the native id and path in the `usage.get` request.
3. **LIVE-03**: WHEN the daemon opens a transcript observation THEN it SHALL require the canonical file path to be under the resolved `~/.claude/projects/<project>/` directory, require the basename `<native-id>.jsonl`, reject any symlink component below the resolved projects root, open the validated file without following symlinks, verify with `fstat` that the opened regular file has the validated device and inode, and read from that same file handle.
4. **LIVE-04**: IF transcript path validation or open-file verification fails THEN the daemon SHALL skip transcript reading and leave the transcript cursor and token observations unchanged.
5. **LIVE-05**: IF a request contains cost and transcript observations with different native ids THEN the daemon SHALL reject the transcript observation and still apply the valid cost observation.
6. **LIVE-06**: WHEN the daemon reads a transcript for one native id during a `usage.get` request THEN the transcript reader SHALL consume no more than 1,048,576 new transcript bytes for that native id.
7. **LIVE-07**: WHEN the read cap is reached before end of file THEN the reader SHALL persist the byte offset and incomplete trailing line, return totals for complete lines processed so far, and resume at that offset on the next request.
8. **LIVE-08**: WHEN an assistant usage line has both `message.id` and `requestId` THEN the reader SHALL add its token usage only once per native id, including when a duplicate appears in a later read batch.
9. **LIVE-09**: WHEN a transcript batch is accepted THEN the daemon SHALL commit its cursor, dedupe keys, cumulative totals, and usage-ledger observation in one SQLite transaction.
10. **LIVE-10**: WHEN the transcript file's device or inode changes, or its size falls below the saved offset, THEN the reader SHALL reset the offset and pending line while preserving cumulative totals and seen message keys.
11. **LIVE-11**: IF `CODEDECK_RUN_ID` is set and the run summary is unavailable THEN the statusline SHALL omit `tok` instead of showing the current `context_window` token snapshot.
12. **LIVE-12**: WHEN live transcript tokens and release-time transcript tokens are observed for the same native id THEN the system SHALL use the same `claude-open:<native-id>` source and retain each field's highest cumulative value, attributing only a positive difference above its high-water mark.
13. **LIVE-13**: WHEN the usage CLI returns a run summary THEN the Claude statusline SHALL render `<T> tok` from `summary.totalTokens + summary.orchestrator.totalTokens`.
14. **LIVE-14**: IF the usage CLI fails or reaches its one-second timeout THEN the statusline SHALL render the remaining valid local fields and exit with status 0.
15. **LIVE-15**: WHEN a `usage.get` request links a native id that has earlier unreconciled ids THEN the daemon SHALL return the live request without waiting for full transcript reads of those earlier ids.

**Independent test**: Feed the statusline a fixture payload with `session_id` and `transcript_path`, then serve a fixture transcript in chunks. Verify the returned statusline total includes worker and orchestrator `totalTokens`, a repeated assistant line in a later chunk contributes once, a timed-out active-run query omits `tok` rather than falling back to the smaller context snapshot, and a statusline without `CODEDECK_RUN_ID` retains its local token fallback. Reconcile a `cost-state` fixture whose input total is below the live input total and whose output total is above the live output total; verify the ledger retains the per-field maxima and adds only the output difference. Also verify path rejection, including a symlink component, preserves a valid cost observation; mismatched native ids reject transcript ingestion; a device/inode change resets the offset and pending line while preserving totals and seen keys; and earlier full transcript reads do not block the live request.

## Edge cases

- An absent or empty `transcript_path` leaves the stored run summary in place.
- An incomplete final JSONL line remains pending until a later read supplies its newline.
- A complete invalid JSON line is skipped and advances the byte offset.
- Paths outside the projects directory, paths with a symlink component below that root, non-regular files, and filenames that do not match the native id are rejected by LIVE-03 and LIVE-04.
- A first read larger than the byte cap returns the totals for processed complete lines; later refreshes continue from the saved offset.

## Coverage matrix

These are the focused implementation test targets. They are not run as part of this documentation change.

| Code layer | Test type | Test file | Scoped Vitest command |
| --- | --- | --- | --- |
| Statusline script | Statusline invocation and rendering contract | `tests/statusline.test.ts` | `npm test -- tests/statusline.test.ts` |
| CLI usage command | CLI option parsing and IPC request contract | `tests/usage-cli.test.ts` | `npm test -- tests/usage-cli.test.ts` |
| IPC protocol | `usage.get` request shape and daemon contract | `tests/orchestrator-usage-daemon.test.ts` | `npm test -- tests/orchestrator-usage-daemon.test.ts` |
| Daemon | Path validation, chunk ingestion, and failure behavior | `tests/orchestrator-usage-daemon.test.ts` | `npm test -- tests/orchestrator-usage-daemon.test.ts` |
| Ledger and store | Per-field high-water and atomic persistence | `tests/usage-ledger.test.ts` | `npm test -- tests/usage-ledger.test.ts` |
| Transcript reader | Incremental byte bound, partial lines, file resets, and persistent dedupe | `tests/claude-transcript.test.ts` | `npm test -- tests/claude-transcript.test.ts` |

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| LIVE-01 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-02 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-03 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-04 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-05 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-06 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-07 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-08 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-09 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-10 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-11 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-12 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-13 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-14 | P1: Show live orchestrator tokens | Design | Pending |
| LIVE-15 | P1: Show live orchestrator tokens | Design | Pending |

**Coverage**: 15 total, 15 mapped to Design, 15 unmapped to Tasks. `tasks.md` is intentionally not created before spec approval.

## Success Criteria

- [ ] With a fixture transcript and no workers, the statusline shows the orchestrator's cumulative `totalTokens` instead of `0 tok`.
- [ ] With workers and an orchestrator, the displayed token total equals worker `totalTokens` plus orchestrator `totalTokens`, with cached tokens counted once.
- [ ] Replaying a transcript chunk, resuming the same native id, or reconciling at release never lowers totals or counts a keyed assistant usage record twice.
- [ ] Every `usage.get` transcript read consumes no more than 1,048,576 new bytes per native id.
- [ ] A timeout during an active run never replaces the aggregate token total with the smaller local context-window snapshot.

## External Dependencies

| Resource | Identifier | System | Verified | Evidence |
| --- | --- | --- | --- | --- |
| Claude statusline payload field | transcript_path | Claude Code | yes | [Official statusline documentation](https://code.claude.com/docs/en/statusline), "Available data" lists `transcript_path` and the full JSON example includes it. The installed CLI reports version 2.1.280. |
| Claude transcript location | ~/.claude/projects/<project>/<session>.jsonl | Claude Code | yes | [Official application-data documentation](https://code.claude.com/docs/en/claude-directory), which lists this project transcript path. |
| Claude projects root | ~/.claude/projects | Claude Code | yes | [Official application-data documentation](https://code.claude.com/docs/en/claude-directory), which lists project transcripts below `projects/`. |
| Claude configuration root override | CLAUDE_CONFIG_DIR | Claude Code | yes | [Official .claude directory documentation](https://code.claude.com/docs/en/claude-directory), which states that `~/.claude` paths move under this directory when it is set. |
| Project transcript directory | ~/.claude/projects/<project>/ | Claude Code | yes | [Official application-data documentation](https://code.claude.com/docs/en/claude-directory), which lists transcripts at `projects/<project>/<session>.jsonl`. |
| Claude live run id environment | CODEDECK_RUN_ID | repo | yes | `src/cli/commands/open.ts:756` passes the run id to a launched harness. |
| Claude release transcript record | cost-state | Claude Code 2.1.280 | yes | Observed in `~/.claude/projects/-home-andreello-dev-splitc-backend/1db0600a-cf9e-41c7-bbeb-86ebd6bd2a84.jsonl`, lines 1654, 1655, and 1798. |
