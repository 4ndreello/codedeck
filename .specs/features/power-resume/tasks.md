# Power Resume Tasks

## Coverage matrix

| Layer | Test type | Where | Command |
| ----- | --------- | ----- | ------- |
| codex parser | unit | `tests/codex-parser-errors.test.ts` | `npx vitest run tests/codex-parser-errors.test.ts` |
| codex session terminal (runtime + daemon) | integration over a log fixture | `tests/codex-reconnect-terminal.test.ts`, fixture `tests/fixtures/codex/` | `npx vitest run tests/codex-reconnect-terminal.test.ts` |
| auto-resume eligibility | unit (pure function) | `tests/power-auto-resume.test.ts` | `npx vitest run tests/power-auto-resume.test.ts` |
| auto-resume daemon boot | integration via `tests/helpers/daemon-seam.ts` | `tests/power-auto-resume.test.ts` | same |
| config schema | unit | `tests/power-auto-resume.test.ts` | same |
| service CLI (unit render + install/uninstall) | unit with stubbed fs/systemctl | `tests/service-install.test.ts` | `npx vitest run tests/service-install.test.ts` |
| doctor Power section | existing | `tests/power-doctor.test.ts` | `npx vitest run tests/power-doctor.test.ts` |
| README | none | - | - |

## Tasks

### T1: Codex non-fatal error frames (PRS-01..04)

- Files: `src/drivers/codex/parser.ts`, `tests/codex-parser-errors.test.ts`, `tests/codex-reconnect-terminal.test.ts`, `tests/fixtures/codex/*` (new fixtures only), plus existing tests that pin the old mapping
- Tests: the parser cases for PRS-01/02, the terminal-status cases for PRS-03/04
- Gate: `npx vitest run tests/codex-parser-errors.test.ts tests/codex-reconnect-terminal.test.ts tests/events.test.ts` green, `npx tsc --noEmit` clean

### T2: Opt-in auto-resume on daemon boot (PRS-05..10)

- Files: `src/config/config.ts` (field only), `src/daemon/auto-resume.ts` (new: eligibility + prompt constant), `src/daemon/daemon.ts` (one call after `recover()` plus the method that drives it), `tests/power-auto-resume.test.ts`
- Tests: one case per PRS-05..10
- Gate: `npx vitest run tests/power-auto-resume.test.ts tests/power-recover.test.ts tests/power-send.test.ts` green, `npx tsc --noEmit` clean

### T3: `codedeck service install|uninstall` (PRS-11..17)

- Files: `src/cli/commands/service.ts` (new), `src/cli/index.ts` (registration only), `tests/service-install.test.ts`, `README.md` (one section covering `service install` and the `autoResume` config key)
- Tests: unit render for PRS-11..13, stubbed systemctl for PRS-14..16, existing doctor test for PRS-17
- Gate: `npx vitest run tests/service-install.test.ts tests/power-doctor.test.ts` green, `npx tsc --noEmit` clean
