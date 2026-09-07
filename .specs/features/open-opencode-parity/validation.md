# Open-opencode-parity Validation (independent Verifier)

**Date**: 2026-09-07
**Spec**: `.specs/features/open-opencode-parity/spec.md`
**Diff range**: `main..HEAD` (14 commits, `feat/open-opencode-parity`; latest `2cb1f89`)
**Verifier**: independent sub-agent (author != verifier, evidence-or-zero)

---

## Task Completion

| Task | Status |
| ---- | ------ |
| T1 rename probe | ✅ Complete (negative transcript committed) |
| T2 command-channel probe | ✅ Complete (positive transcript committed) |
| T3 session-id probe | ✅ Complete (positive via list-diff, transcript committed) |
| T4 name-channel probe | ✅ Complete (negative transcript committed) |
| T5 effort probe | ✅ Complete (negative transcript committed) |
| T6 pty wiring | ⚠️ Retired with cause (both consumers negative in Phase 1: rename per `probe-rename-2026-09-07.txt`, name channel per `probe-name-2026-09-07.txt`; capture rides on list-diff per `probe-session-id-2026-09-07.txt`, so the pty has no consumer; re-propose only with a pinned keystroke consumer). Legitimate: wiring raw-mode spawn with no observable behavior would fail the senior-engineer check. |
| T7 rename injection entry | ✅ Complete (entry pinned empty) |
| T8 autonomous command | ✅ Complete (command key live) |
| T9 session-id capture | ✅ Complete (list-diff live) |
| T10 session name | ✅ Complete (sends-nothing + banner pinned, no src change per negative T4) |
| T11 worktree | ✅ Complete (isolates, aborts pre-spawn) |
| T12 effort | ✅ Complete (exact warning, banner forced default) |
| T13 traceability + gates | ✅ Complete (18 verified, 5 retired; spec table matches) |

All 13 tasks complete or legitimately retired. Gate: 14/14 commits on `feat/open-opencode-parity`.

---

## Spec-Anchored Acceptance Criteria

| AC (spec-defined outcome) | `file:line` + assertion expression | Result |
| ------------------------- | ---------------------------------- | ------ |
| OP-01 rename typed exactly once via wired pty | Retired. `probe-rename-2026-09-07.txt` certifies the negative (no rename flag on TUI, no rename subcommand, no `/rename` in TUI docs, binary strings show only LSP-rename literals; verdict NEGATIVE for 1.18.21) + `probe-name-2026-09-07.txt` (no post-launch keystroke target either). T6 retired with cause. | ✅ PASS (retired) |
| OP-02 injection entry only after live probe | `src/open/injection.ts:64` - `opencode: {}`; `tests/open-pty.test.ts:74-77` - `expect(HARNESS_INJECTION.opencode).toEqual({})` + `expect(harnessInjection("opencode").rename).toBeUndefined()` | ✅ PASS |
| OP-03 pty fallback opens clean (no tty / no `script(1)` / `--no-pty` / `pty: false` / win32 / missing shim / `-p`) | `tests/open-pty.test.ts:173-175` - `expect(ptyLaunchForHarness("opencode", "/plugin", "/tmp/session", {}, config, true)).toBeUndefined()`; `:65-70` - `expect(supportsInjection("opencode")).toBe(false)`; `src/cli/commands/open.ts:123-129` - `ptyLaunchForHarness` returns `undefined` when `harnessInjection(harness).rename` is absent | ✅ PASS |
| OP-04 shared 40-char sanitizer reuse | `tests/open-pty.test.ts:86-89` - `expect(slashCommandKeystrokes("rename", "x".repeat(120))).toBe(`/rename ${"x".repeat(40)}\r`)`; `src/open/injection.ts:38-46` - `sanitizeInjectedArgument` with `MAX_ARGUMENT_LENGTH = 40` | ✅ PASS |
| OP-05 `/autonomous` invokable once channel probed | `src/open/launchers/opencode.ts:97-99` - `command: { [AUTONOMOUS_COMMAND]: autonomousCommand(pluginDir) }` in `buildInlineConfig`; `tests/open-opencode.test.ts:102-113` - `expect(command.template.startsWith("# Autonomous mode")).toBe(true)` + `expect(autonomousCommand(pluginDir)).toEqual(command)` | ✅ PASS |
| OP-06 contract text equals md minus frontmatter | `src/open/launchers/opencode.ts:62-72` - frontmatter strip `/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/` + `.trim()`; `tests/open-opencode.test.ts:106-112` - description exact match, template contains `run-report.md`, `not.toContain("disable-model-invocation")` (frontmatter key excluded) | ✅ PASS |
| OP-07 negative probe keeps Claude-only with transcript | Retired (branch not taken). `probe-command-2026-09-07.txt` certifies POSITIVE (`OPENCODE_CONFIG_CONTENT` with `command` key resolves verbatim in `debug config`, exit 0), so the Claude-only fallback never triggers. No substitute prose shipped anywhere. | ✅ PASS (retired) |
| OP-08 farewell resume via `--resume` when captured | `src/open/runtime.ts:211-216` - `SESSION_ID_PATTERN` accepts `ses_` arm + `resumeHint` prints `open ${role} --resume ${id}`; `src/cli/commands/open.ts:515-528` - close path writes diffed id to `sessionFile` then `finishOpenSession`; `tests/open-args.test.ts:433-438` - `expect(resumeHint("reviewer", "ses_f87425ee9ffejNZXkRaHKoEc3G")).toContain("codedeck open reviewer --resume ses_f87425ee9ffejNZXkRaHKoEc3G")`; `tests/open-action.test.ts:219-236` - `expect(fs.readFileSync(sessionFile, "utf8")).toBe("ses_f87425ee9ffejNZXkRaHKoEc3G")` | ✅ PASS |
| OP-09 no id, clean farewell, exit 0 | `tests/open-action.test.ts:255-267` - ambiguous diff leaves no file (`expect(fs.existsSync(sessionFile)).toBe(false)`); `:239-253` - snapshot failure still spawns once and leaves no file | ✅ PASS |
| OP-10 capture via pty window or session list only, no new daemon calls | `src/cli/commands/open.ts:175-188` - `readOpencodeSessions` uses only `execFileSync(bin, ["session", "list", "--format", "json", "-n", "50"])` with try/catch; close path calls only `readOpencodeSessions` + `diffOpencodeSession` + `finishOpenSession` (`:516-528`), no `IpcClient`/daemon reference | ✅ PASS |
| OP-11 launch-time name through probed channel | Retired. `probe-name-2026-09-07.txt` certifies the negative (TUI `--help` has no `--title`; `--title` is `run`-only; T1 shows no `/rename`; titles are model-generated server-side). Oracle for re-probe recorded. | ✅ PASS (retired) |
| OP-12 no channel, open without it | `tests/open-action.test.ts:273-286` - `expect(args).not.toContain("--title")` + env keys `not.toMatch(/title/i)` | ✅ PASS |
| OP-13 `--worktree` via CodeDeck-side checkout from repo root of cwd | `src/cli/commands/open.ts:469-486` - `getGitInfo(cwd)` root + `createWorktree({ repoRoot: gitInfo.root, sessionId: runId, ... })`, `openCwd = wt.path`, spawn `cwd: openCwd` (`:534`); `tests/open-action.test.ts:59-72` - `expect(create).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo", name: "reviewer" }))` + `expect(opts.cwd).toBe("/wt/123")` | ✅ PASS |
| OP-14 worktree failure aborts before spawn with git error | `tests/open-action.test.ts:74-82` - rejects `"git blew up"` + `expect(runtime.spawnHarness).not.toHaveBeenCalled()`; `:84-93` - outside repo rejects `/git repository/`, create + spawn uncalled | ✅ PASS |
| OP-15 `--effort` via probed reader | Retired. `probe-effort-2026-09-07.txt` certifies the negative (TUI `--help` has no effort-shaped flag; `debug config` has no variant reader; `--variant` is `run`-only). | ✅ PASS (retired) |
| OP-16 exact warning while unmapped | `src/cli/commands/open.ts:494-498` - `console.error('Warning: --effort has no effect on opencode (no mapped reader); continuing with "default".')`; `tests/open-action.test.ts:293-300` - `expect(err).toHaveBeenCalledWith('Warning: --effort has no effect on opencode (no mapped reader); continuing with "default".')` + `:308-314` stays silent without explicit flag | ✅ PASS |
| OP-17 unprobed entry opens without renaming | `tests/open-pty.test.ts:173-175` - opencode `ptyLaunchForHarness` returns `undefined`; `src/open/injection.ts:59-65` - empty entry with probe-first comment | ✅ PASS |
| OP-18 empty-after-sanitize types nothing | `tests/open-pty.test.ts:91-93` - `expect(slashCommandKeystrokes("rename", "\r\n")).toBeUndefined()`; `:79-84` - `expect(sanitizeInjectedArgument("   ")).toBeUndefined()` | ✅ PASS |
| OP-19 capture writes no user config besides managed theme | `tests/open-opencode.test.ts:152-163` - `buildInlineConfig` + `buildArgs` trigger no `writeFileSync`/`mkdirSync`/`copyFileSync`; close path writes only `sessionFile` (`src/cli/commands/open.ts:522-526`); only `~/.config/opencode` writer is the pre-existing `ensureOpencodeTheme` | ✅ PASS |
| OP-20 banner as guaranteed surface | `tests/open-action.test.ts:281-285` - `expect(vi.mocked(runtime.renderBanner)).toHaveBeenCalledWith("reviewer", "prov/m", "default")`; `src/cli/commands/open.ts:501-505` - banner/boot always runs on opencode path | ✅ PASS |
| OP-21 worktree lifecycle follows run (persists, no auto-delete) | Code-inspection: `closeOpencode` body (`src/cli/commands/open.ts:516-528`) removes only the ephemeral TUI dir (`removeEphemeralTuiDir(tuiDir)`), never touches `openCwd`/`wt.path`; no `rmSync`/`removeWorktree` on the checkout anywhere in `open.ts` (grep confirms only `createWorktree` import + call). Lifecycle inherited from `createWorktree` shared with `run --worktree`. No unit assertion pins persistence; noted below. | ✅ PASS (inspection) |
| OP-22 banner shows pinned effort | Retired (same negative transcript as OP-15: no reader pinned, so the pinned-banner branch never triggers). | ✅ PASS (retired) |
| OP-23 banner shows default while unmapped | `src/cli/commands/open.ts:493` - `const effort = "default"` (ignores `opts.effort` except for the warning); `tests/open-action.test.ts:301-305` - banner called with `"default"` on explicit `--effort high` | ✅ PASS |

**Status**: 23/23 (18 verified + 5 retired with transcript; 0 uncovered).

---

## Edge Cases (base-spec pins still holding)

| Pin | Evidence |
| --- | -------- |
| OO-07 `--resume` maps to `--session` | `src/open/launchers/opencode.ts:123` + `tests/open-opencode.test.ts:167-181` (`"--session","sess-1"` in order) |
| OO-09 missing binary fails with install instruction | `src/open/launchers/opencode.ts:211-217` throws `OPENCODE_NOT_FOUND`; `tests/open-opencode.test.ts:317-321` |
| OO-11 farewell without id prints no resume line | `tests/open-args.test.ts:509-513` - `expect(renderExit("general", undefined)).not.toContain("--resume")`; pattern change preserves this (`:741-746` hook-left-nothing cases) |
| OO-18 contract failure aborts before spawn | `tests/open-action.test.ts:103-110` - `buildInlineConfig` throws → rejects + spawn uncalled |
| OO-19 concurrent opens keep own env/sidecars | `tests/open-opencode.test.ts:152-163` zero disk writes; per-dispatch `sessionFile` (pid-named) + `CODEDECK_RUN_ID: runId` per launch (`src/cli/commands/open.ts:454-456,536`) |
| OO-21 bad model shape fails before spawn | `src/open/launchers/opencode.ts:110-114`; `tests/open-opencode.test.ts:192-196` four bad shapes |
| OO-22 dead cwd fails before spawn | `tests/open-action.test.ts:384-394` - `currentWorkingDirectory()` throws `/no longer exists/` |
| OO-23 outside git opens normally | `tests/open-action.test.ts:112-118` - `chdir(os.tmpdir())` then spawn called once |
| OO-20 retired for opencode | Old warn-and-continue string gone (diff deletes it); `src/cli/commands/open.ts:466-468` cites retirement at the old site; warn test replaced by isolate/abort tests |

---

## Discrimination Sensor (mandatory)

Scratch: detached temp worktree `/tmp/parity-sensor` at HEAD (node_modules symlinked), discarded after. Real-tree `git status --porcelain` empty before and after (MATCH). Never `git stash`, never mutated the real tree.

| Mutation | File:line (scratch) | Description | Killed? |
| -------- | ------------------- | ----------- | ------- |
| 1 | `src/cli/commands/open.ts:206` | Flipped `diffOpencodeSession` exactly-one rule `fresh.length !== 1` → `< 1` (returns first of several instead of refusing) | ✅ Killed (`tests/open-action.test.ts`: 1 failed / 24, `returns undefined when zero or several sessions are new`) |
| 2 | `src/open/runtime.ts:211` | Broke `SESSION_ID_PATTERN` ses_ arm `{16,}` → `{64,}` (real ids rejected) | ✅ Killed (`tests/open-args.test.ts`: 1 failed / 84, `prints opencode session ids through the same resume flag`) |
| 3 | `src/cli/commands/open.ts:496` | Changed effort warning string (dropped `(no mapped reader)`) | ✅ Killed (`tests/open-action.test.ts`: 1 failed / 24, `warns on explicit --effort and keeps banner default`) |

**Result**: PASS - 3/3 killed. No survivors, no fix tasks.

---

## Code Quality

| Principle | Status |
| --------- | ------ |
| Surgical | ✅ opencode branch only; claude path untouched (diff adds one `ptyLaunchForHarness` consumer line set, no claude edits) |
| Minimal | ✅ +97/-? lines in `open.ts` are the three specified deltas (worktree, effort, capture) + two small helpers; `runtime.ts` is a 2-line pattern reuse; `opencode.ts` is one command key + one reader |
| Matches patterns | ✅ `createWorktree` reused from `run --worktree`; frontmatter strip mirrors `resolveRoleContract`; `SESSION_ID_PATTERN` shared by farewell + sidecar cleanup so they cannot disagree |
| No scope creep | ✅ out-of-scope list respected (no statusline/spinner/remote-control/entitlement/theme-look changes; codex/omp untouched; no `OpenLauncher` interface per design decision) |
| Tests map to spec | ✅ every new assertion cites its OP/OO (see table); probe transcripts committed per probe-gated AC |

Test-delta audit: 7 deleted test lines across the diff, all spec-mandated, none weakening: 3× `Object.keys(...).toEqual(["agent","instructions"])` → `["agent","command","instructions"]` (OP-05 adds the key); 4× OO-20 warn-and-continue block replaced by OP-13/OP-14 isolate + abort tests (OO-20 retired for opencode).

---

## Gate Check

- **Build**: `npm run build` exit 0 (tsc + `build:plugin` clean).
- **Scoped suites** (never the full suite):

| File | Before | After | Delta |
| ---- | ------ | ----- | ----- |
| tests/open-pty.test.ts | 37 | 38 | +1 (opencode-empty pin) |
| tests/open-opencode.test.ts | 31 | 32 | +1 (autonomous body) |
| tests/open-action.test.ts | 13 | 24 | +11 (capture, name, effort, worktree) |
| tests/open-args.test.ts | 83 | 84 | +1 (ses_ resume) |
| **Total** | 164 | **178 passed, 0 failed** | +14, 0 deletions of coverage |

- **Skipped**: none. **Failures**: none.

---

## Traceability Update

Spec table (`spec.md:177-209`) already reads 18 Verified / 5 Retired-with-transcript / 0 Pending. This verification independently re-derived the same verdicts; no status changes proposed. One precision note: OP-21 rests on code inspection (complete close-path body shows no checkout removal) rather than a dedicated persistence assertion; a `expect victories`-style test (e.g. close-path spy asserting no `rmSync` on the worktree path) would harden it but is not required by the task text.

---

## Summary

**Overall**: ✅ PASS

**Spec-anchored check**: 23/23 (18 verified, 5 retired with genuine transcripts)
**Sensor**: 3/3 mutations killed, 0 survivors
**Gate**: build clean; 178/178 scoped green (164 → 178, no weakening)

**What works**: rename entry stays empty per negative probe with shared-sanitizer pins intact; `/autonomous` travels via the probed `command` key with byte-checked contract text; resume hint flows list-diff → session file → farewell with the `ses_` arm shared by hint and cleanup; `--worktree` isolates through `createWorktree` and aborts pre-spawn on failure; `--effort` warns with the exact string and banners `default`; banner remains the guaranteed surface with no name channel.

**Issues found**: none blocking. Non-blocking note: OP-21 persistence is inspection-backed, not assertion-backed (see above).
