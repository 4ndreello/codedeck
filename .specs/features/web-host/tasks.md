# Configurable web console bind host tasks

## Test Coverage Matrix

> Generated from the supplied AGENTS.md instructions, `package.json`, `vitest.config.ts`, sampled `tests/web-*.test.ts` files, and the spec. The test runner is Vitest. Tests are scoped by file, and the full suite is never run.

| Code Layer | Required Test Type | Coverage Expectation | Test File | Vitest Command |
| ---------- | ------------------ | -------------------- | ---------- | -------------- |
| config | unit | WH-01 through WH-03: default, accepted IPv4/IPv6, invalid values, and exact warning text | `tests/web-port.test.ts` | `npx vitest run --no-cache tests/web-port.test.ts` |
| web security | integration | WH-11 through WH-13: exact loopback allowlist, bound-address acceptance, dynamic interfaces and MagicDNS hostnames, hostile Host rejection, token and cookie behavior, and same-origin POST checks | `tests/web-security.test.ts` | `npx vitest run --no-cache tests/web-security.test.ts` |
| web server | integration | WH-07 and WH-10: bind host, default host, returned base URL, and IPv6 URL formatting | `tests/web-server.test.ts` | `npx vitest run --no-cache tests/web-server.test.ts` |
| web child | unit | WH-06: parse explicit host and default to loopback, then pass the host into the listener | `tests/web-child.test.ts` | `npx vitest run --no-cache tests/web-child.test.ts` |
| daemon supervisor | unit | WH-09 and WH-10: pass host argument, restart on host changes, reuse matching host, and return the host-specific base URL | `tests/web-supervisor.test.ts` | `npx vitest run --no-cache tests/web-supervisor.test.ts` |
| daemon autostart | unit | WH-03 and WH-08: report invalid config in the daemon log and pass resolved host to `web.ensure` | `tests/daemon-web.test.ts` | `npx vitest run --no-cache tests/daemon-web.test.ts` |
| CLI launch/ui | unit and command integration | WH-03 through WH-05 and WH-14 through WH-16: config and flag resolution, reject invalid flag before IPC, wildcard links, warning text, and listen errors on both paths | `tests/web-launch.test.ts`, `tests/web-cli.test.ts` | `npx vitest run --no-cache tests/web-launch.test.ts tests/web-cli.test.ts` |
| docs | documentation assertions | Verify README and Portuguese protocol docs name `web.host`, `ui --host`, child `--host`, and `web.ensure` host | `tests/web-host-docs.test.ts` | `npx vitest run --no-cache tests/web-host-docs.test.ts` |

## Gate Check Commands

> Commands come from the repository's TypeScript and Vitest setup. The batches below stay within the files this feature changes.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After each task | The task's focused `npx vitest run --no-cache <test-file>` command from the matrix |
| Full | After implementation, run one batch at a time | `npx vitest run --no-cache tests/web-port.test.ts tests/web-security.test.ts`; `npx vitest run --no-cache tests/web-server.test.ts tests/web-child.test.ts`; `npx vitest run --no-cache tests/web-supervisor.test.ts tests/daemon-web.test.ts`; `npx vitest run --no-cache tests/web-launch.test.ts tests/web-cli.test.ts tests/web-host-docs.test.ts` |
| Build | Final typecheck and smoke build | `npx tsc --noEmit -p .` then `npx tsc -p .` |

## Execution Plan

Tasks run in order. Each task includes its tests, `tasks.md` status update, and its own commit.

```text
T01 -> T02 -> T03 -> T04 -> T05 -> T06 -> T07 -> T08 -> T09 -> T10 -> T11
```

### Phase 1: Resolve, secure, and bind

## Task Breakdown

#### T01: Resolve configured web host

Where: `src/config/web-host.ts`
WH IDs: WH-01, WH-02, WH-03
Depends on: none
Tests: Add resolver cases to `tests/web-port.test.ts` for default, IPv4, IPv6, invalid values, and JSON warning text.
Gate: `npx vitest run --no-cache tests/web-port.test.ts`
Status: Complete

#### T02: Enforce Host allowlist for non-loopback binds

Where: `src/web/security.ts`
WH IDs: WH-11, WH-12, WH-13
Depends on: T01
Tests: Update `tests/web-security.test.ts` for exact loopback names, injected per-request interfaces, hostname and MagicDNS suffixes, invalid Host, token/cookie redirects, and unchanged action checks.
Gate: `npx vitest run --no-cache tests/web-security.test.ts`
Status: Complete

#### T03: Bind web server and format its base URL

Where: `src/web/server.ts`
WH IDs: WH-07, WH-10
Depends on: T02
Tests: Update `tests/web-server.test.ts` for optional host, loopback default, wildcard URL mapping, direct IPv4 URL, and bracketed IPv6 URL.
Gate: `npx vitest run --no-cache tests/web-server.test.ts`
Status: Complete

#### T04: Parse the web child host argument

Where: `src/web/child.ts`
WH IDs: WH-06
Depends on: T03
Tests: Update `tests/web-child.test.ts` for `--host`, omitted host, and listener option propagation.
Gate: `npx vitest run --no-cache tests/web-child.test.ts`
Status: Complete

### Phase 2: Carry host through daemon and CLI

#### T05: Restart the supervisor child when its host changes

Where: `src/daemon/web-supervisor.ts`
Supporting files: `src/daemon/protocol.ts`, `src/config/web-host.ts`, and `src/web/server.ts`.
WH IDs: WH-09, WH-10
Depends on: T04
Tests: Update `tests/web-supervisor.test.ts` for child args, default host, host mismatch restart, matching-host reuse, unchanged port reuse, and base URL formatting.
Gate: `npx vitest run --no-cache tests/web-supervisor.test.ts`
Status: Complete

#### T06: Pass configured host during daemon autostart

Where: `src/daemon/daemon.ts`
WH IDs: WH-03, WH-08
Depends on: T05
Tests: Update `tests/daemon-web.test.ts` for resolved host in autostart params and invalid `web.host` log output.
Gate: `npx vitest run --no-cache tests/daemon-web.test.ts`
Status: Complete

#### T07: Add `ui --host` and CLI host output

Where: `src/cli/web-launch.ts`
Supporting file: `src/cli/commands/ui.ts`.
WH IDs: WH-03, WH-04, WH-05, WH-14, WH-15, WH-16
Depends on: T06
Tests: Update `tests/web-launch.test.ts` and `tests/web-cli.test.ts` for flag forwarding, pre-IPC validation, config warnings, wildcard links, warning text, and both listen failure paths.
Gate: `npx vitest run --no-cache tests/web-launch.test.ts tests/web-cli.test.ts`
Status: Complete

### Phase 3: Document the host setting

#### T08: Document configurable web host

Where: `README.md`
WH IDs: WH-04, WH-06, WH-08, WH-09
Depends on: T07
Tests: Add `tests/web-host-docs.test.ts` for required README and Portuguese `docs/protocol.md` details.
Gate: `npx vitest run --no-cache tests/web-host-docs.test.ts`
Status: Complete

### Phase 4: Remediate review findings

#### T09: Separate explicit and preferred host requests

Where: `src/daemon/protocol.ts`, `src/daemon/web-supervisor.ts`, `src/daemon/daemon.ts`, and `src/cli/web-launch.ts`
Supporting files: `README.md`, `docs/protocol.md`, and `.specs/features/web-host/spec.md`
WH IDs: WH-09, WH-17, WH-18, WH-19
Depends on: T08
Tests: Update `tests/web-supervisor.test.ts`, `tests/daemon-web.test.ts`, `tests/web-launch.test.ts`, and `tests/web-host-docs.test.ts` for host provenance, config preferences, explicit overrides, host reuse, and documentation.
Gate: `npx vitest run --no-cache tests/web-supervisor.test.ts tests/daemon-web.test.ts tests/web-launch.test.ts tests/web-host-docs.test.ts`
Status: Complete

#### T10: Keep canonical localhost redirects on wildcard binds

Where: `src/web/security.ts`
Supporting files: `docs/protocol.md` and `.specs/features/web-host/spec.md`
WH IDs: WH-20
Depends on: T09
Tests: Update `tests/web-security.test.ts` and `tests/web-host-docs.test.ts` for wildcard and specific bind redirect behavior.
Gate: `npx vitest run --no-cache tests/web-security.test.ts tests/web-host-docs.test.ts`
Status: Complete

#### T11: Restrict trusted console Host values

Where: `src/web/security.ts`
Supporting files: `README.md`, `docs/protocol.md`, and `.specs/features/web-host/spec.md`
WH IDs: WH-11, WH-12
Depends on: T10
Tests: Update `tests/web-security.test.ts` and `tests/web-host-docs.test.ts` for unlisted bind addresses, MagicDNS-only suffixes, hostile hostname prefixes, and default loopback rejection.
Gate: `npx vitest run --no-cache tests/web-security.test.ts tests/web-host-docs.test.ts`
Status: Complete

## Task Completion Record

Task completion and requirement traceability are updated in the same commit as each implementation task. The independent verifier owns `validation.md`.
