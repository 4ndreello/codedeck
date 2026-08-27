# Run Agent

Local runtime for coding agents — session management, process supervision, event normalization, and git isolation.

> **Process manager for coding agents**: PM2 + tmux + git worktrees + normalized events

## Overview

Run Agent is not an agent. It manages the lifecycle of existing harnesses:

- **Claude Code** (`claude -p --output-format stream-json`)
- **Codex** (`codex exec --json` / app-server)
- **OpenCode** (`opencode run --format json`)
- **OMP** (`omp --mode rpc`)

The `run-agent` CLI provides a single unified interface for all of them:

```bash
npx run-agent run "implement authentication" --agent claude
npx run-agent run "fix the tests" --agent codex
npx run-agent run "investigate this bug" --agent opencode
npx run-agent run "refactor this module" --agent omp

npx run-agent ps
npx run-agent logs a83f --follow
npx run-agent show a83f
npx run-agent send a83f "add tests"
npx run-agent stop a83f
npx run-agent diff a83f
npx run-agent doctor
```

## Stack

- TypeScript / Node.js
- SQLite (`node:sqlite` — `DatabaseSync`)
- Unix Domain Socket for IPC
- Git worktrees for isolation

## Installation

```bash
npm install -g run-agent
# or
npx run-agent
```

Binary: `run-agent`

For local development:

```bash
npm install
npm run build
node dist/cli/index.js doctor
# or create a local alias
npm link
npx run-agent doctor
```

## Architecture

```
run-agent CLI
  │ IPC (Unix Socket, NDJSON)
  ▼
Run Agent Daemon
  ├── Session Store (SQLite)
  ├── Event Store (SQLite)
  ├── Process Manager
  └── Driver Registry
        ├── ClaudeDriver (stream-json)
        ├── CodexDriver (exec --json)
        ├── OpencodeDriver (run --format json)
        └── OmpDriver (rpc)
```

The daemon owns the sessions. The CLI only follows events — closing the terminal does not kill the agent.

## Commands

| Command | Description |
|---------|-------------|
| `npx run-agent doctor` | Check Node, Git, harnesses, daemon, and database |
| `npx run-agent run "<prompt>" --agent <id> [--model <m>] [--name <n>] [--worktree] [--detach]` | Start a session |
| `npx run-agent ps [--all] [--json]` | List recent sessions |
| `npx run-agent show <id> [--json]` | Show session details |
| `npx run-agent logs <id> [--follow] [--json] [--raw]` | Show normalized events |
| `npx run-agent send <id> "<msg>"` | Continue a session (new turn) |
| `npx run-agent stop <id>` | Graceful interrupt → SIGTERM → SIGKILL |
| `npx run-agent diff <id> [--stat] [--json]` | Git diff against base commit |

## Session

```ts
Session {
  id: string          // e.g. a83f (run-agent)
  nativeSessionId?    // internal harness id
  agent: "claude" | "codex" | "opencode" | "omp"
  status: "starting" | "working" | "needs_input" | "idle" | "completed" | "failed" | "stopped" | "orphaned"
  cwd, worktree, branch, repository, baseCommit
  pid, usage, createdAt, updatedAt
}
```

`nativeSessionId` is an internal detail — users only see the Run Agent ID.

## Normalized Events

```ts
AgentEvent =
  | session.started | turn.started | text.delta | message
  | tool.started | tool.completed | file.changed
  | permission.requested | permission.resolved
  | usage.updated | turn.completed
  | session.completed | session.failed | error
```

Every event is persisted with its original `raw` payload intact for debugging and future compatibility.

Tables:

- `sessions` — per-session state
- `events` — monotonic log `(session_id, sequence)`

## Worktrees

```bash
npx run-agent run "implement oauth" --worktree
# creates ~/.run-agent/worktrees/<repo-hash>/<session-id>
# branch: ra/<slug>-<session-id>
```

The driver receives the worktree as `cwd`. Isolation is the responsibility of Run Agent, not the harness.

Global config: `~/.config/run-agent/config.json` or `~/.run-agent/` (fallback)

```json
{
  "defaultAgent": "claude",
  "worktree": true
}
```

## Spikes

Validates each harness in isolation before abstractions:

```
spikes/claude.ts
spikes/codex.ts
spikes/opencode.ts
spikes/omp.ts
```

Run with:

```bash
npx tsx spikes/claude.ts
```

Each spike proves: detect, start, prompt, events, nativeSessionId, completion, interrupt, resume, stderr, and cleanup.

## Development

```
src/
  cli/       → commander, commands (run/ps/show/logs/send/stop/diff/doctor)
  core/      → driver interface, session, events, capabilities, errors
  drivers/   → claude / codex / opencode / omp
  daemon/    → daemon, ipc (Unix socket), process-manager, protocol
  store/     → SQLite (sessions, events)
  git/       → repository, worktree, diff
  config/    → paths, config
  utils/
```

Build:

```bash
npm run build
npm test
```

## Definition of Done (first release)

```bash
cd example-project
npx run-agent doctor
npx run-agent run "find one improvement and implement it" --agent claude --worktree --detach
npx run-agent run "find one improvement and implement it" --agent codex --worktree --detach
npx run-agent ps
npx run-agent logs <claude-session> --follow
npx run-agent show <codex-session>
npx run-agent diff <claude-session>
npx run-agent diff <codex-session>
npx run-agent send <claude-session> "run the tests before finishing"
npx run-agent stop <codex-session>
```

The same experience across all four harnesses.

## Security

- Does not store API keys/tokens — uses harness authentication.
- Raw events may contain sensitive data (documented).
- Does not silently modify user configuration.

## License

MIT
