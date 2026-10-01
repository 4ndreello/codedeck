# Power Resume Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: none (the decisions table in `spec.md` covers the design; three small independent slices)
**Status**: In Progress

---

## Test Coverage Matrix

| Layer | Test type | Where | Command |
| ----- | --------- | ----- | ------- |
| codex parser | unit | `tests/codex-parser-errors.test.ts` | `npx vitest run tests/codex-parser-errors.test.ts` |
| codex session terminal (runtime + daemon) | integration | `tests/codex-reconnect-terminal.test.ts`, fixtures in `tests/fixtures/codex/` | `npx vitest run tests/codex-reconnect-terminal.test.ts` |
| auto-resume eligibility + config | unit | `tests/power-auto-resume.test.ts` | `npx vitest run tests/power-auto-resume.test.ts` |
| auto-resume daemon boot | integration | `tests/power-auto-resume.test.ts` via `tests/helpers/daemon-seam.ts` | `npx vitest run tests/power-auto-resume.test.ts` |
| service CLI | unit | `tests/service-install.test.ts` | `npx vitest run tests/service-install.test.ts` |
| doctor Power section | unit (existing) | `tests/power-doctor.test.ts` | `npx vitest run tests/power-doctor.test.ts` |
| README | none | - | - |

## Gate Check Commands

| Gate | Command |
| ---- | ------- |
| quick-t1 | `npx vitest run tests/codex-parser-errors.test.ts tests/codex-reconnect-terminal.test.ts tests/events.test.ts` |
| quick-t2 | `npx vitest run tests/power-auto-resume.test.ts tests/power-recover.test.ts tests/power-send.test.ts` |
| quick-t3 | `npx vitest run tests/service-install.test.ts tests/power-doctor.test.ts` |
| build | `npx tsc --noEmit` |

Never run the whole suite.

---

## Execution Plan

### Phase 1: Independent slices

T1, T2 and T3 own disjoint files and run in parallel. No task depends on another.

```
T1
T2
T3
```

---

## Task Breakdown

### T1: Treat codex error frames as non-fatal

**What**: `parseCodexLine` maps `type:"error"` to a non-terminal `error` event; `turn.failed`/`thread.failed` stay `session.failed`.
**Where**: `src/drivers/codex/parser.ts`
**Depends on**: None
**Reuses**: the existing `error` AgentEvent type in `src/core/events.ts`
**Requirement**: PRS-01, PRS-02, PRS-03, PRS-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Reconnect, skill-budget and websocket-fallback frames parse to `error`, never `session.failed`
- [ ] `turn.failed`/`thread.failed` still parse to `session.failed`
- [ ] A reconnect fixture ending in `turn.completed` + exit 0 ends `completed`
- [ ] An `error` + `turn.failed` fixture ends `failed`

**Tests**: unit + integration (`tests/codex-parser-errors.test.ts`, `tests/codex-reconnect-terminal.test.ts`)
**Gate**: quick-t1 + build

---

### T2: Opt-in auto-resume on daemon boot

**What**: `autoResume` config key, pure eligibility function + prompt constant, and one daemon boot step that resumes eligible shutdown-interrupted `run` sessions.
**Where**: `src/config/config.ts`, `src/daemon/auto-resume.ts` (new), `src/daemon/daemon.ts`
**Depends on**: None
**Reuses**: `runResumeTurn`, `sessionLocks`, `livePidIdentity`, `appendDaemonLog` in `src/daemon/daemon.ts`
**Requirement**: PRS-05, PRS-06, PRS-07, PRS-08, PRS-09, PRS-10

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Disabled config starts no turn
- [ ] Enabled config starts exactly one turn per eligible session with the fixed prompt
- [ ] Old, open-origin, no-native-id, non-SHUTDOWN, no-resume and live-identity rows stay untouched
- [ ] A failing resume is logged and does not stop the boot or the next session

**Tests**: unit + integration (`tests/power-auto-resume.test.ts`)
**Gate**: quick-t2 + build

---

### T3: `codedeck service install|uninstall`

**What**: A command that writes and enables a systemd user unit for the daemon, and removes it.
**Where**: `src/cli/commands/service.ts` (new), `src/cli/index.ts`, `README.md`
**Depends on**: None
**Reuses**: `powerServicePath()` in `src/cli/commands/doctor.ts`
**Requirement**: PRS-11, PRS-12, PRS-13, PRS-14, PRS-15, PRS-16, PRS-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Rendered unit has absolute ExecStart, captured PATH, `KillMode=process`, `WantedBy=default.target`
- [ ] Install writes the unit and runs daemon-reload + enable through an injectable runner
- [ ] Uninstall disables and removes the unit
- [ ] Non-Linux or missing systemctl exits 1 without writing
- [ ] Existing doctor test stays green

**Tests**: unit (`tests/service-install.test.ts`, existing `tests/power-doctor.test.ts`)
**Gate**: quick-t3 + build
