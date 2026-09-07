# Opencode parity in open Specification

> Follows `.specs/features/open-opencode/spec.md` (Verified) and `.specs/features/pty-session-rename/spec.md`. The base spec shipped opencode `open` with TUI stock and explicit gaps (no rename, no `/autonomous`, no resume hint, `--worktree` warn-and-continue, `--effort` unmapped). This spec closes the interactive gaps. Opencode theme (`codedeck-rage.json` + ephemeral tui dir) already shipped and is not revisited here.

## Problem Statement

`codedeck open` on opencode delivers the role contract but none of the session chrome Claude users get. The pty injection table has only claude (`src/open/injection.ts`), and the opencode branch never wires a pty, so no auto rename. `plugin/commands/autonomous.md` travels only via `--plugin-dir`, so `/autonomous` does not exist in opencode sessions. Nothing captures the native id (non-pty stdout is inherited, so it cannot be scanned), so the farewell exits without a resume line. `-n sessionName` is never sent. `--worktree` warns and continues, `--effort` is silently defaulted. An opencode user gets a working session that feels unfinished next to the Claude one.

## Goals

- [ ] `codedeck open` on opencode wires the pty and renames the live session after the first prompt, same as Claude
- [ ] `/autonomous` is invokable in CodeDeck opencode sessions with identical contract text, once the probe pins a channel
- [ ] Opencode sessions exit with a pasteable resume hint when the native id is captured, silently without it
- [ ] Opencode sessions carry the `CodeDeck · <project> · <role>` name where the TUI surfaces it, once the probe pins a channel
- [ ] `--worktree` and `--effort` stop being dead flags on opencode (P2)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| ------- | ------ |
| Statusline on opencode | `statusline.sh` reads the Claude payload shape; no opencode equivalent probed |
| Spinner verbs and tips | Claude `--settings` keys only; no known opencode equivalent |
| `--remote-control` on opencode | Claude account feature; no opencode equivalent |
| Opencode entitlement translation | Same call as the base spec: raw error until a probe pins the format |
| Codex and omp `open` launchers | Same factory mold later, not this spec |
| Opencode theme look | Already shipped (`codedeck-rage.json` + ephemeral tui dir) |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Opencode rename command | Probe-first: command text from a live probe; the name typed is the first-prompt slug the session-name hook writes beside the session file, typed exactly once; the entry stays empty until probed | Typing an unverified guess lands as prompt text in someone's session; same rule `injection.ts` already enforces | n |
| Pty wiring for opencode | The opencode branch gains the `pty` key on its `spawnHarness` call (same `ptyLaunchForHarness` shape as claude); rename and id capture both ride on it | `PTY_SCAN_LIMIT` and the sidecar watcher only exist under a pty, which opencode never takes today | y |
| `/autonomous` delivery | Probe the `OPENCODE_CONFIG_CONTENT` command key; body means the md minus frontmatter (same strip rule as `resolveRoleContract`); on a negative probe the command stays Claude-only with the transcript committed here | The inline env JSON is the only file-free channel; shipping prose as prompt would fake the command | n |
| Session id capture | Leading pty output window once the pty is wired, else `opencode session list`; no new daemon calls beyond OO-12 `ensureDaemonStarted` | Non-pty stdout is inherited by the terminal and cannot be scanned (`runtime.ts`); the pty branch is the only readable window | n |
| Session name channel | Probe-first: CLI flag or config key; oracle is an exact match in `opencode session list`; the banner keeps showing role, model and effort regardless | The name is cosmetic, the banner is the guaranteed surface | n |
| Effort mapping (P2) | Probe for an opencode effort reader; while none is pinned, print `Warning: --effort has no effect on opencode (no mapped reader); continuing with "default".` | Inventing a mapping without a reader is worse than an explicit warning; today the flag is silently defaulted | n |
| Worktree (P2) | Reuse `src/git/worktree.ts` from the repo root of cwd with the open `runId`; lifecycle follows `run --worktree` (persists after close, no auto-delete) | The harness has no native flag and CodeDeck already owns this code path | y |
| Pty flag semantics | `--no-pty` and config `pty: false` gain effect on opencode once the branch is wired (today they only affect claude) | The flag already exists globally; scoping it per harness is the honest shape | y |

**Open questions:** 5 live probes pending (rename command, command key, id capture, name channel, effort reader); each has a gate in Probe plan below, everything else resolved.

---

## Probe plan

Every probe-gated AC resolves through a live TUI probe before its implementation counts as done:

- Transcript location: `probe-<topic>-<yyyy-mm-dd>.txt` in this feature dir, mirroring `open-opencode/probe-2026-09-06.txt`.
- Gate: live session, exit 0, transcript committed; a negative result retires the AC to its documented fallback (OP-07, OP-12, OP-16) instead of failing the story.
- No probe ships keystrokes, commands, or config into `src/` until the transcript pins them.

---

## User Stories

### P1: Opencode session auto rename ⭐ MVP

**User Story**: As a dev opening sessions on opencode, I want the live session renamed after my first prompt so that three terminals on the same role stay distinguishable, like on Claude.

**Why P1**: Visible every session. The pty machinery is generic (`src/open/pty.ts`); only the branch wiring and the keystrokes are missing.

**Acceptance Criteria**:

1. WHEN the opencode branch is wired with a pty and the hook sidecar delivers the first-prompt slug THEN the CodeDeck SHALL type that slug exactly once through the owned pty `OP-01`
2. The opencode entry in `HARNESS_INJECTION` SHALL exist only after a live probe pins the rename command `OP-02`
3. WHILE the entry is unprobed the CodeDeck SHALL open the session without renaming `OP-17`
4. WHEN the pty is unavailable (no tty, no `script(1)`, `--no-pty`, config `pty: false`, win32, missing shim, non-interactive `-p`/`--print`) THEN the opencode session SHALL open with exit 0, banner printed, and no keystrokes typed `OP-03`
5. The opencode rename path SHALL reuse `sanitizeInjectedArgument` with the shared 40-character cap `OP-04`
6. IF nothing survives sanitizing THEN the CodeDeck SHALL type nothing and treat OP-01 as vacuously satisfied `OP-18`

**Independent Test**: After the probe lands, open an opencode session, submit a first prompt, and see the slug in `opencode session list`; repeat piped (`| cat`) and confirm exit 0 with no rename.

---

### P1: `/autonomous` on opencode ⭐ MVP

**User Story**: As a dev running an orchestrator on opencode, I want `/autonomous` to work there so that long runs do not depend on opening Claude.

**Why P1**: The command file is harness-agnostic prose about the orchestrator contract; only the delivery is Claude-only today.

**Acceptance Criteria**:

1. WHEN the probe pins a command channel in `OPENCODE_CONFIG_CONTENT` THEN `/autonomous` SHALL be invokable in CodeDeck opencode sessions and activate the autonomous contract `OP-05`
2. The delivered contract text SHALL equal `plugin/commands/autonomous.md` with frontmatter stripped `OP-06`
3. IF the probe shows the inline config channel cannot carry commands THEN the CodeDeck SHALL keep `/autonomous` Claude-only and commit the probe transcript to this feature dir `OP-07`

**Independent Test**: After the probe lands, run `/autonomous` in a CodeDeck opencode session and get the activation behavior; on the negative branch, the transcript exists here and the command is absent without any substitute prose.

---

### P1: Opencode resume hint ⭐ MVP

**User Story**: As a dev closing an opencode session, I want the resume line in the farewell so that I can get back with one copy-paste, like on Claude.

**Why P1**: Today the farewell always exits id-less on opencode because nothing captures the native id.

**Acceptance Criteria**:

1. WHEN the native opencode session id is captured during the session THEN the farewell SHALL include `resume: <cli> open <role> --resume <id>` `OP-08`
2. WHEN no id is captured THEN the farewell SHALL print without a resume line and exit 0 `OP-09`
3. The capture SHALL use only the owned pty output window or `opencode session list`, with no new daemon calls beyond OO-12 `OP-10`
4. The capture mechanism SHALL write nothing to `~/.config/opencode` besides the managed theme file `OP-19`

**Independent Test**: Close a captured session and paste the resume line back to the same session; close a piped session and confirm a clean farewell with no resume line.

---

### P1: Opencode session name ⭐ MVP

**User Story**: As a dev with several opencode sessions open, I want each one named `CodeDeck · <project> · <role>` where the TUI surfaces it so that I can tell them apart.

**Why P1**: Same distinguishability motive as the Claude `-n` flag, currently unsent on opencode.

**Acceptance Criteria**:

1. WHEN the probe pins a name channel on opencode THEN the CodeDeck SHALL send `CodeDeck · <project> · <role>` through it at launch `OP-11`
2. IF no name channel exists THEN the CodeDeck SHALL open without it `OP-12`
3. The boot banner SHALL keep showing role, model and effort as the guaranteed surface `OP-20`

**Independent Test**: After the probe lands, open general and reviewer on the same project and distinguish them by exact match in `opencode session list`.

---

### P2: CodeDeck-side worktree for opencode open

**User Story**: As a dev opening an opencode session for risky edits, I want `--worktree` to isolate the checkout so that two sessions cannot fight over a file.

**Why P2**: Replaces the warn-and-continue with the behavior Claude users already get; `run --worktree` proves the machinery. Retires base OO-20 for opencode (warn-and-continue no longer holds there).

**Acceptance Criteria**:

1. WHEN `--worktree` is passed with an opencode binding THEN the CodeDeck SHALL create the checkout via `src/git/worktree.ts` from the repo root of cwd and launch opencode with cwd inside it `OP-13`
2. IF worktree creation fails THEN the CodeDeck SHALL fail before spawn with the git error and never open in the wrong cwd `OP-14`
3. The worktree lifecycle SHALL follow `run --worktree` (persists after close, no auto-delete) `OP-21`

**Independent Test**: `codedeck open --worktree` on opencode, confirm the session cwd is a fresh checkout at HEAD and the base repo is untouched.

---

### P2: Opencode effort mapping

**User Story**: As a dev passing `--effort` with an opencode binding, I want it honored or explicitly warned so that the flag is never silently dead.

**Why P2**: Explicit beats silent; the reader may not exist, and that outcome is specified too.

**Acceptance Criteria**:

1. WHEN the probe pins an opencode effort reader THEN `--effort` SHALL travel through it `OP-15`
2. The banner SHALL show the chosen effort level once a reader is pinned `OP-22`
3. WHILE no effort reader is pinned the CodeDeck SHALL print `Warning: --effort has no effect on opencode (no mapped reader); continuing with "default".` `OP-16`
4. The banner SHALL show "default" for effort while no reader is pinned `OP-23`

**Independent Test**: Pass `--effort high` on opencode and either see it reflected in the session config or see the exact warning plus banner "default".

---

## Edge Cases

- IF the opencode binary is missing THEN the CodeDeck SHALL keep failing with the install instruction (OO-09 still holds)
- IF the model is not in `provider/model` shape THEN the CodeDeck SHALL keep failing before spawn (OO-21 still holds)
- IF two `open` run together on opencode THEN each SHALL keep its own env and sidecars with no shared state (OO-19 still holds)
- IF the plugin directory lacks `ultra.md` or the role file THEN the opencode launch SHALL fail before spawn (OO-18 still holds)
- IF `--resume` is passed with an opencode binding THEN the CodeDeck SHALL keep mapping it to `--session` (OO-07 still holds)
- IF the farewell has no captured id THEN it SHALL keep printing without a resume line (OO-11 still holds)
- IF the cwd no longer exists or the cwd is outside git THEN the previous behavior SHALL hold (OO-22 fails before spawn, OO-23 opens normally)
- OO-20 (warn-and-continue on `--worktree`) is retired for opencode by OP-13/OP-14 and holds for no other harness in this spec

---

## Requirement Traceability

| Requirement ID | Requisito | Story | Status |
| -------------- | --------- | ----- | ------ |
| OP-01 | Rename typed exactly once via wired pty | P1 rename | Retired (T6 retired, no consumer; probe-rename) |
| OP-02 | Injection entry only after live probe | P1 rename | Verified (T7 pins empty) |
| OP-03 | Full pty fallback opens clean | P1 rename | Verified (no pty wired; plain open) |
| OP-04 | Shared 40-char sanitizer reuse | P1 rename | Verified (pinned by suite) |
| OP-05 | `/autonomous` invokable once channel probed | P1 autonomous | Verified (T8 live) |
| OP-06 | Contract text equals md minus frontmatter | P1 autonomous | Verified (T8 asserts body) |
| OP-07 | Negative probe keeps Claude-only with transcript | P1 autonomous | Retired (probe positive, branch not taken) |
| OP-08 | Farewell resume via `--resume` when captured | P1 resume | Verified (T9 ses_ test) |
| OP-09 | No id, clean farewell, exit 0 | P1 resume | Verified (T9 ambiguous test) |
| OP-10 | Capture via pty window or session list only | P1 resume | Verified (T9 failure-path test) |
| OP-11 | Launch-time name through probed channel | P1 name | Retired (T4 negative transcript) |
| OP-12 | No channel, open without it | P1 name | Verified (T10 sends-nothing) |
| OP-13 | `--worktree` via CodeDeck-side checkout | P2 worktree | Verified (T11 isolates) |
| OP-14 | Worktree failure aborts before spawn | P2 worktree | Verified (T11 abort tests) |
| OP-15 | `--effort` via probed reader | P2 effort | Retired (T5 negative transcript) |
| OP-16 | Exact warning while unmapped | P2 effort | Verified (T12 exact string) |
| OP-17 | Unprobed entry opens without renaming | P1 rename | Verified (T7 skips-harness suite) |
| OP-18 | Empty sanitize types nothing | P1 rename | Verified (pinned by suite) |
| OP-19 | Capture writes no user config | P1 resume | Verified (T9, env/list only) |
| OP-20 | Banner as guaranteed surface | P1 name | Verified (T10 banner args) |
| OP-21 | Worktree lifecycle follows run | P2 worktree | Verified (persist, no auto-delete) |
| OP-22 | Banner shows pinned effort | P2 effort | Retired (T5 negative transcript) |
| OP-23 | Banner shows default while unmapped | P2 effort | Verified (T12 forces default) |

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 23 total: 18 verified, 5 retired with transcript (OP-01, OP-07, OP-11, OP-15, OP-22); 0 pending

---

## Success Criteria

- [ ] Opencode branch wires the pty; post-probe sessions rename exactly once, piped sessions exit 0 rename-free
- [ ] `/autonomous` activates post-probe, or a negative transcript is committed and the command stays Claude-only
- [ ] Farewell shows a working `--resume` line when captured, clean exit otherwise
- [ ] `--worktree` isolates via CodeDeck-side checkout; `--effort` maps or warns with the exact string
- [ ] `validate_spec.py` passes with zero errors (one known warning: probes pending by design)
- [ ] No writes to `~/.config/opencode` besides the managed theme file; zero new runtime deps; scoped tests green
