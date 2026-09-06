# Open-opencode Validation (fix iteration 2)

**Date**: 2026-09-06
**Spec**: `.specs/features/open-opencode/spec.md`
**Diff range**: d85fbbd..HEAD (11 commits, feat/open-opencode; latest fee104b)
**Verifier**: independent sub-agent (author ≠ verifier)

---

## Task Completion

No formal `tasks.md` gate commands apply (Tasks phase skipped for this feature). Scoped gate used instead (see Gate Check). Prior validation's Fix 1 + Fix 2 are addressed by `fee104b test(open): pin dispatch and edge behavior with action tests` (new `tests/open-action.test.ts`, new `preflight` call-args test); Fix 3 (probe artifact) is addressed by committed `probe-2026-09-06.txt` + `scripts/probe-opencode-reviewer.sh`.

---

## Spec-Anchored Acceptance Criteria

| Criterion (WHEN X THEN Y) | Spec-defined outcome | `file:line` + assertion | Result |
| ------------------------- | -------------------- | ----------------------- | ------ |
| OO-01 WHEN role bound to claude THEN same args as today | `--plugin-dir`, `--append-system-prompt-file`, `--settings`, `--agent codedeck:<role>` | `tests/open-args.test.ts:47-62` - `expect(args.filter(...)).toEqual(["--model","claude-opus-4-8",...,"--agent","codedeck:orchestrator",...])`; `:71-74` general agent; `:92-113` overrides + verbatim passthrough | ✅ PASS |
| OO-02 Contract resolved by module importing nothing from launchers | agent body w/o frontmatter + ultra.md, no spawn, no harness import | `tests/open-contract.test.ts:30-36` - `expect(agentBody).toContain("CodeDeck reviewer")`, `not.toContain("tools:")`, `expect(ultra).toContain("Never round failure to success")`; imports only `../src/open/contract.js` + roles (`:6-13`) | ✅ PASS |
| OO-03 Existing open-args suite green without expectation change | all pass, expectations intact except OO-04 dispatch | `tests/open-args.test.ts` 71/71 green; diff touches only `harnessMismatch` opencode expectations (`:586-588`), required by OO-04 | ✅ PASS (tension noted below, not a gap) |
| OO-04 WHEN binding points to opencode THEN launch via opencode launcher, no harnessMismatch | no `harnessMismatch` for opencode | `tests/open-args.test.ts:586-588` - `expect(harnessMismatch("general", {harness:"opencode",...})).toBeUndefined()`; `tests/open-opencode.test.ts:156-158` - `expect(launcherFor("reviewer", {harness:"opencode",...})).toBe("opencode")` | ✅ PASS |
| OO-05 WHEN opencode binding THEN mount OPENCODE_CONFIG_CONTENT | `instructions` from ultra.md + agent `codedeck-<role>` (body prompt, tool-map permission), zero writes | `tests/open-opencode.test.ts:65-76` - `expect(parsed.instructions[0]).toContain("Never round failure to success")`, `expect(agent.prompt).toContain("CodeDeck reviewer")`, `expect(agent.permission).toEqual(rolePermission("reviewer"))`; `:86-97` - `expect(spy).not.toHaveBeenCalled()` on writeFileSync/mkdirSync/copyFileSync | ✅ PASS |
| OO-06 WHEN launching on opencode THEN pass agent/model/auto flags | `--agent codedeck-<role>`, `--model provider/model`, `--auto` (omitted only with `--no-bypass`) | `tests/open-opencode.test.ts:101-115` - `expect(buildArgs(...)).toEqual(["--agent","codedeck-reviewer","--model","prov/m","--auto","--session","sess-1",...])`; `:117-124` - bypass:false drops `--auto` | ✅ PASS |
| OO-07 WHEN `--resume <id>` THEN repass as `--session <id>` | `--session <id>` | `tests/open-opencode.test.ts:101-115` - contains `"--session","sess-1"` | ✅ PASS |
| OO-08 WHEN args after `--` THEN verbatim passthrough | uninterpreted forward | `tests/open-opencode.test.ts:101-115` - trailing `["--log-level","debug"]` preserved in order | ✅ PASS |
| OO-09 IF opencode missing from PATH THEN fail with install instruction, no stack | install guidance | `tests/open-opencode.test.ts:134-138` - `await expect(resolveBinary()).rejects.toThrow(/not found on PATH/)` | ✅ PASS |
| OO-10 BEFORE spawn THEN consult catalog via getCachedOrDiscoverModels(registry, {agent:"opencode"}) | exact call shape + warn-and-continue on failure | `tests/open-opencode.test.ts:178-184` - `expect(discover).toHaveBeenCalledWith(expect.anything(), { agent: "opencode" })`; `:170-176` - rejection resolves undefined + `expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"))` | ✅ PASS (gap closed since iter 1) |
| OO-15 IF catalog loaded AND lacks model THEN fail pre-spawn citing model + findClosestModel suggestion; search in launcher, verdict pure | rejection error with suggestion; split judge/fetch | `tests/open-contract.test.ts:114-120` - `expect(judgeModelIn(...)).toEqual({kind:"rejected", error:'Model "prov/abd" is not in the opencode catalog. Did you mean "prov/abc"? Run \`codedeck setup\`...'})`; `:122-130` harness naming; `tests/open-opencode.test.ts:186-202` - `await expect(preflight("prov/zzz", false)).rejects.toThrow(/not in the opencode catalog/)` | ✅ PASS |
| OO-11 WHEN opencode session ends THEN farewell, resume line only with captured id, nothing to clean | farewell + conditional resume wired to onClose, no cleanup | `tests/open-action.test.ts:57-72` - `expect(typeof opts.onClose).toBe("function")`, `opts.onClose()` → `expect(runtime.finishOpenSession).toHaveBeenCalledWith("reviewer", expect.stringContaining("codedeck-session-"))`; `tests/open-args.test.ts:317-321` - `renderExit` with/without id | ✅ PASS (gap closed) |
| OO-12 WHEN open starts on opencode THEN ensure daemon via client.ensureDaemonStarted(), failure propagates | daemon guaranteed before spawn, in order | `tests/open-action.test.ts:48-55` - `expect(ensureOrder).toBeLessThan(spawnOrder)`; dispatch preamble `HEAD:src/cli/commands/open.ts:347-350` (`currentWorkingDirectory()` then `await client.ensureDaemonStarted()` before dispatch) | ✅ PASS (gap closed) |
| OO-13 WHEN `--no-theme` with opencode THEN open normally, stock TUI | no error, contract untouched | `tests/open-action.test.ts:83-89` - `runOpen(["reviewer","--no-theme"])` spawns; `expect(Object.keys(inline).sort()).toEqual(["agent","instructions"])` | ✅ PASS (gap closed) |
| OO-14 WHEN probe runs reviewer on opencode with --auto THEN session refuses file creation via edit | refusal, file absent | `scripts/probe-opencode-reviewer.sh` (in diff) + `.specs/features/open-opencode/probe-2026-09-06.txt:12-20` - exit 0, no file, verbatim `My review contract is read only`; spec assumptions row `spec.md:42` | ✅ PASS (artifact-backed; live run author-executed, not re-run here) |
| OO-16 Opencode launcher exits with stock TUI, no theme/spinner/statusline in MVP | no styling applied | `tests/open-opencode.test.ts:65-77` - `expect(Object.keys(parsed).sort()).toEqual(["agent","instructions"])`; `tests/open-action.test.ts:83-89` - same keys on dispatched env | ✅ PASS (absence now asserted; gap closed) |
| OO-17 Probe result recorded in spec assumptions table before equivalence claim | record present | `spec.md:42` assumption row + committed `.specs/features/open-opencode/probe-2026-09-06.txt` (20 lines: pins, exit 0, verbatim refusal, bash-redirect caveat) | ✅ PASS (gap closed) |
| OO-18 IF inline content unmountable THEN fail before spawn, never silent contractless session | pre-spawn throw, spawn uncalled | `tests/open-contract.test.ts:38-45` - `toThrow(/no agent file/)`; `:47-59` - `toThrow(/ultra prompt not found/)`; `tests/open-action.test.ts:91-98` - `buildInlineConfig` throws → `rejects.toThrow("no contract")` + `expect(spawnHarness).not.toHaveBeenCalled()` | ✅ PASS (ordering now pinned; gap closed) |
| OO-19 IF two opens run together THEN each carries its own env, no shared file/state | per-process env | `tests/open-opencode.test.ts:86-97` - zero disk writes; `tests/open-action.test.ts:60-64` - per-dispatch `envExtra: {OPENCODE_CONFIG_CONTENT}` fresh JSON per `spawnHarness` call; `buildInlineConfig` pure/file-free (diff `src/open/launchers/opencode.ts`) | ✅ PASS (gap closed) |
| OO-20 IF `--worktree` with opencode THEN warn no-equivalent and continue | warning + continue without | `tests/open-action.test.ts:74-81` - `expect(err).toHaveBeenCalledWith(expect.stringContaining("no effect on opencode"))` + `expect(spawnHarness).toHaveBeenCalledTimes(1)`; dispatch diff (`open.ts` opencode branch) | ✅ PASS (gap closed) |
| OO-21 IF binding model not `provider/model` THEN fail pre-spawn explaining expected format | format error | `tests/open-opencode.test.ts:126-130` - 4 bad shapes `toThrow(/must be provider\/model/)` | ✅ PASS |
| OO-22 IF process cwd no longer exists THEN fail before spawn like current launcher | pre-spawn failure | `tests/open-action.test.ts:110-119` - dead cwd `expect(() => runtime.currentWorkingDirectory()).toThrow(/no longer exists/)`; dispatch calls it first at `HEAD:src/cli/commands/open.ts:347` before daemon/spawn | ✅ PASS (gap closed) |
| OO-23 IF run outside git repo THEN opencode open starts normally | normal start | `tests/open-action.test.ts:100-106` - `process.chdir(os.tmpdir())` then `expect(spawnHarness).toHaveBeenCalledTimes(1)`; no git check in launch path (diff) | ✅ PASS (gap closed) |

**Status**: ✅ All 23 ACs covered (23 ✅ PASS, 0 partial, 0 hard gaps)

---

## Spec-precision notes (flagged, not failures)

1. OO-03 vs OO-04 tension (carried from iter 1): OO-03 demands zero expectation change while OO-04 requires opencode to stop erroring, forcing the 2 `harnessMismatch` expectation updates (`tests/open-args.test.ts:586-588`). Minimal and required; spec should exempt dispatch expectations from OO-03.
2. OO-14/OO-17 rest on a live external run (binary + configured model + network) that this verifier did not re-execute; evidence is the committed transcript + script + spec row, which is the strongest committable form for a probe AC.

---

## Discrimination Sensor

Scratch: detached temp worktree `/tmp/open-verify-scratch2` at HEAD (node_modules symlinked), discarded after. Real-tree `git status --porcelain` matches pre-sensor baseline afterwards (both `?? .specs/features/open-opencode/validation.md` → MATCH).

| Mutation | File:line (scratch) | Description | Killed? |
| -------- | ------------------- | ----------- | ------- |
| 1 | `src/open/launchers/opencode.ts:79` | Flipped bypass default `flags.bypass !== false` → `=== false` | ✅ Killed (`tests/open-opencode.test.ts` + `tests/open-action.test.ts`: 3 failed / 27) |
| 2 | `src/open/launchers/opencode.ts:29` | Reviewer permission `edit:"deny"` → `"allow"` | ✅ Killed (`tests/open-opencode.test.ts`: 1 failed / 20) |
| 3 | `src/open/launchers/opencode.ts:119` | Verdict branch `unknown-catalog` → `rejected` (swallowed warn path, forced throw path) | ✅ Killed (`tests/open-opencode.test.ts`: 2 failed / 20) |

**Sensor depth**: lightweight (3 targeted behavior-level mutations, highest-risk new code: bypass default, permission map, catalog verdict)
**Result**: 3/3 killed - PASS ✅

---

## Interactive UAT Results

Not performed: backend/CLI infrastructure feature, no user-facing visual flow. Automated dispatch + edge tests substitute per checklist.

---

## Code Quality

| Principle | Status |
| --------- | ------ |
| Minimum code | ✅ factory split reuses runtime; no new runtime deps |
| Surgical changes | ✅ claude path moved verbatim; opencode branch additive |
| No scope creep | ✅ codex/omp still refused; theme/statusline excluded per spec |
| Matches patterns | ✅ launcher modules mirror existing preflight/resolveBinary shapes |
| Spec-anchored outcome check (asserted values match spec) | ✅ all 23 ACs assert spec-defined outcomes |
| Per-layer Coverage Expectation met (domain 1:1 ACs; routes happy+edge+error) | ✅ contract 1:1; dispatch covers happy + edge + error paths |
| Every test maps to a spec requirement | ✅ new tests map to OO-04/05/06/07/08/09/10/11/12/13/15/16/18/19/20/21/22/23 |
| Documented guidelines followed | ✅ none found - strong defaults applied |

---

## Edge Cases

- [x] OO-18 unmountable inline: throws loud, spawn uncalled (`tests/open-action.test.ts:91-98`)
- [x] OO-19 per-process env: file-free, fresh envExtra per dispatch (`tests/open-opencode.test.ts:86-97`, `tests/open-action.test.ts:60-64`)
- [x] OO-20 `--worktree` warn-and-continue (`tests/open-action.test.ts:74-81`)
- [x] OO-21 bad model shape (`tests/open-opencode.test.ts:126-130`)
- [x] OO-22 dead cwd (`tests/open-action.test.ts:110-119` + preamble `:347`)
- [x] OO-23 outside git (`tests/open-action.test.ts:100-106`)

---

## Gate Check

- **Gate command**: `npx vitest run tests/open-args.test.ts tests/open-contract.test.ts tests/open-opencode.test.ts tests/open-action.test.ts`
- **Result**: 112 passed, 0 failed, 0 skipped (open-args 71, open-contract 14, open-opencode 20, open-action 7)
- **Test count before feature**: not recorded by author (no baseline in tasks.md); iter-1 report recorded 104 (71+14+19); delta +8 = 1 preflight call-args test + 7 action tests
- **Skipped tests**: none
- **Failures**: none

---

## Fix Plans

None. All iter-1 gaps closed.

---

## Requirement Traceability

| Requirement | Previous Status | New Status |
| ----------- | --------------- | ---------- |
| OO-01 | Implementing | ✅ Verified |
| OO-02 | Implementing | ✅ Verified |
| OO-03 | Implementing | ✅ Verified |
| OO-04 | Implementing | ✅ Verified |
| OO-05 | Implementing | ✅ Verified |
| OO-06 | Implementing | ✅ Verified |
| OO-07 | Implementing | ✅ Verified |
| OO-08 | Implementing | ✅ Verified |
| OO-09 | Implementing | ✅ Verified |
| OO-10 | Implementing | ✅ Verified |
| OO-11 | Implementing | ✅ Verified |
| OO-12 | Implementing | ✅ Verified |
| OO-13 | Implementing | ✅ Verified |
| OO-14 | Implementing | ✅ Verified |
| OO-15 | Implementing | ✅ Verified |
| OO-16 | Implementing | ✅ Verified |
| OO-17 | Implementing | ✅ Verified |
| OO-18 | Implementing | ✅ Verified |
| OO-19 | Implementing | ✅ Verified |
| OO-20 | Implementing | ✅ Verified |
| OO-21 | Implementing | ✅ Verified |
| OO-22 | Implementing | ✅ Verified |
| OO-23 | Implementing | ✅ Verified |

---

## Summary

**Overall**: ✅ Ready

**Spec-anchored check**: 23/23 ACs matched to spec outcome (0 spec-precision failures; 2 notes above)
**Sensor**: 3/3 mutations killed
**Gate**: 112 passed, 0 failed

**What works**: factory split with byte-identical claude behavior; opencode inline contract, agent/model/auto/session/passthrough flags, binary-missing error, catalog preflight with pinned call args + suggestion, model-shape rejection; dispatch pins daemon order, farewell wiring, no-theme acceptance, worktree warn-and-continue, contract-before-spawn ordering, per-process env, dead-cwd failure, outside-git start; probe transcript committed.

**Issues found**: none remaining.

**Next steps**: none. Feature ready to mark done (spec traceability statuses still read Implementing in spec.md and may be flipped to Verified on merge).
