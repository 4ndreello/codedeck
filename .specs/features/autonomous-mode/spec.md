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

The realistic MVP injection point is option (a), a plugin slash-command asset whose expansion is the autonomous contract. It is the only candidate that can satisfy an explicit command in a session that is already running. The command must carry the contract prose, or use a shared prose file only if the supported command mechanism proves that it can include one.

Option (b) alone is not wired. No current loader references a shared autonomous file. `ultra.md` and the role file are startup inputs, so changing either would affect newly launched sessions, not the current session. Option (c) would require new runtime support and is outside this MVP.

The exact command directory, frontmatter, and whether Claude Code expands the command body into the current session are open questions below. The implementation must resolve those questions before adding a command file. It must not infer a command format from the agent frontmatter.

## Behavior contract

After activation, the orchestrator follows this contract for the rest of the session.

### Never ask the human

The orchestrator must never ask the human a question, request a choice, wait for an answer, or stop because a human answer is unavailable. If the orchestrator or a worker would need to ask the human for input, that work is blocked.

### Decision rubric

Use this master test first: can the decision be undone with `git revert`?

1. Reversible and cheap decisions are made immediately. This includes picking a library or name, writing a test, refactoring, creating a file, and editing code. Record the assumption in the running notes and final report.
2. Irreversible or destructive actions are never taken without the human. This includes deleting data, force pushing, touching production, spending money, making external side-effecting calls, and applying a database migration. Defer the action and record it in the report. Do not ask for permission.
3. An ambiguous product decision that genuinely matters is deferred as a pending question. Record the question, then route around it by doing independent work that does not depend on the answer.

The rubric governs the orchestrator's decisions. A worker's question is evidence of a blocker, not permission to ask the human.

For this MVP, choosing a library is explicitly bucket 1 work even when it has follow-up cost. Record the assumption. The separate ban on external side effects still applies.

### Route around blockers

When a task is deferred or blocked, the orchestrator records the reason, keeps a running notes entry, and continues dispatching or doing every independent task. One blocker must not halt the whole run. Work that depends on the deferred decision remains listed as deferred.

## Report and notes

Use these repository paths for an autonomous run. `<slug>` is the feature slug from the active work item, lowercased with every run of non-alphanumeric characters replaced by one hyphen and leading or trailing hyphens removed. If the work item has no feature slug, use `autonomous-mode`. The orchestrator creates the directory and both files when the mode activates, before writing the first note.

- Running notes: `.specs/features/<slug>/run-notes.md`
- Final report: `.specs/features/<slug>/run-report.md`

The notes log is append-only during the run. Each entry records the time or sequence, the decision or blocker, its category, the reason, and the independent work taken around it. At the end, fold the notes into `run-report.md` rather than leaving the report dependent on a separate log.

The final report contains these sections, in this order. `Done` includes these Markdown links when a web remote is available: `- Branch: [<branch-name>](<remote>/tree/<branch-name>)` and `- Commit: [<full-sha>](<remote>/commit/<full-sha>)`. If no web remote is available, include the exact branch name and full commit SHA and state that links are unavailable.

1. `Done`, including commit and branch links.
2. `Assumptions I made`, covering reversible calls recorded during the run.
3. `Deferred / waiting for you`, covering irreversible actions and pending product questions.
4. `Blocked / failed`, covering failed work, blocked workers, and reasons.
5. `Not covered`, covering work left out of the run and why.

## Acceptance criteria

1. A user must explicitly invoke `/autonomous` in a running interactive orchestrator session before the contract can apply.
2. The command expansion must contain the no-question rule, the definition of blocked work, the three decision buckets, the `git revert` master test, the route-around rule, the running-notes rule, and the final-report rule.
3. The contract must state that neither the orchestrator nor a worker may turn a blocker into a question for the human. The orchestrator records the blocker or pending question instead.
4. The contract must classify reversible, cheap work as allowed with an assumption note, and irreversible or destructive work as deferred without human approval.
5. The contract must require independent work to continue after a defer or block. A single blocked task must not stop the run.
6. The contract must name `.specs/features/<slug>/run-notes.md` and `.specs/features/<slug>/run-report.md`, and the final report must contain all five required sections.
7. No startup file, configuration setting, worker question, or other implicit event may activate autonomous mode.
8. The MVP must not add blocker detection, live answer injection, timeouts, scheduling, a dependency graph, structured report IPC or CLI, or automatic activation.

## Testing notes

This feature is mainly plugin and prompt content, so verification is bounded and textual.

- Check the command asset in the command location confirmed by the open question. Read its frontmatter and body, then use `rg` to verify these literal markers: `must never ask the human`, `or a worker would need to ask the human`, `can the decision be undone with \`git revert\``, `Reversible and cheap`, `Irreversible or destructive`, `ambiguous product decision`, `route around`, `run-notes.md`, `run-report.md`, `Done`, `Assumptions I made`, `Deferred / waiting for you`, `Blocked / failed`, and `Not covered`. A pass requires every marker. If the command location or syntax is still unconfirmed, record that as a failed prerequisite instead of treating a guessed file as a passing test.
- After any plugin change, run `npm run build:plugin` and verify that the corresponding file exists under `dist/plugin` with the same content. `scripts/copy-plugin.mjs:7-11` is the copy path.
- Run a simulated dry-run narrative with at least these cases: choose a library and write a test, record the assumption; encounter a production change or database migration, defer it without asking; encounter an important product ambiguity, record a pending question and continue an independent task; encounter a worker question, record the blocker and dispatch unrelated work.
- Test explicit activation with two simulated transcripts. One transcript starts and continues without `/autonomous` and must not use the contract. The second invokes `/autonomous` and must apply it on subsequent decisions. No automatic activation path may appear in either transcript.
- Inspect a sample `run-notes.md` and final `run-report.md` to confirm the notes were folded into the required report sections. With a web remote, `Done` must match `Branch: [<branch-name>](<remote>/tree/<branch-name>)` and `Commit: [<full-sha>](<remote>/commit/<full-sha>)`. Without one, it must contain the exact branch name, full commit SHA, and an explicit links-unavailable note.
- No source-code or full-suite test is required for this spec-only artifact. Runtime guarantees beyond the command expansion are not proven by prompt checks and remain outside this MVP.

## Explicit OUT OF SCOPE

All Phase 2 infrastructure is out of scope:

- daemon-level blocker detection or production of `needs_input`;
- live-answer injection into a running process;
- inactivity or deadline timeouts;
- a run-level scheduler or dependency graph;
- a structured or persisted report schema with IPC or CLI;
- any automatic, non-explicit activation.

## Open questions

1. Does this plugin and the supported Claude Code version discover slash commands from `plugin/commands/`? The current tree has no command directory or example, and `plugin/.claude-plugin/plugin.json:1-11` does not declare one.
2. What frontmatter and body format does a supported plugin slash command require? The repository only proves the agent frontmatter format at `plugin/agents/orchestrator.md:1-5`; it does not prove that commands use the same format.
3. When a user invokes the command, does Claude Code inject its body into the current conversation and keep the contract active for later turns? The current CodeDeck launcher only supplies startup prompt and agent arguments at `src/open/launchers/claude.ts:108-119`.
4. Can a command reference a shared Markdown contract file? If not, the MVP command must carry the complete contract prose itself.
5. `analysis.md:68-79` recommends `src/open/orchestrator-prose.ts` or an agent variant, but `src/open/orchestrator-prose.ts` is absent on this branch. Should implementation add a new runtime composer, or remain plugin-only after the slash-command mechanism is confirmed? Adding runtime support would change the MVP scope and needs an explicit decision.
