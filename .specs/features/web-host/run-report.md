## Done

Branch: [feat/web-console-host](https://github.com/4ndreello/codedeck/tree/feat/web-console-host)

Commit: [218c1d042794d6d4e4a81887386a461411fc99d7](https://github.com/4ndreello/codedeck/commit/218c1d042794d6d4e4a81887386a461411fc99d7)

The orchestrator owns the post-HEAD push, PR, and commits for `validation.md` and this report. At report time, `git ls-remote origin feat/web-console-host` returned no ref and `gh pr list --head feat/web-console-host --state all --json number,url,state` returned `[]`.

The feature adds `web.host`, an IPv4 or IPv6 bind address, and `codedeck ui --host <addr>` as a per-launch override. The default remains `127.0.0.1`. Host checks on remote binds accept the exact non-wildcard bind IP, current interface IPs, the exact machine hostname, and `<machine-hostname>.<one or more labels>.ts.net`, all on the console port. Existing token, cookie, and origin checks remain in place. An explicit host stays pinned on the running child, while `preferredHost` can move a child started from a preference or with no host request. Invalid daemon host fields return `WEB_BAD_HOST` before child state changes. Non-loopback binds print a plain-HTTP warning after listening succeeds. Wildcard binds print an `Also on` link for each non-internal IPv4 interface, preserving the page path, query, and token.

To enable access over Tailscale, set this in the config:

```json
{ "web": { "host": "0.0.0.0" } }
```

Or run `codedeck ui --host 0.0.0.0`. Open the printed `Also on http://<tailscale-ip>:7777/?t=...` link once in each browser.

Verification:

- Final `validation.md` says `Verdict: PASS`. It records 23/23 acceptance criteria passing and 21/21 mutants killed.
- Final scoped Vitest batches, after the test-only follow-up, reported:
  - `npx vitest run --no-cache tests/web-port.test.ts tests/web-security.test.ts` -> 2 files, 41 passed (41).
  - `npx vitest run --no-cache tests/web-server.test.ts tests/web-child.test.ts` -> 2 files, 36 passed (36).
  - `npx vitest run --no-cache tests/web-supervisor.test.ts tests/daemon-web.test.ts` -> 2 files, 53 passed (53).
  - `npx vitest run --no-cache tests/web-launch.test.ts tests/web-cli.test.ts tests/web-host-docs.test.ts` -> 3 files, 46 passed (46).
- Test-only commit `218c1d0` added two security cases to the first batch, raising it from 39 to 41. The final four batches total 176 passed, 0 failed, 0 skipped.
- `npx tsc --noEmit -p .` exited 0.
- Worker `6005`'s final smoke log, read with `codedeck logs 6005`, records a built child on `0.0.0.0` and port 42361. It reports `wildcard localhost status=302 location=http://127.0.0.1:42361/`, a remote IPv4 Host without a token returning the 403 page and with `?t=` returning 303, `evil.example` returning 403 forbidden, and a tokenized link on a `127.0.0.2` bind returning 303.

`git log --oneline main..HEAD`:

```text
218c1d0 test(web): Cover rejected console Host names on remote binds
88f9006 fix(cli): Use the active console host for links
cb3fe41 fix(daemon): Reject a non-IP console host in web.ensure
0f07a51 fix(web): Restrict accepted console Host values
44766ae fix(web): Redirect localhost on wildcard console binds
27a9d43 fix(daemon): Keep an explicit console host across web commands
c1c1761 docs(web): Document the configurable console bind host
540baed feat(cli): Support configurable console bind hosts
cac7c58 feat(daemon): Pass the configured host to web autostart
cbad7b0 feat(daemon): Restart the web child when its host changes
6717adf feat(web): Pass the bind host to the web child
86d9fd8 feat(web): Bind the console server to its configured host
2c783ec feat(web): Accept trusted Host headers on configured binds
e0a139f feat(config): Resolve the console bind host from web.host
```

`git diff --stat main..HEAD`:

```text
.specs/features/web-host/run-notes.md |  34 +++++++++++
.specs/features/web-host/spec.md      | 165 +++++++++++++++++++++++++++++++++++++++++++++++++++++
.specs/features/web-host/tasks.md     | 181 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++
README.md                             |  19 +++++++
docs/protocol.md                      |  38 ++++++++++---
src/cli/commands/ui.ts                |  17 +++++-
src/cli/web-launch.ts                 |  65 ++++++++++++++++++---
src/config/web-host.ts                |  37 ++++++++++++
src/daemon/daemon.ts                  |   8 ++-
src/daemon/protocol.ts                |   6 ++
src/daemon/web-supervisor.ts          |  44 +++++++++++---
src/web/child.ts                      |  16 ++++--
src/web/security.ts                   |  68 ++++++++++++++++++++--
src/web/server.ts                     |  17 +++++--
tests/daemon-web.test.ts              |  51 +++++++++++++----
tests/web-child.test.ts               |  18 ++++--
tests/web-cli.test.ts                 |  25 ++++++++
tests/web-host-docs.test.ts           |  41 +++++++++++++
tests/web-launch.test.ts              | 160 ++++++++++++++++++++++++++++++++++++++++++++++++++-
tests/web-port.test.ts                |  29 ++++++++++
tests/web-security.test.ts            | 266 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++--
tests/web-server.test.ts              |  32 +++++++++++
tests/web-supervisor.test.ts          | 113 +++++++++++++++++++++++++++++++-----
23 files changed, 1375 insertions(+), 75 deletions(-)
```

## Assumptions I made

1. [Assumption] WH-01 through WH-16 are the acceptance source; keep the `127.0.0.1` default.
2. [Assumption] A non-object `web` value is an invalid `web.host` setting and its raw JSON value is reported.
3. [Assumption] A valid `ui --host` overrides the configured host for that launch; an invalid configured host still warns.
4. [Decision] Store the requested host with running-child state because the child handshake omits it.
5. [Assumption] Compare Host names case-insensitively and require the exact console port.
6. [Assumption] Wildcard alternate links use each non-internal IPv4 interface and preserve path, query, and token.
7. [Decision] Advertise loopback for `127.0.0.1`, `0.0.0.0`, and `::`; bracket other IPv6 hosts.
8. [Decision] Suppress the HTTP warning for IPv4 `127.0.0.0/8` and IPv6 `::1`.
9. [Assumption] Check only the two required documentation files in the focused docs test.
10. [Blocker] The first T01 gate stopped because Vitest could not resolve `vitest/config` and no install-free runner was available; dependency installation was out of scope.
11. [Decision] Run Vitest with `--no-cache` because its default cache write failed through the read-only `node_modules` symlink.
12. [Decision] Resume with the provided dependency symlink after confirmation, and leave it untouched.
13. [Decision] Use lowercase commit subjects because `check_commit.py` rejects capitalized subjects.
14. [Blocker] An initial T01 commit attempt failed when Git could not create the worktree index lock outside the writable roots.
15. [Deviation] Leave per-task commits to the orchestrator because the sandbox could not write Git metadata.
16. [Decision] Initially redirect `localhost` only for the default loopback bind; later review widened this to binds that advertise the loopback base URL.
17. [Blocker] Initial T02 security tests could not bind a local TCP listener: all 13 failed with `listen EPERM` before assertions, though typecheck passed.
18. [Decision] A continuation requested capitalized subjects, including the exact T01 message, despite the checker rejection.
19. [Deviation] Commit T01 and T02 separately after rerunning their gates.
20. [Decision] Share URL formatting from `src/config/web-host.ts` so the supervisor and server use the same mapping without crossing the daemon import boundary.
21. [Decision] Print the HTTP warning only after listening succeeds so it names the actual port.
22. [Bucket 1 decision] An explicit host pins its child; `web.host` is a preference; omitted host fields reuse a running child or start on loopback.
23. [Decision] Capitalize commit subjects after the Conventional Commit prefix to match repository history, despite the checker's lowercase requirement.
24. [Bucket 1 decision] Redirect localhost when the advertised base URL is loopback for `127.0.0.1`, `0.0.0.0`, or `::`; skip the redirect for other bind addresses.
25. [Bucket 1 decision] Trust the configured non-wildcard bind IP even when it is absent from the interface list.
26. [Bucket 1 decision] Accept the exact machine hostname or one or more labels followed by `.ts.net`; reject broader suffix matches.
27. [Bucket 1 decision] Keep tests proving that injected hostnames and non-loopback interface IPs are rejected on the default loopback bind.
28. [Bucket 1 decision] Validate `web.ensure` host fields before changing child state, returning `WEB_BAD_HOST` for non-IP values.
29. [Bucket 1 decision] Use the active bind host returned by the daemon for CLI warnings and alternate links.
30. [Decision] Run wildcard Host rejection checks for both `0.0.0.0` and `::`; IPv6 listening succeeded, the scoped gate passed 41 tests, and the scratch probes killed M2, M34, M36, and M37.

## Deferred / waiting for you

None. The orchestrator owns the post-HEAD push, PR, and commits for `validation.md` and this report.

## Blocked / failed

- Worker `f3c7` (general, Codex gpt-6-luna) wrote the spec, tasks, run notes, and uncommitted T01/T02, then was superseded after sandbox blockers. Worker `47a5` (general) committed T01 through T08.
- Reviewer `fc97` (Claude Opus) found six issues: S1 host flip-flop; S2 localhost redirect lost on wildcard bind; `127.0.0.2` link returned 403; hostname suffix was too broad; daemon did not validate the host; bad `--host` stopped the running console. Worker `6005` fixed R1 through R5, T1, and T13 in five commits.
- Auditor `283b` first returned FAIL: 24 mutants, 21 killed, 1 equivalent, and M1 and M2 survived. Auditor `4a15` then returned FAIL: 21 mutants, 17 killed, with M2, M34, M36, and M37 surviving. The verifier judged behavior correct and the remaining issues test gaps. Worker `dbdb` added negative tests in test-only commit `218c1d0`; its scratch probe killed M2 (1), M34 (2), M36 (1), and M37 (1). The orchestrator independently reran M2 and M36 in scratch copies. Each run reported `1 failed | 18 passed (19)` for `tests/web-security.test.ts`, against a 19/19 baseline. The final verifier killed all four survivors. Current `validation.md` says `Verdict: PASS`.
- Codex worktrees lacked `node_modules` because it is gitignored. The orchestrator symlinked the main repository's dependencies.
- `codedeck send` resumed a Codex thread with `workspace-write` even though its first turn had `danger-full-access`. The f3c7 rollout shows `danger-full-access` on the first turn and `workspace-write` on both resumed turns. `src/drivers/codex/driver.ts` says a resumed thread keeps its existing sandbox policy, which the rollout contradicts. Git commits and socket listen were denied after resume.
- CodeDeck marked sessions `47a5` and `6005` failed with `UNKNOWN` and blamed the harness, although both logs ended with `turn completed` and exit 0 after a recovered tool error appeared on stderr.
- `check_commit.py` rejects capitalized subjects while repository history uses them. The repository convention was kept.

## Not covered

- No end-to-end run used a real Tailscale interface or another device.
- No real `::` listener was tested with `bindv6only=1`. The verifier also did not test the localhost redirect through a real `::` server.
- IPv6 address normalization in Host comparison was not covered.
- A valid `--host` can still stop the running console before a new listen fails, as with the existing explicit-port behavior.
- The low-severity listen-failure message on a reused explicit host still names the requested host; the verifier noted this from code reading and did not reproduce it.
- TLS and `web.allowedHosts` were out of scope.
- The verifier did not test a build-triggered restart failure while retaining an explicit bind, run `dist/` gate scripts, or distill lessons.
- The full test suite was not run. Verification used the scoped web batches listed above.
