# Autonomous mode MVP

## Goal

Add an explicit `/autonomous` command for a running interactive orchestrator session. The command injects a behavior contract that lets the orchestrator continue without human input, record reversible assumptions, defer work it cannot safely decide, route around blockers, and leave a report in the repository.

This MVP is prompt-level behavior. It does not add daemon enforcement.

## Trigger and activation

The user invokes `/autonomous` in an already running interactive orchestrator session. The mode is explicit and one-way for that session. It never activates at startup, through configuration, because a worker asks a question, or through any other automatic path.

### Confirmed repository mechanics

- The plugin is copied as a directory. `scripts/copy-plugin.mjs:7-11` sets `dist/plugin` as the target and recursively copies `plugin/` into it. `package.json:14-15` exposes this as `npm run build:plugin`, and the full build runs it.
- The current plugin has agent Markdown files, hooks, themes, `ultra.md`, and `plugin/.claude-plugin/plugin.json`. It has no `plugin/commands/` directory or command file. The manifest at `plugin/.claude-plugin/plugin.json:1-11` declares the plugin metadata and themes only.
- Agent files use frontmatter. `plugin/agents/orchestrator.md:1-5` declares `name`, `description`, and `tools`, followed by the agent body. `src/core/roles.ts:54-60` reads the file and strips that frontmatter for prompt use outside Claude's `--agent` path.
- `codedeck open` resolves the plugin directory at `src/cli/commands/open.ts:352-354`, then launches Claude with the arguments built at `src/cli/commands/open.ts:434-467`. `src/open/launchers/claude.ts:108-119` passes `--plugin-dir <pluginDir>`, `--append-system-prompt-file <pluginDir>/ultra.md`, and `--agent codedeck:<role>`.
- `plugin/ultra.md:1-9` is shared startup guidance. The orchestrator role is also selected at launch through `--agent`; `plugin/agents/orchestrator.md:1-7` supplies its role contract.
- The source analysis proposes `src/open/orchestrator-prose.ts` at `analysis.md:68-79`, but that file does not exist on this branch. The current launcher has no autonomous-aware live prompt composer. `src/open/contract.ts:34-49` only composes the role body and `ultra.md` for startup delivery. The analysis also records the missing live-answer and blocker infrastructure at `analysis.md:47-64`.

### Mechanics conclusion

The realistic MVP injection point is option (a), a plugin slash-command asset whose expansion is the autonomous contract. It is the only candidate that can satisfy an explicit command in a session that is already running. Under the confirmed Claude Code convention, plugin commands are auto-discovered from a plugin-root `commands/` directory. The filename maps to the command name, so `plugin/commands/autonomous.md` provides `/autonomous`. Command frontmatter may use `description`, `argument-hint`, `allowed-tools`, and `model`. The command body is injected into the current session when invoked.

Option (b) alone is not wired. No current loader references a shared autonomous file. `ultra.md` and the role file are startup inputs, so changing either would affect newly launched sessions, not the current session. Option (c) would require new runtime support and is outside this MVP.

The implementation checklist below covers the remaining command file checks. It must not infer a command format from the agent frontmatter.

## Behavior contract

After activation, the orchestrator follows this contract for the rest of the session.

### Never ask the human

The orchestrator must never ask the human a question, request a choice, wait for an answer, or stop because a human answer is unavailable. If the orchestrator or a worker would need to ask the human for input, that work is blocked.

### Decision rubric

Use this as a heuristic, not a guarantee: can the decision be undone with `git revert`? A revert does not undo dependency installation, network fetches, transitive code execution, shared-state changes, or external side effects.

1. Bucket 1 covers reversible and cheap decisions that may be made immediately. This includes naming a candidate library in notes or prose, choosing a name, writing a test, refactoring, creating a file, and editing code. Record the assumption in the running notes and final report. Installing, fetching, or vendoring a dependency is not bucket 1. Treat it as bucket 2, including the lockfile change, network fetch, and transitive code execution.
2. Bucket 2 covers irreversible or destructive actions. The orchestrator and workers must never take them without the human. This includes deleting data, deleting untracked files, `git clean`, `git reset --hard`, force-pushing an already-shared branch, publishing or sharing commits, touching production, sending network writes or other external side-effecting calls, spending money, applying a migration to a shared database, and installing, fetching, or vendoring a dependency. Defer the action and record it in the report. Do not ask for permission.
3. An ambiguous product decision that genuinely matters is deferred as a pending question. Record the question, then route around it by doing independent work that does not depend on the answer.

The rubric governs the orchestrator's decisions. A worker's question is evidence of a blocker, not permission to ask the human.

For this MVP, naming a candidate library in notes or prose is bucket 1. Installing, fetching, or vendoring that library is bucket 2.

### Route around blockers

When a task is deferred or blocked, the orchestrator records the reason, keeps a running notes entry, and continues dispatching or doing every independent task. Independent means the task needs no output, file, or decision from the deferred or blocked item. When in doubt, list it as deferred rather than dispatch it. One blocker must not halt the whole run. Work that depends on the deferred decision remains listed as deferred.

### Risks / limitations

This is a prompt-level instruction, not process enforcement. It cannot guarantee that the orchestrator or a worker follows the no-question or bucket-2 rules. Workers run under permission bypass, including Claude's `--dangerously-skip-permissions` in `src/drivers/claude/driver.ts:12-23`, so destructive commands remain technically executable.

## Report and notes

Use these repository paths for an autonomous run. `<slug>` is the feature slug from the active work item, lowercased with every run of non-alphanumeric characters replaced by one hyphen and leading or trailing hyphens removed. If the work item has no feature slug, use `autonomous-mode`. On activation, the orchestrator dispatches a worker (or, if the session is an edit-capable harness, directs the session) to create the slug directory and both files immediately. No note-taking is valid before they exist.

- Running notes: `.specs/features/<slug>/run-notes.md`. This file is append-only per run and is never rewritten.
- Final report: `.specs/features/<slug>/run-report.md`. It must be self-contained. Do not write `see run-notes.md`; fold the notes into the report as content.

An assumption note is an append-only entry in `run-notes.md` carrying time-or-sequence, decision, category (bucket), and reason. Blocker entries also record the independent work taken around the blocker. At the end, fold the notes into `run-report.md` rather than leaving the report dependent on a separate log.

The final-report rule is explicit. The report lives at `.specs/features/<slug>/run-report.md`, is self-contained, contains the five sections below in this order, and uses the `Done` link formats or the links-unavailable fallback below. The `Done` section derives the branch by running `git branch --show-current` and the commit by running `git rev-parse HEAD`. With a web remote, it includes these Markdown links: `- Branch: [<branch-name>](<remote>/tree/<branch-name>)` and `- Commit: [<full-sha>](<remote>/commit/<full-sha>)`. Without a web remote, it includes the exact branch name and full commit SHA and states that links are unavailable.

1. `Done`, including commit and branch links.
2. `Assumptions I made`, covering reversible calls recorded during the run.
3. `Deferred / waiting for you`, covering irreversible actions and pending product questions.
4. `Blocked / failed`, covering failed work, blocked workers, and reasons.
5. `Not covered`, covering work left out of the run and why.

## Acceptance criteria

1. Check `.specs/features/autonomous-mode/testing/activation/without-autonomous.md` and `.specs/features/autonomous-mode/testing/activation/with-autonomous.md`. Pass iff `rg -n '^User: /autonomous$'` finds no match in the first fixture and one match in the second, `rg -n 'must never ask the human|Bucket 1|run-notes.md'` finds no match in the first fixture, and an `awk` check finds `must never ask the human` and `Bucket 1` only after that invocation in the second fixture.
2. Check `.specs/features/autonomous-mode/testing/contract-expansion.md`, copied from `plugin/commands/autonomous.md`. Pass iff one `rg` marker check finds `must never ask the human`, `or a worker would need to ask the human`, `that work is blocked`, `can the decision be undone with \`git revert\``, `heuristic, not a guarantee`, `Bucket 1`, `Bucket 2`, `ambiguous product decision`, `route around`, `append-only per run`, `run-notes.md`, `run-report.md`, `Done`, `Assumptions I made`, `Deferred / waiting for you`, `Blocked / failed`, and `Not covered`, plus the explicit final-report path, remote link formats, and links-unavailable fallback, and an ordered-heading check matches `Done`, `Assumptions I made`, `Deferred / waiting for you`, `Blocked / failed`, `Not covered` in that order.
3. Check `.specs/features/autonomous-mode/testing/behavior/no-human-question.md`. Pass iff `rg` finds `BLOCKER:` and `PENDING QUESTION:` records, and finds no `ASK HUMAN:`, `REQUEST APPROVAL:`, or `WAIT FOR HUMAN:` action in the fixture.
4. Check `.specs/features/autonomous-mode/testing/behavior/decision-buckets.md`. Pass iff `rg` finds candidate-library naming in notes or prose as bucket 1, dependency install/fetch/vendor work as bucket 2 and deferred, destructive work as bucket 2 and deferred, and an assumption note matching the fields `time-or-sequence`, `decision`, `category (bucket)`, and `reason`.
5. Check `.specs/features/autonomous-mode/testing/behavior/route-around.md`. Pass iff `rg` finds the independent definition, a blocker record, an independent task dispatched after the blocker, and a dependent task recorded as deferred, while an exact-match check finds no dispatch for the dependent task.
6. Check `.specs/features/autonomous-mode/testing/report/activation-files.md`, `.specs/features/autonomous-mode/testing/report/run-notes-before.md`, `.specs/features/autonomous-mode/testing/report/run-notes.md`, `.specs/features/autonomous-mode/testing/report/run-report-with-remote.md`, and `.specs/features/autonomous-mode/testing/report/run-report-no-remote.md`. Pass iff an `awk` check finds the activation followed immediately by either `DISPATCH WORKER: create slug directory and both files` or `EDIT-CAPABLE SESSION: create slug directory and both files`, finds both file markers before the first `NOTE:`, and finds no `NOTE:` before either marker; a prefix comparison proves the notes file only appends to the before snapshot; each report fixture has the five required headings in order; each report contains the note content without `see run-notes.md`; the remote fixture matches both stated Markdown link formats; and the no-remote fixture contains the exact branch, full SHA, and `links are unavailable`.
7. Check `.specs/features/autonomous-mode/testing/activation/implicit-events.md`. Pass iff `rg` finds `STARTUP: no activation`, `CONFIGURATION: no activation`, `WORKER QUESTION: no activation`, and `OTHER AUTOMATIC EVENT: no activation`, and an exact-match check finds no `User: /autonomous` line.
8. Check `.specs/features/autonomous-mode/spec.md` and `.specs/features/autonomous-mode/testing/scope.md`. Pass iff `rg` finds every Phase 2 exclusion, including blocker detection, live answer injection, timeouts, scheduling, a dependency graph, structured report IPC or CLI, automatic activation, deferred-question persistence, auto-answer / auto-defer policy on run options or configuration, and process-level enforcement, and `rg -n '^MVP IMPLEMENTS: (blocker detection|live answer injection|timeouts|scheduling|dependency graph|structured report IPC|structured report CLI|automatic activation|deferred-question persistence|auto-answer|auto-defer|process-level enforcement)$'` returns no matches in the scope fixture.

## Testing notes

This feature is mainly plugin and prompt content, so verification is bounded and textual.

- Check `plugin/commands/autonomous.md`. Read its frontmatter and body, then use `rg` to verify the markers listed in acceptance criterion 2. A pass requires every marker and the final-report path, section order, link formats, and no-remote fallback.
- After any plugin change, run `npm run build:plugin` and verify that the corresponding file exists under `dist/plugin` with the same content. `scripts/copy-plugin.mjs:7-11` is the copy path.
- Use the concrete fixtures named in acceptance criteria 1 and 3 through 8. The decision-buckets fixture covers candidate-library naming, test writing, dependency installation or fetching, a production change or database migration, product ambiguity, and a worker question. The route-around fixture covers the independent task and the deferred dependent task. The activation fixtures cover the before and after states. The report fixtures cover append-only notes, folded report content, remote links, and the no-remote fallback. Each fixture passes only when its stated `rg`, `awk`, or exact-match judge passes.
- No source-code or full-suite test is required for this spec-only artifact. Runtime guarantees beyond the command expansion are not proven by prompt checks and remain outside this MVP.

## Explicit OUT OF SCOPE

All Phase 2 infrastructure is out of scope:

- daemon-level blocker detection or production of `needs_input`;
- live-answer injection into a running process;
- inactivity or deadline timeouts;
- a run-level scheduler or dependency graph;
- a structured or persisted report schema with IPC or CLI;
- deferred-question persistence (store/table/JSON);
- auto-answer / auto-defer policy on run options or configuration;
- No process-level enforcement in the MVP; destructive commands remain technically executable under permission bypass. Enforcement is Phase 2.
- any automatic, non-explicit activation.

## Implementation checklist

1. Add the plugin-root `commands/` directory and confirm that the plugin build copies it.
2. Add `plugin/commands/autonomous.md`. Its filename maps to `/autonomous`. Use optional command frontmatter only as needed: `description`, `argument-hint`, `allowed-tools`, `model`, and `disable-model-invocation`.
3. Confirm in the supported Claude Code version that invoking the command injects its body into the current session and keeps the contract active for later turns. Do not use startup files for this behavior.
4. Confirm whether the command can reference a shared Markdown contract file. If it cannot, keep the complete contract prose in `autonomous.md`.

## Resolved decision (OQ5)

The MVP is PLUGIN-ONLY. Use `plugin/commands/autonomous.md`, whose body contains or references the autonomous contract, plus an optional shared contract Markdown file. Do not build `src/open/orchestrator-prose.ts` or any new runtime prose composer for this MVP.
