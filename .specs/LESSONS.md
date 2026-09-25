# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2

## Confirmed (load these at Specify/Design)

Corroborated across multiple features. Safe to apply as guidance.

_none_

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

### L-001 - Test a spec-defined timeout against the default constant, not an injected copy of the value, and assert nothing fires one tick before the deadline
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `timers` · harmful: 0
- features: web-daemon
- evidence: validation.md M6, M7, M21 (src/daemon/web-supervisor.ts:14, :15, :169) (timers)
- last seen: 2026-09-25T00:47:48Z

### L-002 - When tests inject a dependency, keep at least one test that omits the injection so the production default is exercised
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `seams` · harmful: 0
- features: web-daemon
- evidence: validation.md M8, M18, M22 (src/daemon/daemon.ts:1373, src/web/child.ts:26, src/daemon/web-supervisor.ts:94) (seams) (+1 more)
- last seen: 2026-09-25T00:53:07Z

### L-003 - List every error code the spec names as a trigger in the test table instead of a representative subset
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `error-mapping` · harmful: 0
- features: web-daemon
- evidence: validation.md M10 (src/cli/web-launch.ts:53, WD-44) (error-mapping)
- last seen: 2026-09-25T00:47:48Z

### L-004 - Assert the exact expected path instead of a pattern that a wrong path also matches
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `assertions` · harmful: 0
- features: web-daemon
- evidence: validation.md round 2 M32 (tests/web-launch.test.ts:48) (assertions)
- last seen: 2026-09-25T00:53:08Z

### L-005 - When a test parses source imports, cover static from, dynamic import() and bare side-effect imports
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `import-boundary` · harmful: 0
- features: web-daemon
- evidence: validation.md round 2 M27 (tests/web-supervisor.test.ts:287) (import-boundary)
- last seen: 2026-09-25T00:53:08Z

### L-006 - Assert the exact response body, not only the status code, on every rejection path whose message the spec pins
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `web-security` · harmful: 0
- features: web-access
- evidence: validation.md M9, M28 (src/web/security.ts:47,52; tests/web-security.test.ts:103,242) (web-security)
- last seen: 2026-09-25T01:54:46Z

### L-007 - Test the process entry block that wires argv into the main function, not only the argv parser and the main function separately
- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `entrypoints` · harmful: 0
- features: web-access
- evidence: validation.md M12 (src/web/child.ts:84) (entrypoints)
- last seen: 2026-09-25T01:54:46Z

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
