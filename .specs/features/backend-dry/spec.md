# backend-dry: remove dead backend code and cut daemon duplication

## Goal
Shrink the backend (src/daemon, src/store, src/core, src/utils, src/git, src/drivers) by deleting code with no production caller and folding repeated daemon request-handling code into small private helpers. No observable behavior change on the IPC protocol other than R1.

## Out of scope
- src/cli, src/open, src/web, src/config, plugin/, spikes/, scripts/.
- Splitting daemon.ts into several files, or restructuring handleRequest into per-domain modules.
- Schema/migration changes (e.g. usage_sources.updated_at stays).
- `daemon.stop` (spec'd in .specs/features/daemon-power, stays).
- `raw`/`json` fields on session.logs (the CLI sends them; the CLI is out of scope).
- Fixing behavior bugs found along the way (report only).

## Requirements
- R1: WHEN a client sends the `daemon.status` IPC method THEN the daemon SHALL answer with the same UNKNOWN_METHOD error it gives any other unknown method.
- R2: every IPC method other than `daemon.status` SHALL return the same result and error envelopes (code and message text) as before the change.
- R3: every event the daemon persisted and broadcast before the change SHALL still be both persisted and broadcast, in the same order.
- R4: the codebase SHALL contain none of these removed symbols after the change, and `npx tsc --noEmit` SHALL pass: IPC method `daemon.status` and `DaemonStatusRequest`; protocol types `ListModelsResult`, `RequestParams`, `UsageGetResult`, `SessionCreateResult`, `SessionPatchResult`, `SessionReleaseResult`, `SessionListResult`, `DoctorResult`; error classes `AgentNotInstalledError`, `AgentAuthenticationRequiredError`, `AgentStartFailedError`, `SessionNotRunningError`, `CapabilityNotSupportedError`, `RepositoryNotFoundError`, `DaemonUnavailableError`, `ProtocolError`; `closeDatabase`; `SessionStore.listByRunId`; `isGitRepository`; `listWorktrees`; `detectBinary` and `which` in src/utils/process.ts; `AgentDriver.resume?` and `AgentDriver.dispose?`.
- R5: `SessionStore.queryUsage` SHALL return identical aggregates for mixed current and legacy rows before and after deduplication.
- R6: the Antigravity parser SHALL emit identical `usage.updated` events from `update.usage` and `result.usage` payloads before and after deduplication.

## Coverage matrix
| layer | test type | where | command |
|---|---|---|---|
| daemon IPC handlers | unit via tests/helpers/daemon-seam.ts | tests/{session-*,claims-*,power-*,send-queue,usage-daemon,daemon-*,release-interrupted,orchestrator-usage-daemon}.test.ts | scripts/run-isolated.sh npx vitest run <files> |
| store | unit | tests/session-store, session-id-store, usage-query, usage-ledger, usage-backfill | same |
| core/git/utils/drivers | unit | tests/git, failure, antigravity-driver, scoped-spawn, session-runtime, capabilities | same |
| types | typecheck | whole project | npx tsc --noEmit |
