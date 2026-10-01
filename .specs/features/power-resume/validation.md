# Power Resume Validation

Branch `feat/power-resume`, base `d8ce482`, 2026-10-01.

## Slices

| Session | Task | Commit on feature branch | Disposition |
| ------- | ---- | ------------------------ | ----------- |
| b29ad5b077ac730c | T3 service install/uninstall | 06f8c01 | accepted |
| f3753c3c2077bb91 | T2 opt-in auto-resume | 79db6bd | accepted |
| b50a1bc9f5aceb5b | T1 (first attempt) | none | superseded: stopped on invalid tasks.md, then its resume turn could not write git metadata |
| 1be483548e7ad9f6 | T1 codex error frames | 313ec17 | accepted |
| 9baf3499bf6be8d3 | final read-only review | none | 3 minor findings confirmed, remediated below |
| ac532e9bc111739e | F1 `$` escaping + env note | 2ee32fe | accepted |
| b5f154b7267f0b47 | F2 missing workdir + pending clear | 5510d8f | accepted, pending semantics corrected by next row |
| 9a68a9f5f0395330 | F2b carry queued message into the resume turn | 5cb039e | accepted |

Orchestrator commits: 81cc985, 97b046d (spec), 585d341 (README wording).

## Gates (run by the orchestrator on the integrated branch)

```
npx vitest run tests/codex-parser-errors.test.ts tests/codex-reconnect-terminal.test.ts tests/events.test.ts tests/power-auto-resume.test.ts tests/power-recover.test.ts tests/power-send.test.ts tests/service-install.test.ts tests/power-doctor.test.ts
 Test Files  8 passed (8)
      Tests  56 passed (56)
npx tsc --noEmit -> exit 0
npm run build -> exit 0
npx vitest run tests/setup-cli-contract.test.ts tests/web-cli.test.ts tests/doctor-roles.test.ts tests/power-ps.test.ts tests/review-command.test.ts
 Test Files  5 passed (5)
      Tests  72 passed (72)
```

## Mutation probes (orchestrator, scratch edits reverted with git checkout)

| Fault | Result |
| ----- | ------ |
| drop `origin === "open"` guard | killed (1 failed) |
| drop `failure.code !== "SHUTDOWN"` guard | killed (1 failed) |
| ignore `autoResume.enabled` | killed (1 failed) |
| drop `KillMode=process` | killed (1 failed) |
| pretend daemon-reload succeeded | killed (1 failed) |
| stop treating `turn.failed` as terminal | killed (2 failed) |
| keep `{message}` objects as the error | killed (2 failed) |

7 killed, 0 survived. Workers reported their own probes (age check, PATH line, old error mapping, `$` escape, workdir check, pending clear, prompt builder): all killed.

## systemd parsing check

`systemd-analyze --user verify` on a scratch unit: an executable path with a single `$` resolves, `$$` is taken literally. So `$` is escaped only in ExecStart arguments, not in the executable.

## Residual risks (not fixed)

- A fatal codex `error` with no `turn.failed` that exits 0 would end `completed`. Not seen in 61 real codex `error` frames.
- SIGINT and SIGHUP also mark `SHUTDOWN` with `retryable: true`, so with auto-resume on, a Ctrl-C of a foreground daemon resumes on the next boot.
- The user unit does not wait for the network; a codex resumed at login can use up its 5 reconnects.
- If shutdown lands after the harness received the resume prompt but before the turn is recorded, the restored queued message can be sent again on the next boot.
- Observed once: a `codex exec resume` turn could not write the worktree's git metadata (`cannot lock ref ORIG_HEAD: Read-only file system`), while first turns committed fine. Root cause not investigated. It would also limit auto-resumed codex turns.
