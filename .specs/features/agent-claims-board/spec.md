# Agent Claims Board Specification

## Goal

Give workers a cheap, cooperative way to avoid editing the same files in a shared worktree, through a poll-based board where a worker checks existing claims before editing and records its own claim.

## User scenario

Two workers run against the same git worktree at the same time. Worker A is refactoring `src/auth/*`. Worker B is about to fix a bug in `src/auth/login.ts`. Without coordination, B overwrites A's half-finished edit, and neither can tell which session owns the work.

With the board, the flow is query then claim then edit. Before editing files, B asks the board who has claimed `src/auth/login.ts` or the glob `src/auth/*`. The board answers with active claims, each showing session id and reason, so B sees that A is working on `src/auth/*` to refactor the login flow. B then records its own claim for the narrower path, picks a non-overlapping file, waits, or proceeds knowing the risk. Nothing is pushed into A. A only learns about B if A asks the board itself.

## Acceptance criteria

Each criterion is independently testable.

1. A worker can register a claim scoped to a path glob, tied to its session id, with a short reason text. The daemon persists it in a new `claims` table in `src/store/database.ts`, accessed through a new store module in `src/store/` following the pattern of `src/store/sessions.ts` and `src/store/events.ts`. The table has an integer `id` primary key, `session_id`, `path_glob`, `reason`, `created_at`, and an `active` state. A partial `UNIQUE` index on `(session_id, path_glob) WHERE active = 1` enforces one active claim per natural key. Claim add and re-claim run as one database transaction. They use the existing SQLite WAL mode and `busy_timeout = 5000` in `src/store/database.ts:22-24`, so concurrent writers wait for the database and cannot leave duplicate active claims.
2. The store normalizes both stored path globs and query values to repo-root-relative POSIX paths before matching. Normalization resolves a relative path or glob against the session's current repository or worktree root, converts `\\` to `/`, removes a leading `./`, and rejects a path that escapes the root. It does not expand the filesystem. Matching uses minimatch called as `minimatch(path, pattern, options)`. The first argument is a concrete, normalized, repo-root-relative POSIX path, and the second argument is the stored glob pattern. Never pass a glob as the first argument when a concrete path is available. Use `{ dot: true, nocase: false, nobrace: true, noext: true }`: `dot: true` matches dotfiles, `nocase: false` keeps matching case-sensitive, `nobrace: true` disables brace expansion, and `noext: true` disables extglob. `*` and `?` do not match `/`, and `**` can match across `/`. A query accepts either a concrete path or a glob. For a concrete-path query, a stored claim matches iff `minimatch(queriedPath, claim.pathGlob, options)` is true. For a glob-vs-glob query, keep the accept-on-uncertainty rule: overlap is true iff `minimatch(globA, globB, options) || minimatch(globB, globA, options)`, where `globA` is the stored claim glob, `globB` is the query glob, and each call treats its first argument as the candidate path and its second as the pattern. Return every active claim whose stored glob overlaps the query glob under this rule. Concrete-path queries are authoritative. Glob-vs-glob queries are best-effort hints because this literal-pattern heuristic can miss overlaps that share only an unenumerated third path. Workers should query concrete paths before editing, following the AC9 flow.
3. Each claim has an autoincrement integer `id`, `session_id`, `path_glob`, `reason`, an ISO 8601 UTC `created_at` value, and an `active` boolean state. The natural key is `(session_id, path_glob)`, using the normalized glob, and its uniqueness rule applies to active claims. Re-claiming the same normalized glob from the same session updates the existing active claim's reason, keeps its id and creation time, and does not create a duplicate. Adding the glob after that claim was released creates a new claim id.
4. A worker can release its own claim by claim id and session id. Releasing a claim id that does not exist or is already inactive returns `CLAIM_NOT_FOUND` and changes nothing. Releasing a claim owned by another session returns `CLAIM_NOT_OWNED` and changes nothing. A successful release sets the claim inactive and returns the released claim.
5. Claims tied to a session become inactive when that session reaches a terminal state as defined by `isTerminalStatus` in `src/core/session.ts:77-79`: `completed`, `failed`, `stopped`, `orphaned`, or `interrupted`. The store uses lazy release. At the start of each claims operation, it marks active claims owned by a terminal session, or by a session row that no longer exists, inactive. Queries then return only active claims whose session row exists and is non-terminal. Non-terminal states such as `needs_input` and `idle` keep claims active.
6. The daemon exposes exactly three new protocol methods in `src/daemon/protocol.ts`, dispatched by `Daemon.handleRequest` in `src/daemon/daemon.ts`: `claims.add`, `claims.query`, and `claims.release`. `claims.add` accepts `{ sessionId, pathGlob, reason }` and returns `{ claim }`. `claims.query` accepts `{ sessionId, path }`, where `path` may be a concrete path or glob, and returns `{ claims }`. `claims.release` accepts `{ sessionId, claimId }` and returns `{ claim }`. The methods use the existing Unix socket JSON request/response per line handled by `IpcClient` in `src/daemon/ipc.ts`. The daemon trusts the supplied session id for this cooperative board. It does not authenticate the client or prove process ownership.
7. A new `codedeck claims` CLI command under `src/cli/commands/` supports these stable argv forms and protocol mappings:
   - `codedeck claims add <pathGlob> --reason <text> --session <id> [--json]` -> `claims.add`.
   - `codedeck claims list [<pathOrGlob>] --session <id> [--json]` -> `claims.query`. With no argument, it lists all active claims. With an argument, it returns claims overlapping that path or glob per AC2.
   - `codedeck claims release <claimId> --session <id> [--json]` -> `claims.release`.
   All three forms require `--session <id>` because the daemon requires `sessionId` under AC6 and there is no ambient session.
   Every subcommand supports `--json` for machine-readable output using the envelope defined in AC8. It talks to the daemon only through `IpcClient`, following the pattern of existing commands in `src/cli/commands/` such as `ps.ts`.
8. With `--json`, the CLI writes one JSON object per invocation. A list or query succeeds with `{ "claims": [claim, ...] }`, an add succeeds with `{ "claim": claim }`, and a release succeeds with `{ "claim": claim }` where `active` is `false`. Each claim object has exactly these public fields: integer `id`, string `sessionId`, string `pathGlob`, string `reason`, ISO 8601 UTC string `createdAt`, and boolean `active`. Query results contain active claims only. On an error with `--json`, the command exits nonzero and writes `{ "error": { "code": string, "message": string } }` to stderr, with no success object. Without `--json`, it prints a human-readable error and uses the same nonzero exit status.
9. Claiming and querying work for two sessions that share one worktree without requiring worktree isolation. An observable test creates those sessions, has session A call `claims.add` for `src/auth/*`, then has session B call `claims.query` for `src/auth/login.ts` through `IpcClient` and verifies that A's claim id, session id, path glob, reason, creation time, and active state are returned. The implementation diff also verifies that no file under `src/drivers/*` changed.

## Decisions

- Overlapping claims are accepted. Adding a claim never rejects, blocks, or waits for another claim. A query reports all matching active claims.
- Claim ownership is advisory and unauthenticated. The daemon checks the supplied session id when releasing a claim, but it does not authenticate the caller. This is acceptable for a cooperative board because claims do not grant file access or enforce an edit lock.
- Session cleanup is lazy. The board does not add a session-transition hook. Each claims operation applies the terminal or missing-session rule in acceptance criterion 5 before it reads or writes claims.
- A claim id is an autoincrement integer. The active natural key is `(session_id, path_glob)`. Re-claiming an active key updates its reason while retaining the id and creation time. A released row remains history, and a later add gets a new id.

## Out of Scope

Explicitly excluded.

- Unsolicited mid-task delivery into a running worker. The board never pushes anything. A worker learns about claims only by asking.
- Live two-way agent-to-agent chat. There is no message channel between workers, only claims on paths.
- Synchronous ask-and-block. Claiming never blocks waiting for another worker to answer or release.
- Deadlock and timeout machinery. No lock ordering, no wait graphs, no lease renewal protocol.
- Any change to `src/drivers/*`. If the design needs a harness driver change, the design is wrong.

## Open questions

1. Whether the first implementation should enforce a maximum reason length or a maximum number of claims per session.
