# Orchestrator usage and usage ledger Specification

## Problem Statement

`codedeck usage` reports only worker sessions. The Claude orchestrator launched by `codedeck open`, which is almost all of the user's spend, never gets usage: every `origin='open'` row has an empty usage value, while the orchestrator transcripts hold about US$ 1,470 of reported cost. The same single-value-per-row model also drops earlier Claude worker processes after `send` (US$ 48.80 over 10 sessions), bills Codex cached tokens twice (US$ 7,428 shown where the no-double-count upper bound is US$ 3,830), and marks every run incomplete because the orchestrator row itself has no cost.

## Current state

Counts below were captured on 2026-09-22 between 20:40 and 21:10 UTC from `~/.run-agent/run-agent.db` and the transcript directories. They drift as new sessions run; the fixtures named in the acceptance tests are the stable reference.

1. Usage enters the store only as `usage.updated` events that a driver parser emits from a worker's stream. The daemon either replaces the row's value or, when `incremental` is true, adds to it (`src/daemon/daemon.ts:1316`). One row holds one value (`sessions.usage_*`, `src/store/database.ts:62-65`).
2. `codedeck open` runs Claude interactively under a pty, so no parser sees its stream. `session.adopt` creates the orchestrator row with `origin='open'` and `runId` equal to its own id (`src/daemon/daemon.ts:428`, `:460`). `open` exports that same id as `CODEDECK_RUN_ID` to the Claude process (`src/cli/commands/open.ts:595`, `:839`). No code path writes usage to that row.
3. The SessionStart hook overwrites a single sidecar file with the latest native id (`plugin/hooks/session-id.sh:23`). `open` reads it only at exit (`src/cli/commands/open.ts:572`, `:818`; `src/open/runtime.ts:243`, `:369`). At capture time: 132 `open` rows (99 Claude), 31 of the Claude rows with `native_session_id`, none of the 44 `interrupted` and 8 `working` Claude rows with one, and 70 unread sidecars in `~/.run-agent/sessions/`.
4. One `open` process can pass through several native ids (`/clear`, resume): pid 3595879 left 6 distinct `.name` sidecars. One native id can also appear in several `open` processes, because resume keeps the id: `55f4307e-...` appears under 4 pids.
5. `usage.get` aggregates every row with the run id, including the orchestrator row (`src/store/sessions.ts:197`, `src/core/run-usage.ts:56`). A run with no workers returns `sessionCount: 1, costComplete: false, sessionsWithoutCost: 1` (observed on run `5d81` before its first worker).
6. Worker rows created by `codedeck run` have `origin` NULL (`src/store/sessions.ts:56`; observed on row `d7d6`).
7. `plugin/statusline.sh:175-240` shows local cost (`payload.cost.total_cost_usd`) plus the run's cost, requires `usage.runId` to equal its `CODEDECK_RUN_ID` (`plugin/statusline.sh:191`), and never persists the local value.
8. Codex `cached_input_tokens` is a subset of `input_tokens`, and `computeSessionCost` bills both (`src/core/pricing.ts:160-164`). `gpt-5.6-luna` declares no cached price (`src/core/pricing.ts:20`). `queryUsage` prices rows at query time from stored tokens (`src/store/sessions.ts:350`), so a formula change reprices history.
9. Claude worker `send` starts a new `claude -p --resume` process whose `total_cost_usd` restarts at zero. The daemon replaces the value, so earlier processes are lost.
10. The daemon gives workers `CODEDECK_SESSION_ID` but never `CODEDECK_RUN_ID` (`src/drivers/session-runtime.ts:141`), so a worker that dispatches another worker creates an unlinked row (36 rows on 2026-09-22, almost all reviewers).

## Supersedes

This spec replaces these parts of `.specs/features/run-usage-statusline/spec.md`. The rest of that spec stays in force.

| Old text | Replaced by |
| --- | --- |
| AC 1 acceptance test: "`open` must not create a session row in the store" | Already false since `session.adopt`. The `open` row stays (ORCH-*). |
| Design decision 1: "`open` does not create a row in `sessions`" | Already false since `session.adopt`. This spec keeps the row and makes it the orchestrator's usage owner (ORCH-*). |
| AC 2 and design decision 5: output contains exactly eight properties | RUN-01 to RUN-04: the existing properties keep their meaning, and `orchestrator` and `total` objects are added. |
| AC 5: the statusline "cannot write the orchestrator into the store" | ORCH-04: the statusline reports the live orchestrator cost. RUN-06 counts each orchestrator source once. |
| Design decision 4: `cachedTokens * cached` added to input for every harness | PRICE-01 for harnesses whose cached tokens are part of input. |

## Goals

- [ ] `codedeck usage --all` includes orchestrator cost for every Claude `open` session whose transcript can be found, split from worker cost.
- [ ] `codedeck usage <run-id> --json` reports workers and orchestrator as separate figures, and a run with no workers reports `costComplete: true`.
- [ ] Stored usage for Codex and Claude-after-send matches the harness's own cumulative figures on the fixtures in this spec.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Orchestrator usage for `open` on codex or opencode | 2 and 31 rows. Each needs its own transcript reader. Separate feature. |
| Usage in the web UI or the agents pane | No consumer there today. This feature fixes the data, not the surfaces. |
| New price values for models missing from the table (for example `claude-opus-5-5`) | Price facts are the user's call. The orchestrator path uses reported cost, so it does not need them. |
| Antigravity live usage between steps | The final `result` total is already correct. Only the mid-run value is off. |
| Rewriting historical Claude worker rows lost to `send` | US$ 48.80 total. New sessions are fixed. History is not recomputed. |
| Changing the `codedeck usage` table layout beyond the origin grouping | Presentation is not the problem. |
| Transcripts outside `~/.claude/projects` | Not observed on this machine and not used anywhere in the repo. |
| Live orchestrator token counts | The statusline payload carries cumulative cost only. Tokens arrive at release (ORCH-06). |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Cached price for `gpt-5.6-luna` | No cached price is added. Cached tokens are billed once, at the input price. | The table has no value. Removing the double count is correct regardless of the discount. | y (user "ok", 2026-09-22) |
| Historical orchestrator backfill granularity | Legacy orchestrator usage keyed by native id, not linked to an `open` row | Linking by cwd and time can misattribute. The user needs the total. | y (user "ok", 2026-09-22) |
| Live orchestrator cost source | The statusline reports `payload.cost.total_cost_usd` for `payload.session_id` | `cost-state` is written only when a session ends. The statusline value comes from the same ledger (see External Dependencies). | y |
| Authoritative orchestrator usage at end | Last `cost-state` line of the native transcript | It carries cost and per-model tokens and survives resume in the same id. | y |
| Correlation key from hook and statusline to the `open` row | `CODEDECK_RUN_ID` from the environment, which equals the `open` row id | Both processes inherit the Claude environment that `open` sets. | y |
| Transcript location | `~/.claude/projects/*/<native-id>.jsonl`, found by file name | The slug derivation is Claude Code internal. | y |
| Token fallback when no `cost-state` exists | Sum `message.usage` of `assistant` lines deduplicated by `message.id` + `requestId` | 5 of 84 found transcripts lack `cost-state`, and 310 of 520 assistant lines repeat in `1db0600a`. | y |
| Rows with NULL `origin` | Counted as workers | `codedeck run` never sets `origin`. | y |
| Codex history | Repriced on the next query by PRICE-01, with no migration | Cost is computed from stored tokens at query time. | y |

**Open questions:** none.

---

## Usage model

These definitions make the criteria below testable. They describe stored and query-visible data, not an implementation.

- A **source** is one cumulative counter reported by a harness. Its key is fixed per harness:

  | Harness path | Source key | The reported value is |
  | --- | --- | --- |
  | Claude worker (`claude -p`) | native session id + process ordinal within the CodeDeck session (1 for the first process, 2 after the first `send`, and so on) | cumulative for that process |
  | Codex worker | thread id (`nativeSessionId`) | cumulative for the thread |
  | Antigravity and OMP workers | CodeDeck session id | cumulative for the session, final value wins |
  | opencode worker | none, each event is a delta added to the row | a delta |
  | Claude `open` orchestrator | native session id | cumulative for the native session across resumes |

- Each source has one **high-water mark** per field (cost and each token field): the highest cumulative value observed for it on any row.
- WHEN a row observes a source value above the high-water mark, the difference is added to that row's **attributed usage** for the source and the mark moves to the new value. An observation at or below the mark changes nothing.
- A row's usage is the sum of its attributed usage over its sources, plus opencode deltas. The sum of attributed usage over all rows for one source therefore equals the source's high-water mark.
- Known limit: if two live `open` processes resume the same native id at the same time, each process keeps its own ledger, and the smaller increases can be missed. The total is never counted twice.

Worked example for one native id `X` observed by two `open` rows, used by ORCH-13 to ORCH-15:

| Step | Event | High-water of `X` | Row A attributed | Row B attributed | Sum of rows |
| --- | --- | --- | --- | --- | --- |
| 1 | A links `X`, statusline reports 4.00 | 4.00 | 4.00 | - | 4.00 |
| 2 | statusline reports 3.50 (out of order) | 4.00 | 4.00 | - | 4.00 |
| 3 | A released, `cost-state` says 10.00 | 10.00 | 10.00 | - | 10.00 |
| 4 | B resumes `X`, statusline reports 10.00 | 10.00 | 10.00 | 0.00 | 10.00 |
| 5 | B statusline reports 12.00 | 12.00 | 10.00 | 2.00 | 12.00 |
| 6 | B released, `cost-state` says 15.00 | 15.00 | 10.00 | 5.00 | 15.00 |

---

## User Stories

### P1: Orchestrator usage is captured ⭐ MVP

**User Story**: As the person driving `codedeck open`, I want the orchestrator's cost recorded so that `codedeck usage` shows where most of my spend goes.

**Why P1**: The orchestrator is almost all of the spend and is invisible today.

**Acceptance Criteria**:

1. ORCH-01: WHEN the SessionStart hook runs with a native session id and a `CODEDECK_RUN_ID` THEN the system SHALL link that native id to the row whose id equals `CODEDECK_RUN_ID` within 3 seconds.
2. ORCH-02: IF the daemon does not answer THEN the SessionStart hook SHALL exit within 500 ms and SHALL still write the sidecar as it does today.
3. ORCH-03: WHEN a second distinct native id starts inside the same `open` process THEN the system SHALL keep both native ids linked to that row.
4. ORCH-04: WHEN the statusline renders a payload with a finite, non-negative `cost.total_cost_usd`, a `session_id` and a `CODEDECK_RUN_ID` THEN the system SHALL record that value as an observation of source `session_id` on row `CODEDECK_RUN_ID`.
5. ORCH-05: WHEN a Claude `open` row is released THEN the system SHALL record the `totalCostUSD` of the last `cost-state` line of each linked transcript as an observation of that native id.
6. ORCH-06: WHEN a Claude `open` row is released THEN the system SHALL record the per-model `inputTokens`, `outputTokens`, `cacheReadInputTokens` and `cacheCreationInputTokens` of that `cost-state` line as a token observation of that native id.
7. ORCH-07: WHEN the daemon starts THEN the system SHALL apply ORCH-05 and ORCH-06 to every Claude `open` row whose status is `interrupted`, or `working` with a dead pid, and that has linked native ids.
8. ORCH-08: IF a linked transcript has no `cost-state` line THEN the system SHALL record as token observation the sum of `message.usage` over `assistant` lines deduplicated by `message.id` + `requestId`.
9. ORCH-09: WHEN ORCH-08 produced the token observation and the model has a price in the static table THEN the system SHALL record the priced tokens as the cost observation.
10. ORCH-10: IF ORCH-08 produced the token observation and the model has no price THEN the system SHALL count the row as without cost in `sessionsWithoutCost`.
11. ORCH-11: IF no transcript file exists for a linked native id THEN the system SHALL count the row as without cost.
12. ORCH-12: IF no transcript file exists for a linked native id THEN `session.release` SHALL still set the row to the status the caller requested (`completed` or `failed`).
13. ORCH-13: WHEN an observation is lower than or equal to the source's high-water mark THEN the system SHALL leave every row's attributed usage unchanged.
14. ORCH-14: WHEN a row observes a value above the source's high-water mark THEN the system SHALL add the difference to that row's attributed usage.
15. ORCH-15: The sum of attributed cost over all rows for one native id SHALL equal that native id's high-water mark.
16. ORCH-16: WHEN a new native id links to a row that already has a linked native id THEN the system SHALL apply ORCH-05 and ORCH-06 to the previously linked native ids.

**Independent Test**: replay the worked example in "Usage model" with fixture transcripts and statusline payloads, then assert row A attributed 10.00, row B attributed 5.00, and `codedeck usage --all --json` orchestrator cost 15.00. Separately, link id `Y` to a row that holds id `X` with a fixture `cost-state` of 3.00 and assert `X` is attributed 3.00 before the row is released.

---

### P1: Run totals split orchestrator and workers ⭐ MVP

**User Story**: As the user reading the statusline, I want the run cost split into orchestrator and workers so the "?" marker means something.

**Why P1**: Today the orchestrator row alone makes every run incomplete.

**Acceptance Criteria**:

1. RUN-01: The `usage.get` result SHALL keep `runId` equal to the requested run id.
2. RUN-02: The `usage.get` result SHALL compute `inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`, `sessionCount`, `activeSessionCount`, `costComplete` and `sessionsWithoutCost` over worker rows only, where a worker row has that `run_id` and an `origin` that is NULL or different from `open`.
3. RUN-03: The `usage.get` result SHALL include an `orchestrator` object with `costUsd`, `costComplete`, `inputTokens`, `outputTokens` and `cachedTokens` computed over the `open` rows of that run.
4. RUN-04: The `usage.get` result SHALL include a `total` object whose `costUsd` equals top-level `costUsd` plus `orchestrator.costUsd`.
5. RUN-05: WHEN a run has no worker rows THEN `usage.get` SHALL return `sessionCount: 0` and `costComplete: true` at the top level.
6. RUN-06: WHEN the statusline obtains run usage THEN the `run $` figure SHALL equal top-level worker `costUsd`, plus the orchestrator attributed cost of every source other than `payload.session_id`, plus the payload's `cost.total_cost_usd`.
7. RUN-07: IF the statusline cannot obtain run usage THEN it SHALL show the local payload cost without a `run $` figure, as today.
8. RUN-08: The aggregate `codedeck usage` totals SHALL include orchestrator cost.
9. RUN-09: WHEN `codedeck usage --by origin --json` runs THEN the result SHALL contain a `byOrigin` array with one bucket keyed `orchestrator` for `open` rows and one keyed `worker` for all other rows.

**Independent Test**: seed run `r1` with one `open` row whose source `X` is attributed 3.00 and source `Y` 0.80, and two NULL-origin workers with 0.30 and 0.20. Assert `usage.get` returns `runId: "r1"`, top-level `costUsd` 0.50 and `sessionCount` 2, `orchestrator.costUsd` 3.80 and `total.costUsd` 4.30. Assert the statusline with `session_id` `Y` and payload cost 1.00 renders `run $4.50`, and with the daemon stopped renders `$1.00` and no `run`.

---

### P1: Usage accumulates per source ⭐ MVP

**User Story**: As the user, I want each harness's cumulative counter stored once per source so later turns do not erase earlier ones and nothing is counted twice.

**Why P1**: The same model fixes the orchestrator's multiple native ids and the Claude `send` loss.

**Acceptance Criteria**:

1. SRC-01: WHEN a Claude worker's second process reports `total_cost_usd` THEN the row's cost SHALL equal the first process's last value plus the second process's last value.
2. SRC-02: WHEN a Codex `turn.completed` arrives for a thread already seen on the row THEN the row's tokens SHALL equal that event's values.
3. SRC-03: WHEN an opencode `incremental` event arrives THEN the row's usage SHALL increase by the event's values.
4. SRC-04: WHEN the daemon replays a log line whose events were already committed THEN the row's usage SHALL stay unchanged.

**Independent Test**: feed the events of session `2e99` (0.4661592 then 0.1616463 across two processes) and assert cost 0.6278055. Feed the two `turn.completed` events of Codex thread `01a0c9ee` and assert input 10,891,738 and cached 10,551,808.

---

### P1: Prices do not double count ⭐ MVP

**User Story**: As the user, I want Codex cost computed once per token so the worker figure is believable.

**Why P1**: The current `gpt-5.6-luna` figure is at least 94% inflated.

**Acceptance Criteria**:

1. PRICE-01: WHERE the harness reports cached tokens as part of input (Codex) the system SHALL compute cost as `((input - cached) * inputPrice + cached * cachedPrice + output * outputPrice) / 1,000,000`.
2. PRICE-02: IF a model has no cached price THEN the system SHALL use the input price for cached tokens.
3. PRICE-03: IF a Codex row has cached greater than input THEN the system SHALL count that row as without cost.
4. PRICE-04: WHERE the harness reports cached tokens separately from input (Claude, Antigravity) the system SHALL keep the formula `(input * inputPrice + output * outputPrice + cached * cachedPrice) / 1,000,000`.

**Independent Test**: price `gpt-5.6-luna` with input 1,000,000, cached 900,000 and output 0, and assert US$ 1.00, not US$ 1.90.

---

### P2: Nested dispatch stays in the run

**User Story**: As the user, I want a reviewer dispatched by a worker counted in my run.

**Why P2**: This is attribution. It does not change the grand total.

**Acceptance Criteria**:

1. RUN-10: WHEN the daemon spawns a worker whose row has a `run_id` THEN the worker's environment SHALL contain `CODEDECK_RUN_ID` equal to that `run_id`.
2. RUN-11: IF the worker's row has no `run_id` THEN the worker's environment SHALL NOT contain `CODEDECK_RUN_ID`.

**Independent Test**: spawn a worker for run `r1` with a stub harness that prints its environment and assert `CODEDECK_RUN_ID=r1`. Spawn a second worker with no `run_id` and assert the variable is absent.

---

### P2: Historical orchestrator backfill

**User Story**: As the user, I want the orchestrator cost I already spent imported once so the history is not empty.

**Why P2**: Useful, not needed for new sessions.

**Acceptance Criteria**:

1. BF-01: WHEN the backfill runs THEN the system SHALL collect native ids from `open` rows, from unread session sidecars and from `.name` sidecars in the sessions directory.
2. BF-02: IF a collected id is a worker row's `native_session_id` THEN the backfill SHALL skip it.
3. BF-03: IF a collected id already has a high-water mark THEN the backfill SHALL skip it.
4. BF-04: WHEN a remaining id's transcript has a `cost-state` line THEN the backfill SHALL store one legacy orchestrator entry with that line's cost and per-model tokens.
5. BF-05: The legacy entry SHALL appear in `codedeck usage --json` `byDay` under the date of the transcript's last timestamped line.
6. BF-06: The legacy entry SHALL appear in `codedeck usage --json` `byRepository` under the git root of the transcript's last `cwd` value.
7. BF-07: The legacy entry SHALL appear in the `orchestrator` bucket of RUN-09.
8. BF-08: WHEN the backfill runs a second time THEN `codedeck usage --all --json` totals SHALL be identical to those after the first run.

**Independent Test**: run the backfill twice over a fixture sessions directory with three ids, one of them a worker id, and assert two legacy entries, the expected `byDay` and `byRepository` keys, both entries inside the `orchestrator` bucket of `--by origin`, and identical totals after the second run.

---

## Edge Cases

- IF the statusline cannot reach the daemon within its existing 1 s budget THEN the statusline SHALL render the local line unchanged and exit 0.
- IF a transcript line is not valid JSON THEN the reader SHALL skip that line and continue.
- WHEN a transcript exceeds 50 MB THEN the reader SHALL read it without loading the whole file into memory.
- IF `CODEDECK_RUN_ID` names no existing row THEN the system SHALL drop the observation without creating a row.

---

## Implicit-requirement sweep

| Dimension | Resolution |
| --- | --- |
| Input validation & bounds | ORCH-04 accepts only finite, non-negative cost. PRICE-03 rejects cached greater than input. |
| Failure / partial failure | ORCH-02, ORCH-11, ORCH-12, RUN-07, and the statusline edge case. |
| Idempotency / duplicates | ORCH-13, SRC-04, BF-08. |
| Auth & rate limits | N/A because everything is local to one user over the existing local IPC. |
| Concurrency / ordering | ORCH-13 ignores out-of-order observations. ORCH-14 and ORCH-15 cover a native id shared by two rows. The Usage model states the limit for two simultaneous live processes on one id. |
| Data lifecycle | Sidecars are consumed as today. The backfill reads them and does not delete them. |
| Observability | N/A because the stored usage is itself the observable, read through `codedeck usage`. |
| External-dependency failure | ORCH-08 to ORCH-12 cover a missing or changed transcript. |
| State-transition integrity | ORCH-07 reads only `interrupted` rows or `working` rows with a dead pid at daemon start. |

---

## External Dependencies

| Resource | Identifier | System | Verified | Evidence |
| --- | --- | --- | --- | --- |
| Claude transcript cost line | "type":"cost-state" with totalCostUSD, modelUsage | Claude Code 2.1.280 | yes | observed in `~/.claude/projects/-home-andreello-dev-splitc-backend/1db0600a-cf9e-41c7-bbeb-86ebd6bd2a84.jsonl`, lines 1654, 1655, 1798 (final 23.55831195) |
| Transcript cost line type | cost-state | Claude Code 2.1.280 | yes | observed in the same transcript; the binary declares `"cost-state":"last-wins"` in its transcript metadata table |
| `cost-state` written only at session end | end-of-session write | Claude Code 2.1.280 | yes | observed: live transcript `b6b5fb85-...jsonl` had 410 lines and 0 `cost-state` at 21:05 UTC; 403 of 1,239 transcripts contain one |
| Statusline cost is the session cumulative ledger | statusline stdin payload | Claude Code 2.1.280 | yes | observed in the installed binary `~/.local/share/mise/installs/claude/2.1.280/claude`: the statusline payload builds `cost.total_cost_usd` from `em()`, `em()` returns `costLedger.totalCostUSD()`, and `nyt()` writes the same `em()` into `cost-state.totalCostUSD` |
| `/clear` saves then resets the cost ledger | conversation_reset | Claude Code 2.1.280 | yes | observed in the installed binary: the `conversation_reset` path calls `nRr(s)` (cost saver), then `$Me()` (`resetCostState`, `costLedger.reset(id)`), then `XTr` (`regenerateSessionId`); resume calls `aRr`, which runs `costLedger.restore` |
| SessionStart fires per native id change | hook stdin session_id | Claude Code 2.1.280 | yes | observed: 6 `.name` sidecars for pid 3595879 in `~/.run-agent/sessions/` |
| `claude -p` `total_cost_usd` restarts per process | result event | Claude Code 2.1.280 | yes | observed in events of session `2e99`: 0.4661592 (13 turns), then 0.1616463 (4 turns) |
| Codex `turn.completed` usage is the thread total | turn.completed.usage | codex exec | yes | observed in `~/.codex/sessions/2026/09/22/rollout-...-01a0c9ee-...jsonl`: turn 1 ends at 8,359,849 and turn 2 continues from it |
| Codex cached is a subset of input | cached_input_tokens | codex exec | yes | observed in the same rollout: input 8,359,849, cached 8,116,224 |
| Transcript root | ~/.claude/projects | Claude Code 2.1.280 | yes | observed: 1,239 .jsonl transcripts listed under it on 2026-09-22 |
| Transcript file per native id | ~/.claude/projects/*/<native-id>.jsonl | Claude Code 2.1.280 | yes | observed: 84 of 88 orchestrator native ids found by file name |
| Pricing formula | computeSessionCost | repo | yes | `src/core/pricing.ts:160` |
| Session sidecar directory | ~/.run-agent/sessions/ | repo | yes | `src/open/pty.ts:50` |
| CodeDeck store | ~/.run-agent/run-agent.db | repo | yes | `src/config/paths.ts` (`getPaths().db`) |
| Worker session env var | CODEDECK_SESSION_ID | repo | yes | `src/drivers/session-runtime.ts:141` |
| Run id env var | CODEDECK_RUN_ID | repo | yes | `src/cli/commands/run.ts:15`, `src/cli/commands/open.ts:839` |
| Unpriced model id | claude-opus-5-5 | repo | yes | `src/core/pricing.ts:30` (only `claude-opus-5` is listed) |

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| ORCH-01 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-02 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-03 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-04 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-05 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-06 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-07 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-08 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-09 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-10 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-11 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-12 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-13 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-14 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-15 | P1: Orchestrator usage is captured | Design | Pending |
| ORCH-16 | P1: Orchestrator usage is captured | Design | Pending |
| RUN-01 | P1: Run totals split | Design | Pending |
| RUN-02 | P1: Run totals split | Design | Pending |
| RUN-03 | P1: Run totals split | Design | Pending |
| RUN-04 | P1: Run totals split | Design | Pending |
| RUN-05 | P1: Run totals split | Design | Pending |
| RUN-06 | P1: Run totals split | Design | Pending |
| RUN-07 | P1: Run totals split | Design | Pending |
| RUN-08 | P1: Run totals split | Design | Pending |
| RUN-09 | P1: Run totals split | Design | Pending |
| SRC-01 | P1: Usage accumulates per source | Design | Pending |
| SRC-02 | P1: Usage accumulates per source | Design | Pending |
| SRC-03 | P1: Usage accumulates per source | Design | Pending |
| SRC-04 | P1: Usage accumulates per source | Design | Pending |
| PRICE-01 | P1: Prices do not double count | Design | Pending |
| PRICE-02 | P1: Prices do not double count | Design | Pending |
| PRICE-03 | P1: Prices do not double count | Design | Pending |
| PRICE-04 | P1: Prices do not double count | Design | Pending |
| RUN-10 | P2: Nested dispatch stays in the run | Design | Pending |
| RUN-11 | P2: Nested dispatch stays in the run | Design | Pending |
| BF-01 | P2: Historical orchestrator backfill | Design | Pending |
| BF-02 | P2: Historical orchestrator backfill | Design | Pending |
| BF-03 | P2: Historical orchestrator backfill | Design | Pending |
| BF-04 | P2: Historical orchestrator backfill | Design | Pending |
| BF-05 | P2: Historical orchestrator backfill | Design | Pending |
| BF-06 | P2: Historical orchestrator backfill | Design | Pending |
| BF-07 | P2: Historical orchestrator backfill | Design | Pending |
| BF-08 | P2: Historical orchestrator backfill | Design | Pending |

**Coverage:** 43 total, 0 mapped to tasks, 43 unmapped until Tasks.

---

## Success Criteria

- [ ] After the backfill, `codedeck usage --all --json` reports orchestrator cost within 1% of the sum of last `cost-state.totalCostUSD` over the collected native ids (US$ 1,470.77 at capture time).
- [ ] `codedeck usage <run-id> --json` for a run with no workers reports `sessionCount: 0` and `costComplete: true`.
- [ ] Codex `gpt-5.6-luna` cost under PRICE-01 is at most US$ 3,830 over the capture-time rows.
