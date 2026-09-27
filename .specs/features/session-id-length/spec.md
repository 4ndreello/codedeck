# Session ID length and lookup specification

## Problem Statement

New session IDs currently occupy only 16 bits, while the local store already has about 2,500 rows. Prefix lookup also returns the first matching row, so two sessions with the same prefix can resolve to the wrong session without an error.

The system will store 16 lowercase hexadecimal characters per new session, display the first eight characters of new IDs, and resolve prefixes only when they identify one stored session. Existing four-character IDs remain unchanged and display in full.

## Goals

- [x] Generate 16 lowercase hexadecimal characters from eight cryptographic random bytes.
- [x] Resolve exact IDs before prefixes, return unique prefixes, and reject ambiguous prefixes.
- [x] Keep all daemon operations keyed by the canonical stored ID.
- [x] Show the first eight characters in existing human-readable ID displays, or the full value when it is shorter, and full IDs in JSON.
- [x] Keep worktree, log, and environment identifiers full length.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Rewriting existing four-character IDs in the database | Existing IDs remain valid and are not migrated. |
| Shortest-unique-prefix display | The display width is fixed at eight characters; shorter legacy IDs display in full. |
| Changing `runId` format or renaming `agent` fields | These formats are outside this issue. |
| Adding a session-ID display to the web console | The current web console has no session-ID display. |
| Changing IPC request or response fields beyond `SESSION_AMBIGUOUS` | Prefix lookup uses existing ID fields. |
| Changing reviewer auto-dispatch or pricing | Unrelated to session identity. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Exact ID also prefixes another row | Exact match wins. | This preserves legacy four-character IDs and full-ID lookups. | Yes |
| Prefix matches are ambiguous | List all candidate IDs in lexical order. | Deterministic candidate text makes errors clear and testable. | Yes |
| Empty lookup input | It matches no session. | An empty value is not a useful ID prefix. | Yes |
| Existing display surfaces | Shorten only surfaces that already print session IDs. | The statusline and web console currently have no session-ID text to shorten. | Yes |
| Parent ID resolution | Resolve `parentId` exactly during session creation. | `CODEDECK_SESSION_ID` carries a full ID; a stale prefix must not invent a parent or fail creation. | Yes |

**Open questions:** none.

## User Stories

### P1: Identify sessions without collisions

**User Story**: As a CodeDeck user, I want durable session IDs and safe prefix lookup so that commands do not act on the wrong session.

**Why P1**: IDs share a small namespace and ambiguous prefixes currently select an arbitrary row.

**Acceptance Criteria**:

1. **SID-01** WHEN `generateSessionId()` is called THEN it SHALL return 16 lowercase hexadecimal characters generated from eight bytes by `node:crypto`, with no `Math.random` fallback.
2. **SID-02** WHEN a lookup input exactly equals a stored session ID THEN the store SHALL return that session even when other stored IDs start with the same value, including for legacy four-character IDs.
3. **SID-03** WHEN no stored ID equals the input and exactly one stored ID starts with the nonempty input THEN the store SHALL return that session.
4. **SID-04** WHEN no stored ID equals the input and at least two stored IDs start with it THEN lookup SHALL fail with code `SESSION_AMBIGUOUS` and a message listing every matching ID, and SHALL NOT return a session.
5. **SID-05** WHEN a daemon IPC request that resolves a session ID by prefix receives an ambiguous prefix THEN the daemon SHALL return code `SESSION_AMBIGUOUS` and a message listing candidates, and the CLI SHALL print that message and exit non-zero using its existing `SESSION_NOT_FOUND` error path.
6. **SID-06** WHEN a daemon IPC request uses a unique session-ID prefix THEN the daemon SHALL use the resolved session's full ID for all keyed session, runtime, event, claim, and worktree operations. WHEN `session.create` receives `parentId` THEN it SHALL resolve that value exactly; an unmatched or ambiguous prefix SHALL leave the parent unset and SHALL NOT fail creation. WHEN `usage.get` receives a session-ID prefix in `runId` THEN it SHALL aggregate using the canonical ID, or return `SESSION_AMBIGUOUS` for an ambiguous prefix; unrelated run IDs SHALL pass through unchanged.
7. **SID-07** WHEN an existing human-readable output prints a session ID THEN it SHALL print the first eight characters, or the full value when shorter; every session-bearing `--json` output SHALL retain the full ID. Since legacy IDs are exactly four characters, an eight-character display of a new ID cannot exactly match a legacy ID.
8. **SID-08** WHEN a session ID is used in a worktree path, a `ra/<slug>-<id>` branch name, a log filename, or `CODEDECK_SESSION_ID` THEN the full ID SHALL be used.
9. **SID-09** The system SHALL keep retrying ID allocation when `session.create` or `session.adopt` encounters an exact collision.

**Independent Test**: Create rows with overlapping IDs, call the store and daemon with exact, unique-prefix, and ambiguous inputs, and inspect returned data and side effects.

## Edge Cases

- An exact legacy four-character ID remains selectable even if a longer ID starts with it.
- A one-character prefix resolves when unique and fails when ambiguous.
- An empty input does not match every row.
- Collision detection compares full candidate IDs exactly and does not treat a candidate as occupied only because it starts with a legacy ID.
- Ambiguous IPC errors name the full candidate IDs.
- `usage.get` resolves unique session-ID prefixes and reports ambiguous ones without changing unrelated run IDs.
- JSON values retain canonical IDs even when text output uses eight characters.
- A displayed eight-character prefix of a new ID cannot exactly match a legacy four-character ID.
- The Claude statusline and web console currently show no CodeDeck session ID. Leave them unchanged and record that fact in the implementation report.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| SID-01 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-02 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-03 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-04 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-05 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-06 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-07 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-08 | P1: Identify sessions without collisions | Tasks | Complete |
| SID-09 | P1: Identify sessions without collisions | Tasks | Complete |

**Coverage**: 9 requirements, 9 mapped to tasks, 0 unmapped.

## Success Criteria

- [x] New IDs have 16 lowercase hexadecimal characters from `randomBytes(8)`.
- [x] Exact IDs win, unique prefixes resolve, and ambiguous prefixes fail with candidate IDs.
- [x] Daemon and CLI preserve canonical IDs for keyed operations and JSON.
- [x] Existing text output shows eight characters, or the full shorter ID, where it already displayed IDs.
- [x] Collision retry, focused test commands, typecheck, and mutation probes pass.
