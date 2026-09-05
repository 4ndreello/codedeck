# CodeDeck

Local runtime for coding agents — session management, process supervision, event normalization, and git isolation.

> **Process manager for coding agents**: PM2 + tmux + git worktrees + normalized events

## Overview

CodeDeck is not an agent. It manages the lifecycle of existing harnesses:

- **Claude Code** (`claude -p --output-format stream-json`)
- **Codex** (`codex exec --json` / app-server)
- **OpenCode** (`opencode run --format json`)
- **OMP** (`omp --mode rpc`)

The `codedeck` CLI provides a single unified interface for all of them:

```bash
npx codedeck run "implement authentication" --agent claude
npx codedeck run "fix the tests" --agent codex
npx codedeck run "investigate this bug" --agent opencode
npx codedeck run "refactor this module" --agent omp

npx codedeck ps
npx codedeck logs a83f --follow
npx codedeck show a83f
npx codedeck send a83f "add tests"
npx codedeck stop a83f
npx codedeck diff a83f
npx codedeck doctor
```

## Stack

- TypeScript / Node.js
- SQLite (`node:sqlite` — `DatabaseSync`)
- Unix Domain Socket for IPC
- Git worktrees for isolation

## Installation

```bash
npm install -g codedeck
# or
npx codedeck
```

Binary: `codedeck`

For local development:

```bash
npm install
npm run build
node dist/cli/index.js doctor
# or create a local alias
npm link
npx codedeck doctor
```

## Architecture

```
codedeck CLI
  │ IPC (Unix Socket, NDJSON)
  ▼
CodeDeck Daemon
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
| `npx codedeck open [role] [--no-bypass] [--no-theme] [-- <claude args>]` | Open an opinionated Claude Code session with the CodeDeck plugin loaded |
| `npx codedeck setup` | Choose the model each installed agent should use |
| `npx codedeck doctor` | Check Node, Git, harnesses, daemon, and database |
| `npx codedeck run "<prompt>" --agent <id> [--model <m>] [--name <n>] [--worktree] [--bg|--detach]` | Start a session; blocks and follows logs by default |
| `npx codedeck wait <id> [--json]` | Wait for a session to reach a terminal state without polling |
| `npx codedeck ps [--all] [--json]` | List recent sessions |
| `npx codedeck show <id> [--json]` | Show session details |
| `npx codedeck logs <id> [--follow] [--json] [--raw]` | Show normalized events |
| `npx codedeck send <id> "<msg>"` | Continue a session (new turn) |
| `npx codedeck stop <id>` | Graceful interrupt → SIGTERM → SIGKILL |
| `npx codedeck diff <id> [--stat] [--json]` | Git diff against base commit |

## Open

`codedeck open` launches Claude Code already configured: the CodeDeck plugin, an appended system prompt, Opus 4.8 at `xhigh` effort, and permissions bypassed. Nothing is written to `~/.claude/`; the plugin is loaded for that session only, from the installed package.

```bash
npx codedeck open              # asks which role, defaults to general
npx codedeck open reviewer     # straight into a role
npx codedeck open -- --add-dir ../other-repo   # anything after -- goes to claude verbatim
```

Three roles, and the restriction is a tool allowlist rather than an instruction:

| Role | Can write? | For |
|------|-----------|-----|
| `general` | yes | ordinary work |
| `orchestrator` | no `Edit`/`Write`, keeps `Bash` | conducting work, delegating writes to `codedeck run` |
| `reviewer` | no `Edit`/`Write`/`Bash` | reading and judging, structurally unable to edit |

The `reviewer` restriction holds even with permissions bypassed, because a tool allowlist is orthogonal to permission bypass. The `orchestrator` keeps `Bash`, so its boundary is only partly enforced: with `Bash` it can still write by redirection, and the rest rests on the prompt.

`--no-bypass` drops the bypass flag, `--no-theme` keeps the status line but drops the colours, and `--model`/`--effort`/`--resume`/`--worktree` override the defaults.

A launch carrying `-p`/`--print` answers once and exits, so it never asks anything: no role prompt, no first-run wizard. Checking for a terminal is not enough on its own, since a pty gives a TTY to scripts and CI runners alike.

### Choosing a model per agent

The first interactive `open` puts every installed agent on one screen and takes one line for all of them. Re-run it any time:

```bash
npx codedeck setup
```

```
  Claude Code                              Enter = claude-opus-5
   1 claude-sonnet-4-6     3 claude-opus-4-5
   2 claude-opus-5         4 claude-haiku-4-5

  Codex                                     Enter = gpt-5.6-sol
   5 gpt-5.6-sol           6 gpt-5.6-terra

  omp · no models found, type omp=<id>

  one number per agent, or Enter for the defaults
  > 2 6
```

Numbers run straight through the screen, so one per agent is enough and order does not matter. Enter alone takes every default, an agent left out of the line keeps its default, and `agent=<id>` types an id the list does not show. The lists come from `codedeck models`, shortlisted to sixteen per agent because opencode alone proxies some 600 ids and would scroll everything else away.

Precedence is `--model`, then the agent's saved model, then `defaultModel`, then the driver's own default, so `codedeck run --agent codex` picks up the codex choice without repeating the flag.

## Session

```ts
Session {
  id: string          // e.g. a83f (CodeDeck)
  nativeSessionId?    // internal harness id
  agent: "claude" | "codex" | "opencode" | "omp"
  status: "starting" | "working" | "needs_input" | "idle" | "completed" | "failed" | "stopped" | "orphaned" | "interrupted"
  cwd, worktree, branch, repository, baseCommit
  pid, usage, createdAt, updatedAt
}
```

`nativeSessionId` is an internal detail. Users only see the CodeDeck ID.

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

## Agent contract

Codedeck is consumed by agents as a subprocess, so failures are machine-readable:

- `session.failed` events carry a structured `failure` object:

```json
{
  "type": "session.failed",
  "error": "EPIPE: broken pipe, write",
  "failure": { "code": "HARNESS_CRASH", "blame": "harness", "retryable": true, "reason": "unhandled_rejection" }
}
```

- `blame` separates a harness crash (`harness` → retry the session) from failed
  work (`task` → fix the code) from a setup problem (`infra`).
- The same object is hydrated on the session row: `codedeck show <id> --json`
  → `session.failure`.
- A harness death without a terminal frame is reported as `session.failed`
  (blame `harness`, retryable) — never as a silent `completed`.

### Exit codes (`codedeck run` and `codedeck wait`)

| Code | Meaning |
|------|---------|
| 0 | session completed or stopped |
| 1 | task failed — the agent's work failed; retrying unchanged won't help |
| 2 | harness crashed (EPIPE, signal, unhandled rejection) — retryable |
| 3 | infra — daemon, worktree, spawn, or usage errors; `interrupted` sessions after power loss |

`run` blocks and follows events by default. `run --bg` starts the session,
prints its session object or ID, and exits without waiting. `--detach` remains
accepted as an alias for `--bg`.

`wait <id>` blocks without printing the event stream, then prints one terminal
result. `wait --json` prints the final session object as one JSON line. Closing
the terminal or pressing `Ctrl+C` detaches the waiter; it does not stop the
session.

### Daemon restart resilience

Harness processes run detached from the daemon and write stdout/stderr to
per-session files under `~/.run-agent/logs/`. A daemon restart therefore does
not close the harness output pipe, send `EPIPE`, or apply pipe backpressure.

On startup the daemon checks each active session's persisted PID. If the
process is still alive, it reattaches to the session log from the stored byte
offset and keeps the session `working`; it does not mark the session
`orphaned` or spawn a duplicate harness. If the process finished while the
daemon was down, the new daemon drains the log, records any terminal event,
and synthesizes a structured failure when the harness left no terminal frame.

`codedeck stop <id>` also falls back to the persisted PID, so stopping a
reattached session works even when no in-memory process handle exists.

### Power loss and resume

A `poweroff`, `reboot`, or lid-close sends the daemon `SIGTERM`/`SIGHUP`. The
daemon drains running sessions best-effort (a few seconds, no root) and marks
each active session `interrupted` with a `session.failed` event carrying
`failure: { "code": "SHUTDOWN", "blame": "infra", "retryable": true }` —
never a silent `completed`.

- `codedeck ps` shows interrupted sessions with `⏻`; `codedeck show <id> --json`
  exposes `session.failure.code = "SHUTDOWN"`.
- `codedeck wait <id>` on an interrupted session returns immediately with exit 3.
- Resume is explicit: `codedeck send <id> "continue"` reopens the turn with
  `--resume <nativeId>` in the same `cwd`/`worktree`. Sessions without a
  resumable harness id are rejected with `CAPABILITY_NOT_SUPPORTED`.
- Where `systemd-inhibit` exists the daemon holds a `--mode=delay` lock while
  draining so shutdown waits up to `InhibitDelayMaxSec`; without it the daemon
  still shuts down cleanly on `SIGTERM`. `codedeck doctor` reports both under
  `Power`. No setup step or privileged install is required or promised.


## Worktrees

```bash
npx codedeck run "implement oauth" --worktree
# creates ~/.run-agent/worktrees/<repo-hash>/<session-id>
# branch: ra/<slug>-<session-id>
```

The driver receives the worktree as `cwd`. Isolation is the responsibility of CodeDeck, not the harness.

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
npx codedeck doctor
npx codedeck run "find one improvement and implement it" --agent claude --worktree --bg
npx codedeck run "find one improvement and implement it" --agent codex --worktree --bg
npx codedeck ps
npx codedeck wait <claude-session>
npx codedeck logs <claude-session> --follow
npx codedeck show <codex-session>
npx codedeck diff <claude-session>
npx codedeck diff <codex-session>
npx codedeck send <claude-session> "run the tests before finishing"
npx codedeck stop <codex-session>
```

The same experience across all four harnesses.

## Security

- Does not store API keys/tokens — uses harness authentication.
- Raw events may contain sensitive data (documented).
- Does not silently modify user configuration.

## License

MIT
