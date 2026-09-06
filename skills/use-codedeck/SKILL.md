---
name: use-codedeck
description: Use when an agent needs to start, monitor, wait for, stop, or inspect CodeDeck sessions, especially background runs, dispatching workers by role, parallel work, or session status automation.
---

# Use CodeDeck

CodeDeck runs coding-agent sessions and persists their state. The session ID is the durable handle. `run --bg` confirms a session started, `wait` confirms it finished. Dispatch a worker with `--role`, never a bare prompt.

## Custom CLI name

Examples here use `codedeck`. If the checkout runs under another name (for example `codedeck-dev` via `CODEDECK_CLI_NAME`), use that name in place of `codedeck` in every command on this page.

## Dispatch: always `--role`

`codedeck run --role <role> "<briefing>"` is the shape. The role picks the harness and model the human bound in `codedeck setup`, and it prepends that role's contract to the worker prompt for every harness, codex and opencode included. Without `--role`, run falls back to the default harness and sends a loose prompt, so you pay for a pricier worker and give it less direction. That is the cost lever. Choose the role, and its binding chooses the model.

| Role | Writes files? | Dispatches? | For |
|------|------|------|------|
| `general` | yes | yes | ordinary work, done in place |
| `orchestrator` | no | yes | spreading work across workers, proving it with `codedeck diff` |
| `auditor` | no | yes | reviewing a scope too large for one pass, sliced by dimension |
| `reviewer` | no | no | one review pass, no fan-out |

Three-letter prefixes work (`--role gen`). The role owns the harness and the model: `--agent` and `--model` are ignored for a role that carries a binding (run warns and keeps the binding), so a worker cannot move itself onto another harness. Change the pairing in `codedeck setup`, not on the dispatch line.

## Worktree is a choice, not a default

`--worktree` is a fresh checkout of the current repo at HEAD. It cannot see uncommitted edits in your working tree, and it cannot see another repository. Reach for it when concurrent coding tasks must compile and commit without colliding. One worktree per task, one session ID per task, never shared. `codedeck show <id> --json` reports the path under `.worktree`.

Run `--no-worktree` when the task needs the live tree: reproducing or fixing a bug that only shows with your current uncommitted edits, or touching a different repo with `--cwd <path>`. Send that work to a harness whose file access can reach the target.

## Run in the background, wait without blocking

```bash
json="$(codedeck run --role general --worktree "<briefing>" --bg --json)"
id="$(jq -er '.id' <<<"$json")"
```

`--bg --json` prints the session object and exits, so capture `.id` at once. Then background one `codedeck wait <id> --json` per worker rather than waiting in the foreground. Each wait returns only when its own worker reaches a terminal state, which frees your turn for the merge, the verification, and the next briefing. Launch independent workers in one message so they actually run in parallel.

`wait` loops until a terminal state, so it blocks straight through `needs_input`, which is not terminal. A worker parked on input hangs the waiter indefinitely. When a wait returns, take one `codedeck ps` snapshot (or `codedeck show <id>`) to catch any other worker stuck on input, answer it with `codedeck send <id> "<reply>"`, then wait again. That snapshot is discovery, not a polling loop.

## Completion contract

Five statuses are terminal: `completed`, `failed`, `stopped`, `orphaned`, `interrupted`. `starting`, `working`, `needs_input`, and `idle` are still active. Only `completed` is success. The other four are failures, so carry their detail into your report.

The exit code alone is not enough. It is the process status of `codedeck wait`, not a field in the JSON, and it flattens distinct outcomes, since `stopped` reports exit 0. Read `.status` from the `--json` output and decide from that.

| Exit | Meaning |
|------|------|
| 0 | completed or stopped |
| 1 | task failed, rerunning the same prompt will not help |
| 2 | harness crashed, retryable |
| 3 | infra error, or `interrupted` by power loss |

An `interrupted` session was cut off by a shutdown, not finished. Resume it with `codedeck send <id> "continue"`.

A shell gate that trusts status over exit code:

```bash
set +e
codedeck wait "$id" --json >final.json
rc=$?
set -e
status="$(jq -er '.status' final.json)" || exit 3
case "$status" in
  completed) (( rc == 0 )) || exit "$rc" ;;
  failed|stopped|orphaned|interrupted) exit 1 ;;
  *) exit 3 ;;
esac
```

## Verify what the worker produced

A success message is a claim, the diff is the fact. `codedeck diff <id> --stat` lists changed files and line counts without the diff body, so it shows whether the worker produced anything and whether it stayed inside its assigned files. An empty stat means it produced nothing, so report no production, never success. `codedeck logs <id>` shows what the worker said, including whether its own review ran. Run the exact verification command the briefing named, scoped to what changed. Never run a whole suite to check one slice.

## Quick reference

| Command | Use |
|------|------|
| `codedeck run --role <r> "<brief>" --bg --json` | start a worker, capture `.id` |
| `codedeck wait <id> --json` | block until terminal, then read `.status` |
| `codedeck ps` | one snapshot of every session |
| `codedeck show <id> --json` | full detail, worktree path, failure code |
| `codedeck diff <id> --stat` | changed files and counts, no diff body |
| `codedeck logs <id> [--follow]` | what the worker reported |
| `codedeck send <id> "<msg>"` | answer `needs_input`, or resume `interrupted` |
| `codedeck stop <id>` | cancel a running session on purpose |

## Red flags

- Dispatching a worker with no `--role`, paying more for less direction.
- `--worktree` on a task that needs uncommitted edits or a different repo.
- Waiting in the foreground, or polling `ps` or `show` in a `while` loop.
- Treating `run --bg` returning, or exit code 0, as task success.
- Reading terminal state from the exit code instead of `.status`.
- Forgetting `interrupted`, or letting a worker parked on `needs_input` hang the waiter.
- Believing a worker's success message without reading `codedeck diff --stat`.

To decide what to parallelize and how to slice ownership, see the parallel-workers skill.
