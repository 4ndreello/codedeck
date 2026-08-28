---
name: use-codedeck
description: Use when an agent needs to start, monitor, wait for, stop, or inspect CodeDeck sessions, especially background runs, parallel work, or session status automation.
---

# Use CodeDeck

CodeDeck owns agent processes and persists session state. Treat the session ID as the durable handle. `run --bg` only confirms launch; `wait` confirms completion.

## Recommended workflow

- One foreground task: `codedeck run "<task>"` — blocks and follows logs.
- Background task: `codedeck run "<task>" --bg --json`; capture `.id` immediately.
- Completion: `codedeck wait <id> --json`; inspect final `.status` and exit code.
- Diagnostics: `codedeck show <id> --json`; progress: `codedeck logs <id> --follow`.
- Parallel coding tasks: use `--worktree`, keep one session ID per task, and inspect each worktree after `wait`.

```bash
session_json="$(codedeck run "<task>" --bg --json --worktree)"
session_id="$(jq -er '.id' <<<"$session_json")"
codedeck wait "$session_id" --json >final.json
```

## Completion contract

Only these statuses are terminal: `completed`, `failed`, `stopped`, `orphaned`. `starting`, `working`, `needs_input`, and `idle` are still active. A successful `run --bg` means the session was accepted, not that the task succeeded. Treat `failed`, `stopped`, and `orphaned` as unsuccessful; preserve and report the final failure details.

`wait --json` is the synchronization authority, but its exit code alone is insufficient: the current CLI maps `stopped` to exit code `0`. Parse the final JSON status. Only `completed` with exit code `0` is success; `failed`, `stopped`, and `orphaned` are failure. For a shell gate:

```bash
set +e
codedeck wait "$session_id" --json >final.json
wait_rc=$?
set -e
status="$(jq -er '.status' final.json)" || exit 3
case "$status" in
  completed) (( wait_rc == 0 )) || exit "$wait_rc" ;;
  failed|stopped|orphaned) (( wait_rc == 0 )) && exit 1 || exit "$wait_rc" ;;
  *) exit 3 ;;
esac
```

`ps` and `show` are snapshots for discovery or diagnosis, not completion predicates. Do not stop a session merely because a waiter, shell, or event stream disconnected; re-run `wait` with the same ID. A waiter timeout stops observation, not the agent process. If the status is `needs_input`, inspect the request and handle it through the supported input path before waiting again. Use `stop` only when cancellation is intentional.

## Common mistakes / red flags

- Polling `ps` or `show` in a custom `while` loop.
- Treating `status != working`, `idle`, or `needs_input` as completion.
- Treating launch exit code `0` as task success.
- Starting a second `run` after losing the observer.
- Losing the returned session ID or mixing IDs across parallel tasks.
- Using one shared worktree for concurrent coding agents.
