# Session ID length and lookup tasks

**Status**: Complete. The orchestrator verified 33/33 tests in `tests/orchestrator-usage-daemon.test.ts` and 1/1 in `tests/session-id-artifacts.test.ts` outside the sandbox.
**Specification**: `.specs/features/session-id-length/spec.md`

## Test Coverage Matrix

> Based on `package.json`, `vitest.config.ts`, the focused-test rules supplied for this task, and neighboring tests.

| Code layer | Test type | Test file | Command | Coverage expectation |
| --- | --- | --- | --- | --- |
| Session ID generation | Unit | `tests/session.test.ts` | `npx vitest run --no-cache tests/session.test.ts` | Length, lowercase hex, eight-byte crypto call, and no fallback. |
| Session store lookup | Unit | `tests/session-id-store.test.ts` | `npx vitest run --no-cache tests/session-id-store.test.ts` | Exact precedence, eight-character legacy-shadow regression, unique prefixes, ambiguous candidates, empty input, case-insensitive lookup, exact collision check. |
| Daemon IPC lookup and canonical routing | Integration | `tests/session-id-ipc.test.ts` | `npx vitest run --no-cache tests/session-id-ipc.test.ts` | ID-taking handlers reject ambiguity; exact parent lookup ignores prefixes; keyed side effects use full IDs. |
| Usage run-ID lookup | Integration | `tests/usage-daemon.test.ts` | `npx vitest run --no-cache tests/usage-daemon.test.ts` | Exact run IDs take precedence over session-ID prefixes; unique prefixes resolve and unrelated run IDs remain unchanged. |
| Orchestrator usage reconciliation | Integration | `tests/orchestrator-usage-daemon.test.ts` | `npx vitest run --no-cache tests/orchestrator-usage-daemon.test.ts` | Existing open-session usage operations remain compatible with normalized session IDs. |
| Claims daemon errors | Integration | `tests/claims-daemon.test.ts` | `npx vitest run --no-cache tests/claims-daemon.test.ts` | Claims preserve ownership and the original missing-session error shape. |
| CLI errors and output | Unit | `tests/session-id-cli.test.ts` | `npx vitest run --no-cache tests/session-id-cli.test.ts` | Ambiguity message and nonzero exit; text output uses eight characters and JSON keeps full IDs. |
| Claims CLI output | Unit | `tests/claims-cli.test.ts` | `npx vitest run --no-cache tests/claims-cli.test.ts` | Human output shortens session IDs to eight characters; JSON keeps full IDs. |
| Agents pane display | Unit | `tests/mods-agents/pane.test.ts` | `npx vitest run --no-cache tests/mods-agents/pane.test.ts` | Session and parent IDs render with eight characters while row identity and history lines stay intact. |
| `ps` output | Unit | `tests/ps.test.ts` | `npx vitest run --no-cache tests/ps.test.ts` | Table displays the first eight characters of a full session ID. |
| `wait` output | Unit | `tests/wait-command.test.ts` | `npx vitest run --no-cache tests/wait-command.test.ts` | Text output displays eight characters for full IDs and keeps legacy IDs intact. |
| Session artifacts and environment | Integration | `tests/session-id-artifacts.test.ts` | `npx vitest run --no-cache tests/session-id-artifacts.test.ts` | Branch, worktree, logs, and `CODEDECK_SESSION_ID` keep the full value. |

## Gate Check Commands

Run each Vitest command separately. Never run the full suite.

| Gate | Command |
| --- | --- |
| Quick | The task-specific `npx vitest run tests/<file>.test.ts` commands below, one file at a time. |
| Full | The task-specific daemon, CLI, plugin, and artifact commands below, one file at a time. |
| Build | `npx tsc --noEmit -p .` |

## Execution Plan

Tasks run in order. Each task includes its tests and focused gate.

### Phase 1: Session identity

```text
T1 → T2 → T3 → T4 → T5 → T6
```

## Task Breakdown

### T1: Generate 16-character session IDs

**What**: Generate each new session ID from eight cryptographic random bytes and update tests that assert the old generated length.
**Where**: `src/core/session.ts`
**Files**: `src/core/session.ts`, `tests/session.test.ts`, `tests/session-adopt.test.ts`, and only the existing fresh-ID test in `tests/run-linkage.test.ts`.
**Depends on**: None
**Requirement IDs**: SID-01
**Tests**: Unit tests for byte count, output format, and no `Math.random` fallback; generated-ID assertions in adoption and run linkage.
**Gate**: Quick

Commands, run one file at a time:

- `npx vitest run --no-cache tests/session.test.ts`
- `npx vitest run --no-cache tests/session-adopt.test.ts`
- `npx vitest run --no-cache tests/run-linkage.test.ts`

**Done when**:

- `generateSessionId()` returns exactly 16 lowercase hexadecimal characters from `randomBytes(8)`.
- A failed crypto call propagates instead of falling back to `Math.random`.
- The scoped generated-ID assertions expect 16 characters, with no other edits to `tests/run-linkage.test.ts`.

**Status**: Complete. Focused commands passed with 6/6, 21/21, and 1/1 tests.

### T2: Resolve exact, unique, and ambiguous IDs

**What**: Make store lookup case-insensitive, prefer exact IDs, resolve only unique nonempty prefixes, report ambiguity, and keep collision checks exact.
**Where**: `src/store/sessions.ts`
**Files**: `src/store/sessions.ts`, `src/daemon/daemon.ts` only for exact allocation lookup, `tests/session-id-store.test.ts`, and existing collision tests remain unchanged.
**Depends on**: T1
**Requirement IDs**: SID-02, SID-03, SID-04, SID-09
**Tests**: Store assertions cover exact legacy and full IDs, uppercase input, the eight-character prefix of `a83f0123456789ab` resolving past legacy `a83f`, one-character unique prefixes, ambiguous candidates, empty input, and a new candidate sharing a legacy prefix. Existing create/adopt retry tests remain the AC9 regression gate.
**Gate**: Quick

Commands, run one file at a time:

- `npx vitest run --no-cache tests/session-id-store.test.ts`
- `npx vitest run --no-cache tests/session-store.test.ts`
- `npx vitest run --no-cache tests/session-create-collision.test.ts`

**Done when**:

- Exact lookup wins over longer IDs that share its prefix.
- A unique prefix returns its stored session; an ambiguous prefix throws `SESSION_AMBIGUOUS` and names every candidate.
- Empty input returns no match.
- Uppercase lookup input resolves lowercase hexadecimal IDs in both `get` and `getExact`.
- Allocation retries only when the exact candidate ID already exists.
- Existing create/adopt collision retry tests pass.

**Status**: Complete. Focused commands passed with 7/7, 10/10, and 8/8 tests.

### T3: Return ambiguity errors through IPC and CLI

**What**: Convert store ambiguity into the `SESSION_AMBIGUOUS` daemon response and document the error while preserving the CLI's existing not-found error path.
**Where**: `src/daemon/daemon.ts`
**Files**: `src/daemon/daemon.ts`, `docs/protocol.md`, `tests/session-id-ipc.test.ts`, and `tests/session-id-cli.test.ts`.
**Depends on**: T2
**Requirement IDs**: SID-05
**Tests**: Daemon tests assert the code and all candidate IDs; CLI tests assert the printed message and the same nonzero exit behavior used for `SESSION_NOT_FOUND`.
**Gate**: Full

Commands, run one file at a time:

- `npx vitest run --no-cache tests/session-id-ipc.test.ts`
- `npx vitest run --no-cache tests/session-id-cli.test.ts`

**Done when**:

- Ambiguous store lookup becomes an IPC error with code `SESSION_AMBIGUOUS` and candidate IDs in its message.
- The protocol document lists `SESSION_AMBIGUOUS`.
- The CLI prints the daemon message and exits nonzero through its existing not-found handling.
- No IPC request fields or response fields change.

**Status**: Complete. IPC and CLI commands passed with 19/19 and 3/3 tests.

### T4: Use canonical IDs in daemon operations

**What**: Resolve session-ID requests before keyed access, pass the returned `session.id` to keyed operations, resolve `parentId` exactly, and resolve session-ID prefixes before usage aggregation.
**Where**: `src/daemon/daemon.ts`
**Files**: `src/daemon/daemon.ts`, `tests/session-id-ipc.test.ts`, `tests/claims-daemon.test.ts`, `tests/usage-daemon.test.ts`, `tests/orchestrator-usage-daemon.test.ts`.
**Depends on**: T3
**Requirement IDs**: SID-06
**Tests**: Exercise ambiguous and unique prefixes across ID-taking methods, including claims and runtime operations; assert unique and ambiguous parent prefixes do not create an edge or fail creation; assert usage accepts a unique session-ID prefix, rejects an ambiguous prefix, and still accepts unrelated run IDs.
**Gate**: Full

Commands, run one file at a time:

- `npx vitest run --no-cache tests/session-id-ipc.test.ts`
- `npx vitest run --no-cache tests/claims-daemon.test.ts`
- `npx vitest run --no-cache tests/usage-daemon.test.ts`
- `npx vitest run --no-cache tests/orchestrator-usage-daemon.test.ts`

**Done when**:

- Every request that takes `id`, `parentId`, or `sessionId` resolves through the store.
- No keyed access after resolution uses the raw request prefix.
- Unique prefixes act on the canonical full ID.
- `parentId` is resolved by exact lookup only; an ambiguous prefix leaves `parentId` unset and does not fail `session.create`.
- Usage lookup preserves exact run IDs before resolving a session-ID prefix and preserves unrelated `runId` values.
- Ambiguous session-ID prefixes in `usage.get` return `SESSION_AMBIGUOUS`.
- The allocation path remains exact and does not throw on ambiguous prefixes.

**Status**: Complete. IPC passed 19/19 and usage passed 13/13. The orchestrator verified 33/33 tests in `tests/orchestrator-usage-daemon.test.ts` outside the sandbox.

### T5: Shorten existing human-readable ID output

**What**: Render the first eight characters in existing CLI text output and the agents pane through a shared helper while keeping JSON values full; shorten claim IDs in human output.
**Where**: `src/core/session.ts`
**Files**: `src/core/session.ts`, `src/cli/commands/ps.ts`, `src/cli/commands/run.ts`, `src/cli/commands/show.ts`, `src/cli/commands/wait.ts`, `src/cli/commands/claims.ts`, `plugin/mods/agents/pane.ts`, `tests/session-id-cli.test.ts`, `tests/ps.test.ts`, `tests/wait-command.test.ts`, `tests/claims-cli.test.ts`, `tests/mods-agents/pane.test.ts`.
**Depends on**: T4
**Requirement IDs**: SID-07
**Tests**: CLI tests cover `ps`, `run`, `show`, and `wait` text plus full session IDs in JSON; claims tests cover shortened human output and full JSON; plugin tests cover eight-character row and parent IDs, full internal row identity, and non-vacuous history-line equality.
**Gate**: Full

Commands, run one file at a time:

- `npx vitest run --no-cache tests/session-id-cli.test.ts`
- `npx vitest run --no-cache tests/claims-cli.test.ts`
- `npx vitest run --no-cache tests/ps.test.ts`
- `npx vitest run --no-cache tests/wait-command.test.ts`
- `npx vitest run --no-cache tests/mods-agents/pane.test.ts`

**Done when**:

- Existing CLI and claims text IDs show the first eight characters, or the full value when shorter.
- Session-bearing JSON keeps full IDs.
- Agents pane text shortens row and parent IDs without changing their internal full-ID relationships.
- `plugin/statusline.sh` and `src/web/**` remain unchanged because neither currently displays a CodeDeck session ID.

**Status**: Complete. CLI, claims, `ps`, `wait`, and pane display tests passed with 3/3, 10/10, 36/36, 2/2, and 78/78 tests.

### T6: Keep full IDs in session artifacts

**What**: Verify full IDs flow into worktree paths, branch names, log filenames, and `CODEDECK_SESSION_ID`.
**Where**: `tests/session-id-artifacts.test.ts`
**Files**: `tests/session-id-artifacts.test.ts`, plus only production files that a failing assertion proves truncate an ID.
**Depends on**: T5
**Requirement IDs**: SID-08
**Tests**: Integration checks pass a 16-character ID through branch, worktree, log, and harness environment generation.
**Gate**: Build

Commands, run one file at a time:

- `npx vitest run --no-cache tests/session-id-artifacts.test.ts`
- `npx tsc --noEmit -p .`

**Done when**:

- Worktree paths, `ra/<slug>-<id>` branch names, log paths, and `CODEDECK_SESSION_ID` contain the full ID.
- No `runId` format change is introduced.
- TypeScript compilation passes.

**Status**: Complete. The orchestrator verified 1/1 test in `tests/session-id-artifacts.test.ts` outside the sandbox. TypeScript compilation passed.
