# web-host Validation (re-verification after remediation)

**Date**: 2026-09-25
**Spec**: `.specs/features/web-host/spec.md` (rewritten WH-09, WH-12; new WH-17 to WH-23)
**Diff range**: `main` (386e3af) `..` `ra/slice-configurable-bind-addres-f3c7` (218c1d0), 14 commits. Remediation commits: `27a9d43`, `44766ae`, `0f07a51`, `cb3fe41`, `88f9006`; test-only follow-up `218c1d0` (round 3)
**Verifier**: independent verifier (author ≠ verifier), read only over the worktree; mutations ran in a scratch rsync copy that was deleted afterwards

Verdict: PASS

---

## Task Completion

| Task | Status | Notes |
| ---- | ------ | ----- |
| T01-T08 | ✅ Done | unchanged since the first pass except `src/cli/web-launch.ts`, `src/daemon/daemon.ts` |
| T09 | ✅ Done | `host` / `preferredHost` split, `HostFor` provenance in `src/daemon/web-supervisor.ts:51,149-156` |
| T10 | ✅ Done | `src/web/security.ts:196` redirect keyed on the advertised base URL |
| T11 | ✅ Done | `src/web/security.ts:57,69-79`; round-2 survivors M2, M34, M36, M37 killed by `218c1d0` (round 3) |
| T12 | ✅ Done | `src/daemon/web-supervisor.ts:110-116` |
| T13 | ✅ Done | `src/daemon/protocol.ts` `WebEnsureResult.host`; `src/daemon/web-supervisor.ts:296`; `src/cli/web-launch.ts:80-93` |

---

## Spec-Anchored Acceptance Criteria

| ID | Spec-defined outcome | Implementation | Test `file:line` + assertion | Result |
| -- | -------------------- | -------------- | ---------------------------- | ------ |
| WH-01 | no `web.host` resolves to `127.0.0.1` | `src/config/web-host.ts:18,23` | `tests/web-port.test.ts:37` - `toEqual({ host: "127.0.0.1" })` for `{}` and `{ web: {} }` | ✅ PASS |
| WH-02 | IPv4/IPv6 string returned as is | `src/config/web-host.ts:24` | `tests/web-port.test.ts:41` - `toEqual({ host })` for `0.0.0.0`, `100.64.0.5`, `::`, `::1` | ✅ PASS |
| WH-03 | invalid value falls back to loopback; CLI stderr and daemon log `Ignoring invalid web.host in config: <JSON>` | `src/config/web-host.ts:19-30`; `src/cli/web-launch.ts:50`; `src/daemon/daemon.ts:1457-1459` | `tests/web-port.test.ts:50,55`; `tests/web-launch.test.ts:147` - `t.errors toEqual(['Ignoring invalid web.host in config: "deck.local"'])`; `tests/daemon-web.test.ts:196` - `toMatch(/\] Ignoring invalid web\.host in config: "deck\.local"\n/)` | ✅ PASS |
| WH-04 | `ui --host` overrides `web.host` for that launch | `src/cli/commands/ui.ts:79-85`; `src/cli/web-launch.ts:51,62` | `tests/web-cli.test.ts:109`; `tests/web-launch.test.ts:129` - second call `objectContaining({ host: "192.168.1.25" })` and `not.toHaveProperty("preferredHost")` | ✅ PASS |
| WH-05 | invalid `--host`: stderr `--host must be an IP address`, exit 1, no daemon request | `src/cli/commands/ui.ts:64-68` | `tests/web-cli.test.ts:120` - `launch not.toHaveBeenCalled()`, exact message, `process.exitCode toBe(1)` | ✅ PASS |
| WH-06 | child listens on `--host <addr>`; parse without `--host` = `127.0.0.1` | `src/daemon/web-supervisor.ts:186-188`; `src/web/child.ts:44,78-83` | `tests/web-supervisor.test.ts:62` - `args toEqual(["--web-child","--host","127.0.0.1"])`; `tests/web-child.test.ts:123,142-148` | ✅ PASS |
| WH-07 | in-process `startWebServer`/`listenWebServer` listen on resolved host, default `127.0.0.1` | `src/web/server.ts:132-138,174,181`; `src/cli/web-launch.ts:107-109` | `tests/web-server.test.ts:59,240,249`; `tests/web-launch.test.ts:156` - `options.host toBe("100.64.0.5")` | ✅ PASS |
| WH-08 | `autostartWeb` passes the config-resolved host | `src/daemon/daemon.ts:1457,1461` (`preferredHost: host`) | `tests/daemon-web.test.ts:160` - `toHaveBeenCalledWith({ preferredPort: 7788, preferredHost: "100.64.0.5" })`; `:185,196` loopback fallback (M30 killed) | ✅ PASS |
| WH-09 | explicit `host` different from running child → stop + start on requested host; omitted `host` does not move to `127.0.0.1`; port reuse unchanged | `src/daemon/web-supervisor.ts:125-131,150,154,159` | `tests/web-supervisor.test.ts:203` - `children[0].signals toEqual(["SIGTERM"])`, new args `--host 0.0.0.0`; `:218` same host reuses; `:256` `{ host: "100.64.0.5" }` then `ensure({})` `resolves.toEqual(first)`, `spawns toHaveLength(1)`; port rules `:331-361` (M28, M44 killed) | ✅ PASS |
| WH-10 | base URL `http://127.0.0.1:<port>` for `127.0.0.1`/`0.0.0.0`/`::`, else `http://<host>:<port>`, IPv6 bracketed | `src/config/web-host.ts:32-37`; `src/daemon/web-supervisor.ts:248`; `src/web/server.ts:153` | `tests/web-server.test.ts:240`; `tests/web-supervisor.test.ts:325` - `toMatchObject({ baseUrl: \`http://${urlHost}:4100\`, host })` | ✅ PASS |
| WH-11 | `127.0.0.1` bind allows exactly `127.0.0.1:<port>` and `localhost:<port>` | `src/web/security.ts:50-51` | `tests/web-security.test.ts:160` both accepted; `:172` unapproved rejected; `:443` `deck-host:<port>` and `192.168.1.25:<port>` → `403`, body `"forbidden"`, `calls toEqual([])` (M1 killed) | ✅ PASS |
| WH-12 | non-loopback bind: exact non-wildcard bind address, current interfaces (per request, injectable, IPv6 bracketed, `%` skipped), exact `os.hostname()`, and `<hostname>.<one or more labels>.ts.net`; `<hostname>.evil.com` rejected | `src/web/security.ts:53-66,69-79` | `tests/web-security.test.ts:363` accepted IPv4, `[fd7a:115c:a1e0::1]`, `deck-host`, `DECK-HOST.tail1234.ts.net` (303) and rejected `deck-host.evil.com`, `deck-hostile`, wrong port, zone, bracketed IPv4, unbracketed IPv6, `deck-hostile.tail1234.ts.net`, `deck-host.ts.net`, `deck-host..ts.net`, `deck-host.a_b.ts.net` (403, `:388-391`); `:404` `it.each` wildcard binds `0.0.0.0` / `::` reject `0.0.0.0:<port>` / `[::]:<port>` with 403 `forbidden`, `calls toEqual([])`; `:424` unlisted bind `127.0.0.2` → 303; `:461` per-request interfaces (M2, M33, M34, M35, M36, M37 killed) | ✅ PASS |
| WH-13 | accepted Host keeps token/cookie/same-origin/`/api/*`; bare Tailscale-IP page GET = existing 403 body; `?t=` = 303 + cookie | `src/web/security.ts:105-125` | `tests/web-security.test.ts:478` - `barePage.status 403`, `body toBe(PAGE_FORBIDDEN)`, `tokenPage.status 303`, exact `set-cookie`, API without cookie 403, cross-origin POST 403 | ✅ PASS |
| WH-14 | wildcard: one `Also on http://<ip>:<port><path>?t=<token>` per non-internal IPv4 after the base line | `src/cli/web-launch.ts:93,121,144-159` | `tests/web-launch.test.ts:166` (`0.0.0.0`, `::`), `:189` daemon-reported wildcard, `:221` in-process | ✅ PASS |
| WH-15 | host outside `127.0.0.0/8` and `::1`: exact plain-HTTP warning | `src/cli/web-launch.ts:81,120,135-141` | `tests/web-launch.test.ts:129,189` exact string; `:242` none for `127.0.0.2`, `::1` | ✅ PASS |
| WH-16 | listen failure: `Failed to listen on <host>:<port>: <message>`, IPv6 bracketed, exit 1 | `src/cli/web-launch.ts:73,123,130-132` | `tests/web-launch.test.ts:291` daemon path `toEqual(["Failed to listen on [::1]:4200: listen EADDRINUSE"])`, returns 1; `:300` in-process | ✅ PASS |
| WH-17 | `preferredHost` differs and child started for preferred or none → stop + start on `preferredHost` | `src/daemon/web-supervisor.ts:151-152` | `tests/web-supervisor.test.ts:240-253` (`it.each` preferred / none) - `children[0].signals toEqual(["SIGTERM"])`, `spawns[1].args toEqual(["--web-child","--host","0.0.0.0","--preferred-port","7777"])` (M27 killed) | ✅ PASS |
| WH-18 | `preferredHost` with an explicitly bound child keeps the explicit host | `src/daemon/web-supervisor.ts:151,154` | `tests/web-supervisor.test.ts:230` - `resolves.toEqual(first)`, `spawns toHaveLength(1)`, `signals toEqual([])` (M26 killed) | ✅ PASS |
| WH-19 | neither host field: reuse running child at any host; start on `127.0.0.1` when none | `src/daemon/web-supervisor.ts:154-155` | `tests/web-supervisor.test.ts:256` reuse of a `100.64.0.5` child; `:62` fresh start args `--host 127.0.0.1` (M28 killed) | ✅ PASS |
| WH-20 | `Host: localhost:<port>` page GET on `127.0.0.1`/`0.0.0.0`/`::` bind → `302` to `http://127.0.0.1:<port>`; other binds skip it | `src/web/security.ts:191-196` | `tests/web-security.test.ts:260` loopback; `:278` `0.0.0.0` bind `status 302`, exact `location`; `:290` specific bind `403`, `location toBeUndefined()` (M31, M32 killed). `::` bind covered only through `webBaseUrl` (WH-10 tests) | ✅ PASS |
| WH-21 | invalid `host`/`preferredHost` → `WEB_BAD_HOST` before stopping a running child | `src/daemon/web-supervisor.ts:110-116` | `tests/web-supervisor.test.ts:266-277` both fields, `rejects.toMatchObject({ code: "WEB_BAD_HOST" })`, `spawns toHaveLength(1)`, `signals toEqual([])`; `tests/daemon-web.test.ts:53` IPC error code, `spawnChild not.toHaveBeenCalled()` (M38, M39, M40 killed) | ✅ PASS |
| WH-22 | successful `web.ensure` result includes `host` with `baseUrl`, port, token | `src/daemon/protocol.ts` `WebEnsureResult.host`; `src/daemon/web-supervisor.ts:296` | `tests/web-supervisor.test.ts:62` `toEqual({ baseUrl, host: "127.0.0.1", port, token })`; `:203`, `:325`; `tests/daemon-web.test.ts:31` passthrough (M41 killed) | ✅ PASS |
| WH-23 | CLI uses returned `host` for warning and wildcard links; requested host only when `host` is absent | `src/cli/web-launch.ts:80-81,93` | `tests/web-launch.test.ts:189` returned `0.0.0.0` → warning + `Also on` link; `:206` config `0.0.0.0` but returned `127.0.0.1` → `errors toEqual([])`, only the base line; `:129` fallback (`BASE` has no `host`) warns for the requested hosts (M42, M43 killed) | ✅ PASS |

**Documentation requirement**: `README.md:110-114` and `docs/protocol.md:50-57,71-93,109` describe `web.host`, `ui --host`, child `--host`, `host`/`preferredHost`, the returned `host`, the redirect scope, and `WEB_BAD_HOST`. Asserted by `tests/web-host-docs.test.ts:12,26` (`toContain`). ✅ PASS

**Status**: ✅ 23/23 PASS. WH-12 was a GAP in round 2; `218c1d0` added the negative cases and round 3 kills all four survivors.

---

## Discrimination Sensor

Scratch: `rsync -a --exclude .git --exclude node_modules <worktree>/ <scratchpad>/mut2-web-host/` plus `node_modules` symlink to `/home/andreello/dev/codedeck/node_modules`. A Python driver applied one exact-string replacement at a time (asserting a single match), ran the listed file with `npx vitest run --no-cache <file>`, and restored the original in a `finally`. `diff -r` of `src/` against the worktree was empty after the run. Baseline in the scratch before mutating: `tests/web-security.test.ts` 17 passed (17).

### Round 1 re-run (first-pass survivors)

| # | WH | File:line | Fault | Test file | Result | Killed? |
| - | -- | --------- | ----- | --------- | ------ | ------- |
| M1 | WH-11 | `src/web/security.ts:51` | `if (!security \|\| security.host === DEFAULT_WEB_HOST) return false;` → `if (!security) return false;` | `tests/web-security.test.ts` | 1 failed, 16 passed (17): `rejects machine hostname and non-loopback interface Hosts on the default bind` | ✅ Killed |
| M2 | WH-12 | `src/web/security.ts:71` | `!name.startsWith(\`${hostname}.\`)` → `!name.startsWith(hostname)` | `tests/web-security.test.ts` | 17 passed (17), exit 0 | ❌ Survived |

M2 note: the added `deck-hostile:<port>` negative case does not kill M2 any more, because the ts.net label check now rejects it on its own. The mutant still accepts `deck-hostile.tail1234.ts.net` (probe below), which is not `<hostname>.<labels>.ts.net`.

### Round 2 (remediation faults)

| # | Finding / WH | File:line | Fault | Test file | Result | Killed? |
| - | ------------ | --------- | ----- | --------- | ------ | ------- |
| M26 | R1 / WH-18 | `src/daemon/web-supervisor.ts:151` | drop `&& running?.hostFor !== "explicit"` (preferredHost moves an explicit child) | `tests/web-supervisor.test.ts` | 1 failed, 40 passed (41) | ✅ Killed |
| M27 | R1 / WH-17 | `src/daemon/web-supervisor.ts:151` | condition → `params.preferredHost !== undefined && !running` (preferred child no longer moved) | same | 2 failed, 39 passed (41) | ✅ Killed |
| M28 | R1 / WH-09, WH-19 | `src/daemon/web-supervisor.ts:154` | delete the "reuse running host" branch (omitted host falls back to `127.0.0.1`) | same | 2 failed, 39 passed (41) | ✅ Killed |
| M29 | R1 / WH-04 | `src/cli/web-launch.ts:62` | always send `host` (config value becomes explicit) | `tests/web-launch.test.ts` | 3 failed, 25 passed (28) | ✅ Killed |
| M30 | R1 / WH-08 | `src/daemon/daemon.ts:1461` | autostart sends `host` instead of `preferredHost` | `tests/daemon-web.test.ts` | 4 failed, 8 passed (12) | ✅ Killed |
| M44 | WH-09 | `src/daemon/web-supervisor.ts:159` | delete the host comparison in `matches` | `tests/web-supervisor.test.ts` | 3 failed, 38 passed (41) | ✅ Killed |
| M31 | R2 / WH-20 | `src/web/security.ts:196` | revert to `if (security.host !== DEFAULT_WEB_HOST) return false;` (wildcard redirect removed) | `tests/web-security.test.ts` | 1 failed, 16 passed (17) | ✅ Killed |
| M32 | R2 / WH-20 | `src/web/security.ts:196` | delete the bind guard (redirect on every bind) | same | 1 failed, 16 passed (17) | ✅ Killed |
| M33 | R3 / WH-12 | `src/web/security.ts:57` | delete bound-address acceptance | same | 1 failed, 16 passed (17) | ✅ Killed |
| M34 | R3 / WH-12 | `src/web/security.ts:57` | drop the `0.0.0.0` / `::` exclusion (wildcard literal accepted as Host) | same | 17 passed (17) | ❌ Survived |
| M35 | R4 / WH-12 | `src/web/security.ts:73-78` | return `labels.length >= 1` (any `<hostname>.<anything>`) | same | 1 failed, 16 passed (17) | ✅ Killed |
| M36 | R4 / WH-12 | `src/web/security.ts:74` | `labels.length >= 3` → `>= 2` (accepts `<hostname>.ts.net`) | same | 17 passed (17) | ❌ Survived |
| M37 | R4 / WH-12 | `src/web/security.ts:77` | drop the per-label regex (accepts empty or invalid labels) | same | 17 passed (17) | ❌ Survived |
| M38 | R5 / WH-21 | `src/daemon/web-supervisor.ts:110-116` | delete the `WEB_BAD_HOST` check | `tests/web-supervisor.test.ts` | 2 failed, 39 passed (41) | ✅ Killed |
| M39 | R5 / WH-21 | `src/daemon/web-supervisor.ts:110-116,130` | move the check after `await this.stop(previous)` | same | 2 failed, 39 passed (41) | ✅ Killed |
| M40 | R5 / WH-21 | `src/daemon/web-supervisor.ts:111` | validate only `host`, not `preferredHost` | same | 1 failed, 40 passed (41) | ✅ Killed |
| M41 | T13 / WH-22 | `src/daemon/web-supervisor.ts:296` | drop `host` from `resultOf` | same | 6 failed, 35 passed (41) | ✅ Killed |
| M42 | T13 / WH-23 | `src/cli/web-launch.ts:80` | `activeHost = host` (ignore returned host) | `tests/web-launch.test.ts` | 2 failed, 26 passed (28) | ✅ Killed |
| M43 | T13 / WH-23 | `src/cli/web-launch.ts:80` | fallback `web.host ?? "127.0.0.1"` (ignore requested host) | same | 3 failed, 25 passed (28) | ✅ Killed |

**Survivor impact probe** (scratch, `npx tsx probe.ts` calling `isAllowedWebHost(\`${h}:7777\`, 7777, createWebSecurity(7777, "t", { host: "0.0.0.0", hostname: () => "deck-host", networkInterfaces: () => ({}) }))`):

| Host name | original | M2 | M34 | M36 | M37 |
| --------- | -------- | -- | --- | --- | --- |
| `deck-hostile.tail1234.ts.net` | false | **true** | false | false | false |
| `0.0.0.0` | false | false | **true** | false | false |
| `deck-host.ts.net` | false | false | false | **true** | false |
| `deck-host..ts.net` | false | false | false | false | **true** |
| `deck-host.a_b.ts.net` | false | false | false | false | **true** |
| `deck-host.tail1234.ts.net` (valid) | true | true | true | true | true |

Each survivor accepts a Host that WH-12 excludes (`<hostname>.<one or more labels>.ts.net`, "exact non-wildcard bind address").

**Sensor depth**: P0-style manual run (security surface): 2 re-run + 19 new mutants
**Round 2 outcome** (historical): 17 killed, 4 survived (M2, M34, M36, M37) - ❌ FAIL

### Round 3 (re-run of round-2 survivors after `218c1d0`)

`git show --stat 218c1d0` touches only `.specs/features/web-host/run-notes.md`, `.specs/features/web-host/tasks.md`, and `tests/web-security.test.ts` (no file under `src/`). Scratch: `rsync -a --exclude .git --exclude node_modules <worktree>/ <scratchpad>/mut4/` plus `node_modules` symlink. A Python driver applied one exact-string replacement (asserting a single match) to a pristine copy of `src/web/security.ts`, ran `npx vitest run --no-cache tests/web-security.test.ts`, and restored the pristine file before the next fault; `cmp` against the pristine copy was clean after the run, and the scratch was deleted with `rm -r`. Baseline in the scratch: 19 passed (19).

| # | WH | File:line | Fault | Result | Killed? |
| - | -- | --------- | ----- | ------ | ------- |
| M2 | WH-12 | `src/web/security.ts:71` | `!name.startsWith(\`${hostname}.\`)` → `!name.startsWith(hostname)` | 1 failed, 18 passed (19): `allows current interface addresses, the machine hostname, and its MagicDNS suffix` | ✅ Killed |
| M34 | WH-12 | `src/web/security.ts:57` | drop `security.host !== "0.0.0.0" && security.host !== "::" &&` | 2 failed, 17 passed (19): `rejects wildcard bind '0.0.0.0' as a Host header`, `rejects wildcard bind '::' as a Host header` | ✅ Killed |
| M36 | WH-12 | `src/web/security.ts:74` | `labels.length >= 3` → `>= 2` | 1 failed, 18 passed (19): `allows current interface addresses, ...` | ✅ Killed |
| M37 | WH-12 | `src/web/security.ts:77` | per-label regex `every(...)` → `true` | 1 failed, 18 passed (19): `allows current interface addresses, ...` | ✅ Killed |

**Round 3 result**: 4/4 killed. **Cumulative**: 21/21 round-1/2 mutants killed - ✅ PASS

---

## Code Quality

| Principle | Status |
| --------- | ------ |
| Minimum code | ⚠️ `src/web/security.ts:62` zone guard is still redundant with `:54` (first-pass M4, equivalent) |
| Surgical changes | ✅ remediation touches only the files named in T09-T13 |
| No scope creep | ✅ |
| Matches patterns | ✅ `HostFor` mirrors the existing `StartedFor` provenance |
| Spec-anchored outcome check | ✅ exact codes, strings, and args asserted for WH-09, WH-17 to WH-23 |
| Per-layer Coverage Expectation met | ✅ web security: MagicDNS suffix boundaries and wildcard-literal rejection asserted (`tests/web-security.test.ts:388-391,404`) |
| Every test maps to a spec requirement | ✅ |
| Documented guidelines followed | ✅ `CLAUDE.md` (scoped vitest runs, English code) |

---

## Edge Cases

- [x] Invalid values include non-strings and non-IP strings: `tests/web-port.test.ts:50`
- [x] Child with no `--host` keeps loopback: `tests/web-child.test.ts:142-148`
- [x] Host change restarts even when the port allows reuse: `tests/web-supervisor.test.ts:203`
- [x] Unlisted name or wrong port forbidden: `tests/web-security.test.ts:363`
- [x] Hostname matching limited to exact hostname or `<hostname>.<labels>.ts.net`: `tests/web-security.test.ts:388-391` (M2, M36, M37 killed)
- [x] Wildcard bind literal rejected as Host: `tests/web-security.test.ts:404` (M34 killed)
- [x] Non-wildcard bind address accepted when absent from interfaces: `tests/web-security.test.ts:400`
- [x] IPv6 zone addresses excluded: `tests/web-security.test.ts:363`
- [x] `--host` validation before the daemon: `tests/web-cli.test.ts:120`
- [x] Invalid `web.ensure` host fields rejected before stopping a child: `tests/web-supervisor.test.ts:266`

---

## Gate Check

- **Build gate**: `npx tsc --noEmit -p .` → exit 0 (emitting build not run; it writes `dist/`)
- **Full gate** (round 3, worktree at `218c1d0`; the four batches were launched as concurrent tool calls, not strictly sequential):
  - `npx vitest run --no-cache tests/web-port.test.ts tests/web-security.test.ts` → 2 files, 41 passed (41)
  - `npx vitest run --no-cache tests/web-server.test.ts tests/web-child.test.ts` → 2 files, 36 passed (36)
  - `npx vitest run --no-cache tests/web-supervisor.test.ts tests/daemon-web.test.ts` → 2 files, 53 passed (53)
  - `npx vitest run --no-cache tests/web-launch.test.ts tests/web-cli.test.ts tests/web-host-docs.test.ts` → 3 files, 46 passed (46)
- **Result**: 176 passed, 0 failed, 0 skipped (round 2: 174, first pass: 161)
- **Test integrity**: remediation diff `c1c1761..HEAD` adds cases and rewrites expectations from `host` to `preferredHost`; no test removed. The shared `running()` helper moved from `describe("WebSupervisor port rules")` to module scope, same body.
- **Worktree isolation**: `git status --porcelain` was `?? .specs/features/web-host/validation.md` before and after the gate and sensor runs.

---

## Fix Plans

Fix 1 and Fix 2 are resolved by `218c1d0` (round 3). Kept for the record.

### Fix 1: WH-12 MagicDNS suffix boundaries are untested (M2, M36, M37)

- **Root cause**: the negative list in `tests/web-security.test.ts:383-391` has no ts.net-shaped name that breaks the hostname boundary, the label count, or the label syntax.
- **Fix task**: add `deck-hostile.tail1234.ts.net:${port}`, `deck-host.ts.net:${port}`, `deck-host..ts.net:${port}`, and `deck-host.a_b.ts.net:${port}` to that 403 list.
- **Done when**: M2, M36, and M37 are killed by `npx vitest run --no-cache tests/web-security.test.ts`.
- **Priority**: Major (M2 is the first-pass survivor and still alive)

### Fix 2: wildcard literal Host is untested (M34)

- **Root cause**: no test sends `Host: 0.0.0.0:<port>` or `[::]:<port>` to a wildcard-bound server.
- **Fix task**: `makeExtendedServer(networkInterfaces, () => "deck-host", { host: "0.0.0.0" })` with interfaces that do not list `0.0.0.0`, then assert `0.0.0.0:<port>` gets 403 `forbidden`; same for `{ host: "::" }` and `[::]:<port>`.
- **Done when**: M34 is killed by the same command.
- **Priority**: Minor (spec says "exact non-wildcard bind address"; token and cookie still apply)

### Observation (not a WH gap): daemon-path listen failure names the requested host

`src/cli/web-launch.ts:73` builds `Failed to listen on <host>:...` from the requested host. When the supervisor keeps a retained explicit bind (WH-18) and has to restart it (for example a new build) on a busy port, the message names `web.host` instead of the address that failed, because `WEB_LISTEN_FAILED` details carry only `port`. Not reproduced here; code reading only. Low.

---

## Requirement Traceability Update

`spec.md` traceability updated after round 3 (verdict PASS):

| Requirement | Before | After |
| ----------- | ------ | ----- |
| WH-01..WH-08, WH-10, WH-11, WH-13..WH-16 | Verified | ✅ Verified |
| WH-09, WH-12, WH-17..WH-23 | Implemented | ✅ Verified (evidence above) |

---

## Summary

**Overall**: ✅ Ready

**Spec-anchored check**: 23/23 ACs PASS, 0 spec-precision gaps
**Sensor**: 21/21 killed (round 3 killed M2, M34, M36, M37)
**Gate**: 176 passed, tsc clean

**What works**: R1 (host provenance, explicit bind kept, preferred bind moved, no-host reuse), R2 (wildcard localhost redirect), R3 (bound address accepted), R5 (`WEB_BAD_HOST` before stop), T13 (returned host drives warning and links), and the loopback exactness gap M1 from the first pass.

**Issues found**: none open. Fix 1 and Fix 2 (test-only) landed in `218c1d0`. The daemon-path listen-failure observation stays Low and outside the WH criteria.

**Not covered**: `::` bind localhost redirect through a real server; interaction of retained explicit bind with a build-triggered restart that fails to listen; real Tailscale interfaces (all interface data injected); `dist/` gate scripts; lessons distillation (`lessons.py` writes outside the two files this verifier may edit).
