# Prompt Layers Specification

## Problem Statement

The role prompts in `plugin/agents/*.md` repeat the same sentences in several
files. The dispatch contract (`--role` required, role owns harness and model,
slice by ownership, briefing carries everything), the worktree rule, the
verify-before-claim rule, the self-review dispatch, and the session rename line
are copied verbatim across `general.md`, `reviewer.md`, `auditor.md`, and the
three orchestrator variants. Every wording fix has to land in N files, and they
drift.

Goal: a single-source layered prompt system. Shared text lives once in
`plugin/prompts/_partials/*.md`, each role becomes a small manifest
(`plugin/prompts/roles/<role>.md`) with an `includes:` list plus role-specific
body, and `plugin/agents/*.md` become generated files.

Delivery paths, decided (see Changelog, finding 1): generated
`plugin/agents/*.md` EXCLUDE core text. Core (`plugin/ultra.md` verbatim) is
delivered out-of-band on both paths. The run path prepends core in code (a new
admitted behavior change in `src/core/roles.ts` plus test updates): run workers
receive the ultra inviolables for the first time. The open path is completely
unchanged: `src/open/contract.ts` keeps returning the agent body and the ultra
text separately ("The prompt half of a role: the agent body without frontmatter
plus the shared ultra text"), and the launchers keep shipping ultra through
their existing channels, so open workers never get ultra twice.

## Goals

- [ ] Each shared must-sentence (Appendix A) lives in exactly one partial file;
      role bodies may extend a concept with role-specific detail but must not
      restate a must-sentence
- [ ] Every role prompt composes deterministically: includes in manifest order,
      then role body (generated files exclude core; core is prepended at
      runtime on the run path only)
- [ ] Generated `plugin/agents/*.md` preserve all current normative content
      per the Appendix A must-sentence list (key-phrase containment gate)
- [ ] `scripts/copy-plugin.mjs` regenerates the agents files, and generated
      files stay committed and in sync
- [ ] Tests pin composition, frontmatter (as parsed YAML), marker hygiene, and
      size budgets (generated file bytes on disk)

## Source Layout

New source files (hand-edited, the only place prompt text is authored):

- `plugin/prompts/_partials/*.md`: `core.md`, `worktree.md`, `dispatch.md`,
  `proof.md`, `review-self.md`, `rename-run.md`, `commit.md`, `pr-writer.md`.
- `plugin/prompts/roles/<role>.md`: one manifest per role (`general`,
  `orchestrator`, `orchestrator-read`, `orchestrator-edit`, `reviewer`,
  `auditor`). Frontmatter carries `name`, `description`, optional `tools:`,
  plus an `includes:` list naming partials. The file body after the frontmatter
  is the role-specific text.

Generated files (never hand-edited):

- `plugin/agents/*.md` keep their current paths and filenames, carry a
  `DO NOT EDIT` marker as YAML comment lines INSIDE the frontmatter (so the
  file still starts with the opening delimiter and the existing frontmatter
  strip keeps working unchanged), and stay the files that `Claude --agent` and
  `run`/opencode read.
- Generated files EXCLUDE core text. The run-path composer in
  `src/core/roles.ts` prepends core at runtime; the open path reads ultra
  through its existing separate reader, unchanged.

## Shared Partials

Partials hold the canonical must-sentences (Appendix A). A role body may extend
a concept with role-specific operational detail, but it must not restate any
must-sentence. "Exactly one source per concept" means exactly one source per
must-sentence; extensions live in bodies. This resolves the old
single-source contradiction (see Changelog, finding 5).

### core.md

`core.md` is `plugin/ultra.md` verbatim: the ultra identity sentence ("You are
running inside a CodeDeck session. Keep the work attributable, grounded in
evidence, and explicit about what actually changed.") plus the 3 inviolable
rules ("Never round failure to success.", "Evidence over assertion.", "The
scope asked for is the deliverable."), no role verbs. It is the source of truth
for the run-path composer, which prepends it at runtime. `plugin/ultra.md` is kept as-is as the file the open path reads today; no launcher reads a new path. A test asserts `core.md` and `plugin/ultra.md` stay byte-equal. It is never inlined
into generated `plugin/agents/*.md`, never listed in `includes:`.

`core.md` must not contain rename commands. Open auto-rename (the `-n`
sessionName flag, `hooks/session-name.*`, pty `/rename` typing) is untouched
and prompt-independent; `run` rename stays via the `rename-run` partial only.

### worktree.md

Canonical must-sentences, extracted verbatim from `plugin/agents/general.md`:

- "Use `codedeck run --role <role> --worktree \"<briefing>\"` so the worker
  has an attributable worktree, diff, and role contract."
- "Worktree is a choice, not a default. `--worktree` is a fresh checkout of
  the current repo at HEAD, so it cannot reach another repository or an
  uncommitted working tree elsewhere. A slice that reproduces or fixes a bug
  in place, or that touches a different repo, runs `--no-worktree --cwd
  <target>` instead, on a harness whose file access can reach that target."

### dispatch.md

Canonical must-sentences, extracted verbatim from
`plugin/agents/general.md`:

- "Always include `--role`. It selects the harness and model the human
  configured for that role. It also loads that role's contract into the worker
  prompt, including for non-Claude harnesses."
- "Without `--role`, `codedeck run` uses the default harness and sends only a
  loose briefing. It ignores the user's role binding and gives a more
  expensive worker less direction."
- "The role owns the harness and the model. `--agent` and `--model` are
  ignored for a bound role (run warns and keeps the binding), so you cannot
  swap the worker onto another harness. Changing the pairing is a `codedeck
  setup` decision, not a dispatch flag."
- "Slice by ownership. A worker owns its files end to end. Two workers in one
  file is a merge you will pay for."
- "Workers start with none of this context. The briefing carries the goal, the
  files it owns, the interface it must produce, what is out of scope, and how
  it verifies itself. Never write \"see the conversation\"."

### proof.md

Two canonical must-sentences:

- "Verify before you claim."
- "Read `codedeck diff <id>` yourself before believing any worker. The
  artifact is authoritative, the success message is not."

The second (run-worker diff) sentence is dispatch-scoped: it is composed only
into roles that dispatch workers (`general`, the orchestrator family,
`auditor`). `reviewer` never spawns workers ("No subagents, no `codedeck run`
workers, nothing that spawns. Your `Bash` is for probes."), so reviewer
composes only the verify must-sentence and must not gain the run-worker diff
sentence (see the per-role table).

Role-specific operationalizations stay in role bodies and must not restate the
must-sentences: general's "Run the focused command and quote its output", the
orchestrator's proof-contract section ("You confirm work by reading what a
worker produced, never by producing anything yourself. The only things you look
at are worker artifacts", plus the `codedeck logs` / `codedeck diff <id>
--stat` / `codedeck ps` / `codedeck show` artifact rules, the `.status` over
exit code rule, and the SonarCloud/CI gate rule), the auditor's slice-report
verification ("A slice's report is a claim. Before a finding reaches your
output, check the `file:line` it cites says what the slice says it says."),
the reviewer's probe rule ("Prove runtime claims with a probe you ran, and
quote its output. If you could not run it, say the claim is a guess.").

### review-self.md

Canonical must-sentences, extracted verbatim from
`plugin/agents/general.md`:

- "Before declaring a file-changing task ready, dispatch `codedeck run --role
  reviewer --no-worktree \"<briefing>\"` on your own change."
- "The review is read-only, so use `--no-worktree`. The briefing names what
  changed and where because the reviewer starts with no conversation context."
- "Act on the review result before declaring the task ready."
- "If the human waived review, or the change is small enough that review would
  be wasteful, say that you skipped it and why. Do not skip silently."

### rename-run.md

The single rename sentence, exactly as today:

- "Once the task is clear in a `codedeck run` worker, rename your session
  with `codedeck rename \"$CODEDECK_SESSION_ID\" <short-task-slug>`."

Included by `general`, `reviewer`, and `auditor` only. The orchestrator
variants are excluded: none of the three orchestrator files carries the rename
sentence today, and none gains it.

### commit.md and pr-writer.md

Vendored as TWO separate full-text partials (about 4.1KB and 5.0KB, matching
the measured `wc -c` sizes of the commit skill file and the pr-writer skill
file). Each carries a header noting its source under `~/.claude/skills/` and
exactly 3 adaptations:

1. The create-branch skill reference becomes a one-line main/master branch
   rule. Do NOT vendor create-branch.
2. The `sentry-skills:commit` reference becomes a pointer to the Commits
   section in the same prompt.
3. The `Co-Authored-By: Claude` line is generalized to attribute the harness
   that did the work.

Only `general` includes them.

## Role Manifests

Manifest frontmatter: `name`, `description`, optional `tools:`, plus an
`includes:` list. Composition order is fixed: the includes in manifest order,
then the role body (core is NOT composed into generated files; the run-path
composer prepends it at runtime). No include markers leak into generated
files. Generated frontmatter is the manifest frontmatter minus the `includes:`
key, compared as parsed YAML (never as bytes); `tools:` keeps its Claude
allowlist meaning (frontmatter is stripped from non-Claude prompt paths by the
existing handling in `src/core/roles.ts`, whose strip behavior "removes
frontmatter but does not scope tools" per its own boundary comment, unchanged).

The `DO NOT EDIT` marker lives INSIDE the frontmatter as YAML comment lines,
for example:

```yaml
---
# DO NOT EDIT: generated from roles/general.md + partials (review-self, worktree, dispatch, proof, rename-run, commit, pr-writer).
# Do not hand-edit; edit the manifest or partials and rebuild.
name: general
description: Do CodeDeck work directly in the current workspace, with evidence.
---
```

Because the file still opens with the frontmatter delimiter, the existing
strip expression (match from the opening delimiter through the closing
delimiter, else treat the whole file as body) keeps working unchanged, and no
consumer or test helper that expects leading frontmatter needs a regex change.

### general (fully specified)

Manifest `plugin/prompts/roles/general.md`:

```yaml
---
name: general
description: Do CodeDeck work directly in the current workspace, with evidence.
includes:
  - review-self
  - worktree
  - dispatch
  - proof
  - rename-run
  - commit
  - pr-writer
---
```

Role body keeps, in current wording: the identity sentence ("You are the
CodeDeck general session. You do the work yourself, here. Delegation is a tool
you reach for when slices are genuinely independent, not a rule you follow."),
the `## Operating contract` section minus the must-sentences owned by partials
(dropped per the table below) and keeping the general-specific
operationalizations ("Run the focused command and quote its output", "Scope
every test run to what you touched, by file or by test name. Never run a whole
suite to check one change.", the merge-conflict rule "When a branch or pull
request has merge conflicts, inspect both sides. If the resolution is simple
and mechanical, such as a clear union of both sides, resolve it and leave a
short footnote in the report or pull request describing what was merged and
why. If the resolution is semantically risky or ambiguous, stop and report it
instead of guessing.", the `gh pr checks`/SonarCloud gate rule "After you push
a branch or open or update a pull request, run 'gh pr checks <n>' and/or 'gh pr
view <n>' and read external quality gates such as SonarCloud. A failing check,
gate, or threshold means the deliverable is not done. Report it as incomplete,
never round it to success."), the `## When you do delegate` section header,
and the closing line ("Report what you verified, not what you intended.").

Resolved structure of generated `plugin/agents/general.md` (excluding core,
which the run-path composer prepends at runtime):

1. Frontmatter (`name`, `description`; no `tools:`, no `includes:`) with the
   `DO NOT EDIT` YAML comment lines inside it.
2. Includes in manifest order: `review-self`, `worktree`, `dispatch`, `proof`,
   `rename-run`, `commit`, `pr-writer`.
3. Role body (identity, operating contract extensions, delegate header context,
   closing report line).

Shared sections compose before the role body. This reorder (shared sections
ahead of the merge-conflict rule, the `gh pr checks`/SonarCloud gate rule, and
the closing report line, versus today's operating-contract-then-delegate
order) is an accepted behavior change: inviolables take precedence over
role detail, and shared-first ordering aids prefix cache. The key-phrase
containment gate against Appendix A is the guard (see Tests).

Equivalence gate: the resolved `general.md` must contain every must-sentence
in Appendix A applicable to general (a test asserts the key phrases;
reordering from composition is allowed, dropping is not).

### Migration table (all six roles, with tools and drop/keep)

`tools:` values are exactly as on disk today. Bodies drop the quoted
must-sentences below (they arrive via the partial instead) and keep the noted
role-specific detail. No body restates a must-sentence after the drop.

The `orchestrator-read` and `orchestrator-edit` variants are open-only by
design (finding 1, closed as documented design). They are reachable only via
the open path mode routing (`resolveRoleFile` in `src/open/contract.ts`
selects `orchestrator-<tools>.md` from the orchestrator mode) and are
intentionally NOT addressable via `run --role` (`parseRole` in
`src/core/roles.ts` accepts only the 4 `ROLES`: `general`, `orchestrator`,
`reviewer`, `auditor`).

| Role | `tools:` | Includes | Drops from body (exact must-sentences) | Keeps |
| ---- | -------- | -------- | -------------------------------------- | ----- |
| `general` | (none) | `review-self`, `worktree`, `dispatch`, `proof`, `rename-run`, `commit`, `pr-writer` | All four `review-self` must-sentences ("Before declaring a file-changing task ready, dispatch `codedeck run --role reviewer --no-worktree \"<briefing>\"` on your own change.", "The review is read-only, so use `--no-worktree`. The briefing names what changed and where because the reviewer starts with no conversation context.", "Act on the review result before declaring the task ready.", "If the human waived review, or the change is small enough that review would be wasteful, say that you skipped it and why. Do not skip silently."); both `worktree` must-sentences ("Use `codedeck run --role <role> --worktree \"<briefing>\"` so the worker has an attributable worktree, diff, and role contract.", "Worktree is a choice, not a default. `--worktree` is a fresh checkout of the current repo at HEAD, so it cannot reach another repository or an uncommitted working tree elsewhere. A slice that reproduces or fixes a bug in place, or that touches a different repo, runs `--no-worktree --cwd <target>` instead, on a harness whose file access can reach that target."); all five `dispatch` must-sentences (the "Always include `--role`." sentence, the "Without `--role`, `codedeck run` uses the default harness..." sentence, the "The role owns the harness and the model..." sentence, the "Slice by ownership..." sentence, the "Workers start with none of this context..." sentence); the bare "Verify before you claim." (keeping "Run the focused command and quote its output."); the run-worker diff sentence "Read `codedeck diff <id>` yourself before believing any worker. The artifact is authoritative, the success message is not."; the rename sentence "Once the task is clear in a `codedeck run` worker, rename your session with `codedeck rename \"$CODEDECK_SESSION_ID\" <short-task-slug>`." | Identity sentence, operating-contract extensions (scoped test runs, merge-conflict rule, `gh pr checks`/SonarCloud gate rule), delegate header context, closing report line |
| `orchestrator` | `Bash` | `worktree`, `dispatch`, `proof` | The generic worktree-choice sentence ("Worktree is a choice, not a default. `--worktree` is a fresh checkout of the current repo at HEAD, blind to uncommitted edits and to other repositories. A slice that reproduces or fixes something in the live tree, or that touches a different repo, runs `--no-worktree --cwd <target>` on a harness whose file access can reach the target."); the generic dispatch must-sentences restated in the Dispatch contract ("Always dispatch in the background and always include `--role`.", "The role owns the harness and the model. `--agent` and `--model` are ignored for a role that carries a binding, so a worker's harness and model come from the configured role.", "Without `--role`, run falls back to the default harness with a loose prompt, a pricier worker with less direction.", "Slice by ownership, not by step. A worker owns its files end to end and finishes with something whole.", "Every briefing is a standalone contract. Workers start with none of your context. Never write \"see the conversation\"."); the generic verify/proof sentences (keeping the proof-contract operationalizations) | Orchestrator-specific dispatch detail (the canonical `codedeck run --role <role> \"<briefing>\" --bg --json` background shape with the `jq` `.id` rule, the `codedeck setup` pairing rule, slice-review-stays-with-worker plus final-round ownership, parallel launch in a single message, discovery-by-dispatching), registry, `wait`/`needs_input` handling, teardown, red-flags section. No `review-self` (the final round is dispatched by the orchestrator itself over the whole scope). No `rename-run`. No `commit`/`pr-writer` |
| `orchestrator-read` | `Read, Grep, Glob, Bash` | `worktree`, `dispatch`, `proof` | The generic worktree-choice sentence ("Worktree is a choice, not a default. `--worktree` is a fresh checkout of the current repo at HEAD. A slice that touches a live tree or a different repo runs with `--no-worktree --cwd <target>` on a harness that can reach that target."); the generic dispatch sentences ("Always dispatch in the background and always include `--role`.", "The role owns the harness and the model. `--agent` and `--model` are ignored for a role that carries a binding, so a worker's harness and model come from the configured role.", "Workers start with none of your context. Never write \"see the conversation\".", "Every briefing is a standalone contract." wording that restates the briefing-carries must-sentence); the generic verify sentences (keeping the read-variant proof contract) | Shorter read-variant wording throughout (plan, delegation packet, registry, dispatch contract, proof contract, integration, delivery loop, teardown). No `rename-run` |
| `orchestrator-edit` | `Read, Grep, Glob, Edit, Write, Bash` | `worktree`, `dispatch`, `proof` | Same drops as `orchestrator-read` (identical dispatch/worktree/proof sentences in the edit variant) | Same as `orchestrator-read`, with the edit-variant toolset. No `rename-run` |
| `reviewer` | `Read, Grep, Glob, Bash, WebFetch, WebSearch` | `proof` (verify must-sentence only), `rename-run` | The rename sentence "Once the task is clear in a `codedeck run` worker, rename your session with `codedeck rename \"$CODEDECK_SESSION_ID\" <short-task-slug>`." (the body Drops it; the `rename-run` partial is its sole supplier, so the composed reviewer contains it exactly once). Composes only "Verify before you claim." from `proof`; explicitly does NOT compose the run-worker diff sentence "Read `codedeck diff <id>` yourself before believing any worker. The artifact is authoritative, the success message is not." (reviewer states no other dispatch/worktree/review-self sentence today) | Review contract, no-dispatch section ("No subagents, no `codedeck run` workers, nothing that spawns."), anti-padding, probe rule, three-list close. Rename arrives only via the `rename-run` partial, never restated in the body. No `dispatch`/`worktree` (it never spawns). No `review-self` |
| `auditor` | `Read, Grep, Glob, Bash, WebFetch, WebSearch, Task` | `dispatch`, `proof`, `rename-run` | The three dispatch must-sentences the auditor restates ("`--role` selects the harness and model the human configured for that role. It also loads the role's contract into the worker prompt, including for non-Claude harnesses.", "Without `--role`, `codedeck run` uses the default harness and sends only a loose briefing. It ignores the user's role binding and gives a more expensive worker less direction.", "The role owns the harness and the model. `--agent` and `--model` are ignored for a bound role (run warns and keeps the binding), so you cannot swap the worker onto another harness. Changing the pairing is a `codedeck setup` decision, not a dispatch flag."); the generic verify sentence (keeping the slice-report verification); the rename sentence "Once the task is clear in a `codedeck run` worker, rename your session with `codedeck rename \"$CODEDECK_SESSION_ID\" <short-task-slug>`." and the body Drops it while the rename-run partial supplies it, so the composed auditor contains it exactly once | Splitting/consolidating/cost sections, reviewer-contract-per-slice rule, and its own read-only worktree sentence ("A file-changing worker uses the canonical form `codedeck run --role <role> --worktree \"<briefing>\"`, but this review is read only. Never use `--worktree` for an audit slice."). No `worktree` partial (audit slices never take `--worktree`). Rename arrives only via the `rename-run` partial, never restated in the body |

## Build

`scripts/copy-plugin.mjs` (today a plain recursive copy of `plugin/` into
`dist/plugin`) grows a generation step: for each
`plugin/prompts/roles/<role>.md`, resolve `includes` in order + body, place
the `DO NOT EDIT` marker as YAML comment lines inside the frontmatter, strip
`includes:` from the frontmatter, and write `plugin/agents/<role>.md`. Core is
not inlined. Source (`plugin/`) and dist (`dist/plugin`) stay in sync through
the existing copy, and the generated `agents/*.md` files are committed.

Minimal runtime change admitted (see Goals): `src/core/roles.ts` gains a
run-path composer that prepends core (read from `plugin/ultra.md`) to the
role body, and the run-path prompt builder uses it. The existing frontmatter
strip expression is untouched. Zero open launcher or driver changes:
`src/open/contract.ts` keeps its separate ultra reader and its split return,
and the launchers keep their existing ultra delivery.

## Tests

New or updated tests pin:

- Manifest validity: every name in every `includes:` list resolves to an
  existing file in `plugin/prompts/_partials/`.
- Run-path core-first order: the run-path composer output starts with the
  `core.md` text; generated files themselves exclude core.
- Core/ultra byte-equality: a test asserts `plugin/prompts/_partials/core.md`
  and `plugin/ultra.md` are byte-equal; the open path keeps reading
  `plugin/ultra.md` unchanged and no launcher reads a new path.
- Open-path no-duplication: the open agent body does not contain the ultra
  text (ultra still arrives exactly once through the existing separate
  channel).
- No marker leak: no include markers, manifest paths, or `includes:` keys
  appear in any generated file body; the `DO NOT EDIT` marker appears only as
  YAML comment lines inside the frontmatter.
- Frontmatter preserved: generated frontmatter parsed as YAML equals manifest
  frontmatter parsed as YAML minus the `includes:` key; `tools:` values
  unchanged per the migration table.
- Size budgets: measured as generated file bytes on disk, including
  frontmatter and the marker (see Budgets).
- Equivalence: resolved `general.md` plus run-path core contains every
  applicable Appendix A must-sentence (key-phrase assertions; reorder allowed,
  drop forbidden). Reviewer output must not contain the run-worker diff
  sentence.
- Updates to the existing `roles`, `open-contract`, and `open-args` tests to
  read the generated files and the new run-path composer (frontmatter regex
  unchanged, so parsing needs no tolerance change).

### Budgets

Measurand for every budget: generated file bytes on disk, including
frontmatter and the `DO NOT EDIT` YAML comment lines. Core is excluded from
generated files (it is prepended at runtime on the run path), so budgets cover
the generated file only.

| Role | Budget | Basis and headroom |
| ---- | ------ | ------------------ |
| `general` | 16384 bytes (16KB) | Measured generated 12764 bytes; 16KB leaves about 3.6KB (22 percent) free for the 3 skill adaptations and wording fixes |
| `orchestrator` | 14336 bytes (14KB) | Measured generated 12232 bytes; 14KB leaves about 2.1KB (15 percent) free. The review's cited 12265 figure is this file plus core; core is now excluded, so the budget covers the file alone |
| `orchestrator-read` | 8192 bytes (8KB) | Measured generated about 7124 bytes; 8KB leaves about 1KB (about 13 percent) free, thin headroom accepted. The review's cited 6813 figure is this file plus core; core is now excluded |
| `orchestrator-edit` | 8192 bytes (8KB) | Measured generated about 7137 bytes; 8KB leaves about 1KB (about 13 percent) free, same arithmetic as the read variant, thin headroom accepted |
| `reviewer` | 8192 bytes (8KB) | Measured generated 2916 bytes, about 64 percent free; generous headroom for review-contract growth |
| `auditor` | 8192 bytes (8KB) | Measured generated 4478 bytes, about 45 percent free |

## Out of Scope

Explicitly excluded:

| Feature | Reason |
| ------- | ------ |
| Any implementation (partials, manifests, build script, tests) | Scoping history, now superseded: true when the spec was written alone, but this program delivered the implementation on the same branch |
| `tlc-spec-driven` vendoring | Separate sourcing decision, not part of prompt dedup |
| `create-branch` vendoring | Deliberately not vendored; replaced by a one-line branch rule (see commit.md adaptation 1) |
| Runtime context injection (v2) | Dynamic prompt assembly at launch is a later version; v1 is static generation plus the one run-path composer change |
| Open launcher or driver changes | Zero changes: `src/open/contract.ts` and both launchers keep their existing ultra delivery exactly as today |
| General refactor of `src/core/roles.ts` | Exactly one minimal change allowed: the run-path composer that prepends core. Build script plus test changes allowed |
| `run --role` for `orchestrator-read` / `orchestrator-edit` | Open-only by design (finding 1, closed as documented design): the two variants are reachable only via the open path mode routing, never via `run --role`, whose `parseRole` accepts only the 4 `ROLES` |

## Acceptance Criteria

1. WHEN a partial sentence changes THEN regenerating SHALL update every role
   that includes it from the single source, with no hand edit in
   `plugin/agents/` <!-- event-driven --> `PL-01`
2. The build SHALL reproduce `plugin/agents/*.md` byte-identical from
   manifests plus partials, and committed generated files SHALL match build
   output <!-- ubiquitous --> `PL-02`
3. The run-path composer output SHALL start with the `core.md` text for every
   role, generated files SHALL exclude core text, the open agent body SHALL
   not contain the ultra text, and generated files SHALL contain zero include
   markers <!-- ubiquitous --> `PL-03`
4. Generated frontmatter parsed as YAML SHALL equal manifest frontmatter
   parsed as YAML minus the `includes:` key (`tools:` unchanged per the
   migration table) <!-- ubiquitous --> `PL-04`
5. Resolved `general.md` plus run-path core SHALL contain every applicable
   Appendix A must-sentence (asserted by key phrase; reorder allowed, drop
   forbidden) and every generated file SHALL stay within its Budgets-table
   byte limit <!-- ubiquitous --> `PL-05`
6. IF an `includes:` entry names a missing partial THEN the build SHALL fail
   naming the manifest and the entry <!-- unwanted-behavior --> `PL-06`
7. `claude plugin validate --strict plugin/` on the generated tree is a manual
   release gate (not CI): it SHALL pass before release; hermetic CI does not
   execute the external Claude binary <!-- ubiquitous --> `PL-07`

## Requirement Traceability

| Requirement ID | Requisito | Status |
| -------------- | --------- | ------ |
| T-01 | Single-source partials and manifests; agents files generated with DO NOT EDIT marker inside frontmatter; run-path composer plus zero open changes | Verified |
| T-02 | Build regenerates agents from manifests plus partials; generated files committed; source and dist in sync | Verified |
| T-03 | core.md is ultra.md verbatim, delivered out-of-band (run-path prepend, open path unchanged), never inlined in generated files | Verified |
| T-04 | Shared partials hold canonical must-sentences (worktree, dispatch, proof, review-self, rename-run with general/reviewer/auditor-only scope) | Verified |
| T-05 | commit and pr-writer as separate full-text partials with source header and 3 adaptations; general-only | Verified |
| T-06 | Open auto-rename untouched; core free of rename commands | Verified |
| T-07 | Composition order (includes then body; shared-first accepted change), parsed-YAML frontmatter, no marker leak | Verified |
| T-08 | Test pins: validity, run-path core-first, open no-dup, markers, frontmatter, size budgets on file bytes, roles/open-contract/open-args updates | Verified |
| T-09 | general fully specified; all six roles in the migration table with tools and drop/keep; orchestrator-read/edit open-only via mode routing, not via run | Verified |

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

## Success Criteria

- [ ] Editing one partial and rebuilding updates all including roles, with the
      diff confined to generated files
- [ ] `general` resolved output plus run-path core contains every applicable
      Appendix A must-sentence
- [ ] All size budgets hold and the manual `plugin validate --strict` release
      gate passes
- [ ] Tests fail on a dangling include, a leaked marker, a missing core
      prepend on the run path, or ultra text duplicated in the open agent body

## Appendix A: Normative Must-Sentence List

"Normative" means exactly the sentences below. Each is quoted in full from its
source file. A test asserts each via a key phrase (substring); word order
within the file does not matter, absence fails. Applicability: general takes
all sentences scoped to its includes; orchestrator family takes worktree,
dispatch, and proof (both sentences); reviewer takes the verify sentence plus
rename-run; auditor takes dispatch, proof (both sentences), and rename-run.

Review-self (4):

1. "Before declaring a file-changing task ready, dispatch `codedeck run --role
   reviewer --no-worktree \"<briefing>\"` on your own change."
2. "The review is read-only, so use `--no-worktree`. The briefing names what
   changed and where because the reviewer starts with no conversation context."
3. "Act on the review result before declaring the task ready."
4. "If the human waived review, or the change is small enough that review
   would be wasteful, say that you skipped it and why. Do not skip silently."

Worktree (2):

5. "Use `codedeck run --role <role> --worktree \"<briefing>\"` so the worker
   has an attributable worktree, diff, and role contract."
6. "Worktree is a choice, not a default. `--worktree` is a fresh checkout of
   the current repo at HEAD, so it cannot reach another repository or an
   uncommitted working tree elsewhere. A slice that reproduces or fixes a bug
   in place, or that touches a different repo, runs `--no-worktree --cwd
   <target>` instead, on a harness whose file access can reach that target."

Dispatch (5):

7. "Always include `--role`. It selects the harness and model the human
   configured for that role. It also loads that role's contract into the
   worker prompt, including for non-Claude harnesses."
8. "Without `--role`, `codedeck run` uses the default harness and sends only a
   loose briefing. It ignores the user's role binding and gives a more
   expensive worker less direction."
9. "The role owns the harness and the model. `--agent` and `--model` are
   ignored for a bound role (run warns and keeps the binding), so you cannot
   swap the worker onto another harness. Changing the pairing is a `codedeck
   setup` decision, not a dispatch flag."
10. "Slice by ownership. A worker owns its files end to end. Two workers in one
    file is a merge you will pay for."
11. "Workers start with none of this context. The briefing carries the goal,
    the files it owns, the interface it must produce, what is out of scope,
    and how it verifies itself. Never write \"see the conversation\"."

Proof (2, second is dispatch-scoped):

12. "Verify before you claim."
13. "Read `codedeck diff <id>` yourself before believing any worker. The
    artifact is authoritative, the success message is not."

Rename-run (1):

14. "Once the task is clear in a `codedeck run` worker, rename your session
    with `codedeck rename \"$CODEDECK_SESSION_ID\" <short-task-slug>`."

Key phrases (normative, one per must-sentence; the containment gate asserts exactly these substrings, no implementer choice):

- 1: "Before declaring a file-changing task ready"
- 2: "The review is read-only, so use"
- 3: "Act on the review result"
- 4: "If the human waived review"
- 5: "so the worker has an attributable worktree"
- 6: "Worktree is a choice, not a default"
- 7: "Always include"
- 8: "sends only a loose briefing"
- 9: "The role owns the harness and the model"
- 10: "Slice by ownership"
- 11: "Workers start with none of this context"
- 12: "Verify before you claim."
- 13: "before believing any worker"
- 14: "rename your session"

## Changelog (Review Findings to Sections)

All findings from the read-only review of this spec (session `be92`) are
addressed; no finding is left open:

1. Core-first double-delivery contradiction: fixed by Generated-files-exclude-core
   plus the admitted run-path composer change and the unchanged open path.
   See Problem Statement, Goals, Source Layout (Generated files), core.md,
   Build, Tests (run-path core-first, open no-duplication), Out of Scope
   (open zero-changes row plus minimal `src/core/roles.ts` row), PL-03, T-09.
2. `DO NOT EDIT` header breaking the frontmatter strip: fixed by placing the
   marker as YAML comment lines inside the frontmatter. The existing strip
   expression is unchanged. Frontmatter is compared as parsed YAML, never as
   bytes. See Role Manifests (marker example), Build, Tests, PL-04.
3. Untestable PL-04/PL-05/PL-07: fixed by Appendix A (explicit must-sentence
   list quoted in full, key-phrase containment gate kept), parsed-YAML
   frontmatter comparison, and PL-07 marked as a manual release gate, not CI.
   See Appendix A, Tests, PL-04, PL-05, PL-07, Success Criteria.
4. Ambiguous drop-vs-duplicate for orchestrator/reviewer/auditor: fixed by the
   per-role drop/keep table naming the exact sentences dropped from each of
   the six bodies. Reviewer composes only the verify must-sentence and must
   not gain the run-worker diff sentence; auditor keeps its read-only
   worktree sentence and does not take the worktree partial. See Migration
   table, proof.md scoping note, Tests (reviewer absence assertion).
5. "Exactly one source per concept" contradiction: fixed by redefining
   partials as the canonical must-sentences while bodies may extend a concept
   with role-specific detail but must not restate a must-sentence. See Goals,
   Shared Partials intro, Migration table.
6. Tight/conflicting size budgets: fixed by defining the measurand (generated
   file bytes on disk including frontmatter and marker) and recomputing every
   budget with stated headroom. See Tests, Budgets table, PL-05.
7. "Reordering is presentation-only" unproven: fixed by labeling shared-before-
   body an accepted behavior change with rationale (inviolables take
   precedence, shared-first ordering aids prefix cache), guarded by the
   key-phrase gate. See general resolved structure, Tests.
8. Underspecified `tools:` handling: fixed by the `tools:` column in the
   migration table with the exact on-disk value per role, and by stating the
   existing frontmatter-strip behavior unchanged. See Role Manifests,
   Migration table, Tests, PL-04.
9. Volatile line-number references: fixed by quoting every source sentence in
   full (Shared Partials, Migration table, Appendix A) and removing all
   line-number citations from this spec.
