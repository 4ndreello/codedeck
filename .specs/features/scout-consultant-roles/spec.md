# Scout and consultant roles specification

## Problem Statement

CodeDeck sends codebase discovery questions to `general`, which can edit files and uses the implementation binding. Users also need a role that reports code and environment facts without attributing cause, and a role that attributes cause or compares options. `reviewer` inspects existing changes, including specs and scope, so it already owns review.

## Goals

- Add `scout` for sourced facts about repository code, the environment, and external documentation.
- Add `consultant` for reasoned choices among options and diagnoses of suspected causes, including bugs in existing code.
- Route facts, diagnoses, implementation, tests, builds, and reviews to the roles that own them.
- Expose both roles anywhere CodeDeck registers, binds, launches, describes, or documents its roles.
- Keep the same limits as `reviewer` on every current execution path.

## Out of Scope

| Feature | Reason |
| --- | --- |
| A `planner` role | A write-only-in-`.specs` permission cannot be enforced by any current harness. |
| Domain roles such as backend, devops, migrator, api-designer, and performance | These roles are outside the fact-finding and advice gaps. |
| Edits to existing role contracts beyond the routing instructions in `general` and the orchestrator prompts | Other role behavior is not part of this feature. |
| The orchestrator cost-justification sentence in `plugin/prompts/roles/orchestrator.md` that compares its work with a cheaper general worker | It explains the orchestrator's model cost, not routing. Leave it unchanged. |
| Default model choices in code | Users bind each role to their own harness and model. |
| Changes to a user's CodeDeck role bindings or other runtime configuration | This feature registers roles but does not edit a user's configuration. |
| Native permission enforcement on `run --role` | That command strips frontmatter and sends role prose. |
| Changing Codex bypass defaults | Codex `open` currently adds its bypass flag by default. |
| Fixing the pre-existing `README.md:214` claim about `--agent` and `--model` precedence | A separate GitHub issue tracks this inaccuracy. |
| Reconciling unrelated differences between `skills/use-codedeck/SKILL.md` and `~/.claude/skills/use-codedeck/SKILL.md` | Both copies need the new role rows, but their other differences are pre-existing. |
| Design and task artifacts | They belong to later slices. |
| Code, prompt, test, README, or skill edits in this Specify slice | This slice changes only this spec. Later slices implement its requirements. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Role names and prefixes | Append `scout` and `consultant`, in that order, after the four current entries in `ROLES`. Their three-character prefixes are `sco` and `con`. | `MIN_ROLE_PREFIX_LENGTH` is 3, and no current role starts with either prefix. | Yes |
| `explorer` name | Use `scout`. | `explorer` is an `OrchestratorModeLabel` for `EXPLORER_PRESET` in `src/config/orchestrator-mode.ts`, not a CodeDeck role. | Yes |
| Scout purpose and binding | Make `scout` a read-only fact-finder for repository code, environment facts, and external documentation. Users choose its harness and a fast, low-cost model. | This closes the discovery gap without adding a separate librarian role. | Yes |
| Consultant purpose and binding | Make `consultant` a read-only adviser that attributes cause or compares options, including when a suspected bug is in existing code. Users choose its harness and a high-reasoning model. | The consultant can diagnose existing code as well as advise on a proposed change. | Yes |
| Routing boundary | `scout` reports what the code or environment does without attributing cause. `consultant` attributes cause or chooses among options. Work that needs a test or build goes to `general`. Review of an existing diff, spec, or scope goes to `reviewer` or `auditor`. | These definitions settle the overlap between discovery, diagnosis, implementation, and review. | Yes |
| Investigation allowance | The scout rule applies to facts the orchestrator does not investigate itself. With `investigate: none` it delegates discovery to `scout`. With `read` or `free` it may investigate and uses `scout` for questions broad enough to delegate. | Existing dispatcher, balanced, and explorer modes set different investigation allowances. | Yes |
| Unbound role behavior | An unbound `run --role` prints the existing warning and selects the existing harness and model fallback, then exits 3 with `No effort bound to this run` unless `--effort` is supplied or the harness is opencode. An interactive `open` without role effort throws an error. | `src/cli/commands/run.ts` applies the fallback before its effort check; `src/cli/commands/open.ts` and the Claude launcher fail when no effort is available. The new prompt injection must report which of `scout` and `consultant` are bound. | Yes |
| Configuration and session persistence | Add the roles to the existing partial role-binding map and session role values without a configuration version or database migration. | Role bindings already use `Partial<Record<Role, RoleBinding>>`. Session role is an optional string in the existing nullable `TEXT` column. | Yes |
| Harness enforcement | Give both roles the current `reviewer` boundary on every harness and execution path. | Claude tool allowlists, Codex sandbox settings, OpenCode permissions, and role prose have known limits described below. | Yes |
| Generated prompts and budgets | Pin generated headings and prohibitions. Keep scout and consultant prompts within 8,192 bytes and set the `orchestrator-read` and `orchestrator-edit` budget checks to 12,288 bytes. | Heading and prohibition checks preserve the contract while leaving explanatory prose editable. The orchestrator budgets leave room for the routing rules. | Yes |
| Installed skill copy | Mirror the two role rows in the repository skill and the installed `~/.claude` copy. | The installed copy is outside the repository and needs a manual check. Unrelated differences between the copies stay out of scope. | Yes |

**Enforcement boundary:** Claude's `--agent` path in `open` applies the agent's `tools:` allowlist, but `Bash` remains available and can write through shell redirection or launch CodeDeck commands. Claude's measured toolset omits `Grep` and `Glob` when `Bash` is granted, so prompts direct repository searches through the shell with `rg`. Codex `open` passes a read-only sandbox setting on new sessions, but its default bypass flag disables that setting. `--no-bypass` leaves the read-only sandbox active. OpenCode denies `edit`, `write`, and `task` while allowing `bash`, which can still write or launch commands. `run --role` strips frontmatter and delivers the role contract as prose, without native permission enforcement. Read-only and no-dispatch rules therefore remain prompt rules wherever an allowed shell can act. These are the same limits that apply to `reviewer` today.

**Open questions:** none.

## User Stories

### P1: Register and parse both roles

**User Story:** As a CodeDeck user, I want to select `scout` and `consultant` through the existing role interfaces so that I can dispatch fact-finding and advice.

**Why P1:** Role registration and parsing are required before setup, prompts, and launchers can use either role.

**Acceptance Criteria:**

1. **SC-01:** The `ROLES` constant SHALL equal `["general", "orchestrator", "reviewer", "auditor", "scout", "consultant"]`.
2. **SC-02:** The `parseRole` contract SHALL map `scout` and `consultant` to their canonical roles, map `sco` and `con` to the same roles, and return `undefined` for `orchestrator-read`, `orchestrator-edit`, and `explorer`.

**Independent Test:** `tests/roles.test.ts` and `tests/config-models.test.ts`; run `npx vitest run tests/roles.test.ts tests/config-models.test.ts`.

### P1: Configure and inspect both roles

**User Story:** As a CodeDeck user, I want to bind both roles through CLI and web setup and see their status in doctor output and CLI tips.

**Why P1:** Users need to choose each role's harness and model and see when a role is unbound.

**Acceptance Criteria:**

3. **SC-03:** WHEN the CLI setup wizard builds its role choices or `setup --bind` parses a binding for either new role THEN it SHALL offer and accept both `scout` and `consultant`.
4. **SC-04:** IF `setup --bind` receives an unknown role THEN its error message SHALL list `general|orchestrator|reviewer|auditor|scout|consultant` as the accepted roles.
5. **SC-05:** WHEN the web setup page renders its role roster THEN it SHALL render a row with binding and effort controls for each new role, with scout description text `researches code and external docs, then cites the sources it opened.` and consultant description text `recommends an approach or diagnosis, with alternatives and risks.`.
6. **SC-06:** WHEN `isSetupSelection` receives an otherwise valid setup payload with `scout` or `consultant` under `agents` THEN it SHALL return `true`.
7. **SC-07:** WHEN `isSetupSelection` receives an otherwise valid payload with `scout` or `consultant` under `offCatalogConfirmed` THEN it SHALL return `true`.
8. **SC-08:** WHEN doctor renders its roles section THEN it SHALL include rows for both new roles and show `unbound, runs on <harness>` for an unbound role, using `config.defaultAgent` or `claude` when there is no default.
9. **SC-09:** WHEN the CLI name is `<cli>` THEN `spinnerTips()` SHALL include `<cli> open scout answers codebase and documentation questions with citations.`.
10. **SC-10:** WHEN the CLI name is `<cli>` THEN `spinnerTips()` SHALL include `<cli> run --role consultant gives a decision or diagnosis with alternatives.`.

**Independent Test:** `tests/setup-wizard.test.ts`, `tests/setup-cli-contract.test.ts`, `tests/setup-page.test.ts`, `tests/setup-web.test.ts`, `tests/doctor-roles.test.ts`, and `tests/open-args.test.ts`; run `npx vitest run tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts tests/setup-page.test.ts tests/setup-web.test.ts tests/doctor-roles.test.ts tests/open-args.test.ts`.

### P1: Apply the existing read-only boundary

**User Story:** As a user, I want both roles to use the same read-only boundary as `reviewer` on each current harness and prompt path.

**Why P1:** Role names alone do not select permissions; launchers and prompts must classify them consistently.

**Acceptance Criteria:**

11. **SC-11:** The generated Claude agent files for `scout` and `consultant` SHALL declare the exact `tools:` allowlist `Read, Grep, Glob, Bash, WebFetch, WebSearch`.
12. **SC-12:** WHEN Codex or OpenCode opens either new role THEN Codex with `--no-bypass` SHALL use `-s read-only` and OpenCode SHALL apply the existing reviewer permission map, denying `edit`, `write`, and `task` while allowing `bash`.
13. **SC-13:** WHEN `run --role` composes either role THEN it SHALL remove the role prompt frontmatter.
14. **SC-14:** WHEN `run --role` composes either role THEN it SHALL include the role contract body in the prompt.
15. **SC-15:** WHEN `copy-plugin` resolves the `proof` partial for either role THEN the role-specific partial SHALL include shared claim-verification guidance and omit worker-specific diff-inspection guidance.
16. **SC-16:** The scout and consultant prompts and `docs/harness-behaviour.md` SHALL direct repository searches through the shell with `rg`.
17. **SC-17:** The budget checks in `tests/prompt-layers.test.ts` SHALL cap scout and consultant prompts at 8,192 bytes and set the `orchestrator-read` and `orchestrator-edit` budgets to 12,288 bytes.

**Independent Test:** `tests/plugin-manifest.test.ts`, `tests/prompt-layers.test.ts`, `tests/open-codex.test.ts`, `tests/open-opencode.test.ts`, `tests/open-contract.test.ts`, `tests/open-sandbox.test.ts`, `tests/config-sandbox.test.ts`, `tests/open-worktree-prompt.test.ts`, and `tests/run-role.test.ts`; run `npx vitest run tests/plugin-manifest.test.ts tests/prompt-layers.test.ts tests/open-codex.test.ts tests/open-opencode.test.ts tests/open-contract.test.ts tests/open-sandbox.test.ts tests/config-sandbox.test.ts tests/open-worktree-prompt.test.ts tests/run-role.test.ts`.

### P1: Report factual findings as scout

**User Story:** As a CodeDeck user, I want `scout` to report sourced facts without advising or editing so that I can gather evidence before choosing an approach.

**Why P1:** Repository discovery and external-document lookup are the first gap this feature closes.

**Acceptance Criteria:**

18. **SC-18:** The generated `scout` agent file SHALL contain the exact headings `## Confirmed facts`, `## Guesses`, and `## Could not determine`.
19. **SC-19:** WHEN `scout` reports a confirmed code fact or external fact THEN it SHALL cite, respectively, the opened file and line or the opened external URL.
20. **SC-20:** The generated `scout` agent prompt SHALL prohibit recommending changes.
21. **SC-21:** The generated `scout` agent prompt SHALL prohibit modifying files.

**Independent Test:** `tests/plugin-manifest.test.ts` and `tests/prompt-layers.test.ts`; run `npx vitest run tests/plugin-manifest.test.ts tests/prompt-layers.test.ts`.

### P1: Recommend options and diagnose causes as consultant

**User Story:** As a CodeDeck user, I want `consultant` to recommend an approach or diagnose a suspected cause so that I can weigh alternatives and risks.

**Why P1:** No current role provides a read-only second opinion on choices and causes.

**Acceptance Criteria:**

22. **SC-22:** The generated `consultant` agent file SHALL contain the exact headings `## Recommendation`, `## Alternatives considered`, `## Risks`, and `## Evidence that would change this recommendation`.
23. **SC-23:** WHEN `consultant` makes a runtime claim based on a probe THEN it SHALL cite the probe command and its observed result.
24. **SC-24:** IF `consultant` makes a runtime claim without running a probe THEN it SHALL label that claim as a guess.
25. **SC-25:** IF `consultant` writes a diagnostic probe THEN it SHALL place the probe outside the repository and SHALL not modify repository files.
26. **SC-26:** The scout and consultant prompts SHALL prohibit dispatching workers or subagents.

**Independent Test:** `tests/plugin-manifest.test.ts` and `tests/prompt-layers.test.ts`; run `npx vitest run tests/plugin-manifest.test.ts tests/prompt-layers.test.ts`.

### P1: Route discovery, diagnosis, implementation, and review

**User Story:** As an orchestrator or general worker, I want factual discovery, diagnosis, implementation, and review routed by a stable boundary so that each task keeps its existing owner.

**Why P1:** Routing must distinguish factual reports from cause attribution, tests, builds, and review.

**Acceptance Criteria:**

27. **SC-27:** The orchestrator prompts SHALL use one routing boundary: scout reports what code or the environment does without attributing cause; consultant attributes cause or chooses among options; work requiring a test or build goes to general; review of an existing diff, spec, or scope goes to reviewer or auditor.
28. **SC-28:** The orchestrator's discovery routing SHALL respect its investigation allowance, delegating factual discovery it does not investigate to bound scout when the allowance is `none` and allowing self-investigation and sending broad factual questions to scout when it is `read` or `free`, without retaining an unconditional `You discover by dispatching, not by looking` rule.
29. **SC-29:** The runtime prompt injection in `src/open/orchestrator-prose.ts` SHALL tell the orchestrator whether scout and consultant are bound.
30. **SC-30:** IF scout is unbound THEN the orchestrator prompt SHALL route factual discovery to general.
31. **SC-31:** IF consultant is unbound THEN the orchestrator prompt SHALL omit the consultant consultation step.
32. **SC-32:** WHEN general is stuck on cause attribution or a choice among options and consultant is bound THEN the general prompt SHALL direct it to consult consultant.

Where a dispatcher, balanced, or explorer prompt manifest or generated agent file contains one of the following legacy instructions, replace that occurrence with the role route stated in its criterion. The instructions occur in different mode variants:

33. **SC-33:** The prompts SHALL replace `You dispatch a general worker to find out and report back` with scout for factual discovery the orchestrator does not investigate itself.
34. **SC-34:** The prompts SHALL replace `Dispatch a worker for facts that live in the repo or environment.` with scout reporting repository and environment facts without attributing cause.
35. **SC-35:** The prompts SHALL replace `Report what you found and what you would change.` with scout reporting facts and general owning changes.
36. **SC-36:** The prompts SHALL replace `a general worker could answer by looking` with scout for factual questions and consultant for cause or options.
37. **SC-37:** The prompts SHALL replace `That is a slice for a general worker, so write the briefing and dispatch it.` with general owning file changes, tests, and builds.
38. **SC-38:** The prompts SHALL replace `Every one of these means the same thing: write the briefing, dispatch a general worker, read its report.` with the routing boundary in SC-27.

**Independent Test:** Add `tests/orchestrator-routing.test.ts` with assertions for the routing boundary, investigation allowance, binding status, unbound-role routes, and the general prompt. Also run the existing prompt snapshot and budget checks in `tests/orchestrator-agents.test.ts` and `tests/prompt-layers.test.ts`; run `npx vitest run tests/orchestrator-routing.test.ts tests/orchestrator-agents.test.ts tests/prompt-layers.test.ts`.

### P1: Document the six roles

**User Story:** As a CodeDeck user or agent, I want role guidance to list the current roles so that I can choose and dispatch the right one.

**Why P1:** README and agent guidance are the current references used by people and agents.

**Acceptance Criteria:**

39. **SC-39:** The README role inventory SHALL identify all six roles using the overview label, table, binding description, and count-free permission note below.

- The overview label is `Six roles`.
- The binding description refers to `each of the six roles`.
- The permission note omits `the three that lose`.
- The role table contains exactly these six rows:

```text
| `general` | yes | yes | ordinary work, done here |
| `orchestrator` | no `Edit`/`Write` | yes | building by spreading the work, proving it with `codedeck diff` |
| `auditor` | no `Edit`/`Write` | yes | reviewing a scope too large for one pass, sliced by dimension |
| `reviewer` | no `Edit`/`Write` | no | one pass, no fan-out, says what it did not cover |
| `scout` | no `Edit`/`Write` | no | codebase facts and external-document research with citations |
| `consultant` | no `Edit`/`Write` | no | decisions among options and diagnosis with risks |
```

40. **SC-40:** The agent-facing role inventories SHALL include both new roles in `CLAUDE.md`, `skills/use-codedeck/SKILL.md`, `skills/handoff/SKILL.md`, and the installed `~/.claude/skills/use-codedeck/SKILL.md`.

- `CLAUDE.md` lists general, orchestrator, reviewer, auditor, scout, and consultant.
- The repository and installed skill copies contain both exact rows: ``| `scout` | no | no | codebase facts and external-document research with citations |`` and ``| `consultant` | no | no | decisions among options and diagnosis with risks |``.
- The handoff suggested-role list is ``(`general`, `orchestrator`, `auditor`, `reviewer`, `scout`, `consultant`)``.

**Independent Test:** Check the README, `CLAUDE.md`, `skills/use-codedeck/SKILL.md`, and `skills/handoff/SKILL.md` in CI. Manually check the installed `~/.claude/skills/use-codedeck/SKILL.md` after mirroring the repository copy; this home-directory check is not a CI criterion.

## Repository Surfaces Found by Search

These files register roles, branch on a CodeDeck role, bind roles, generate agents, or give current role guidance. They are implementation surfaces for later slices; this Specify slice changes only this spec.

| Surface | Role use |
| --- | --- |
| `src/core/roles.ts` | Role list, parser, prefixes, and prompt file resolution. |
| `src/config/config.ts`, `src/config/setup.ts` | Role binding type, resolution, and setup configuration plan. |
| `src/cli/commands/run.ts`, `src/cli/commands/open.ts`, `src/daemon/daemon.ts` | Role parsing, run dispatch, open selection, and session role parsing. |
| `src/cli/commands/setup.ts` | CLI setup wizard, `setup --bind` parsing, and invalid-role help text. |
| `src/cli/commands/doctor.ts` | Role rows and unbound fallback display. |
| `src/core/session.ts`, `src/store/database.ts`, `src/store/sessions.ts` | Session role identity and existing nullable `TEXT` storage. |
| `src/open/contract.ts`, `src/open/launchers/claude.ts` | Role contract selection and Claude agent selection. |
| `src/open/launchers/codex.ts`, `src/open/launchers/opencode.ts` | Per-role Codex sandbox and OpenCode permission maps. |
| `src/config/orchestrator-mode.ts`, `src/open/orchestrator-prose.ts` | Investigation allowance and its runtime prompt injection. |
| `src/open/runtime.ts` | Spinner tips that describe role-specific CLI use. |
| `src/web/setup-page.ts` | Setup order, role descriptions, binding controls, and effort controls. |
| `src/web/setup-routes.ts` | Role-key and per-role confirmation validation. |
| `scripts/copy-plugin.mjs` | Prompt manifest composition and generated agent files. |
| `plugin/prompts/roles/*.md`, `plugin/prompts/_partials/*.md` | Role contracts and shared prompt text. |
| `plugin/agents/*.md` | Generated agent output checked against prompt manifests. |
| `tests/__snapshots__/orchestrator-agents.test.ts.snap` | Generated orchestrator prompt snapshots. |
| `README.md`, `CLAUDE.md`, `docs/harness-behaviour.md` | Product, repository, and harness documentation describing roles. |
| `skills/use-codedeck/SKILL.md`, `~/.claude/skills/use-codedeck/SKILL.md` | Role selection guidance; both copies need the new rows. |
| `skills/handoff/SKILL.md` | Suggested role list for follow-up work. |
| `docs/superpowers/plans/open-adopt-release.md`, `docs/superpowers/specs/open-adopt-release.md` | Historical plans; preserve their historical record. |

## Focused Test Surfaces

- Registration and run roles: `tests/roles.test.ts`, `tests/config-models.test.ts`, `tests/run-role.test.ts`.
- Tool manifests and harness launchers: `tests/plugin-manifest.test.ts`, `tests/open-codex.test.ts`, `tests/open-opencode.test.ts`, `tests/open-contract.test.ts`, `tests/open-sandbox.test.ts`, `tests/config-sandbox.test.ts`, `tests/open-worktree-prompt.test.ts`.
- Role and orchestrator prompt budgets: `tests/prompt-layers.test.ts`, `tests/orchestrator-agents.test.ts`, and `tests/__snapshots__/orchestrator-agents.test.ts.snap`.
- Orchestrator allowance and routing: `tests/orchestrator-prose.test.ts`, `tests/orchestrator-mode.test.ts`, `tests/orchestrator-routing.test.ts`, and `tests/open-args.test.ts`.
- Setup and doctor: `tests/setup-wizard.test.ts`, `tests/setup-cli-contract.test.ts`, `tests/setup-page.test.ts`, `tests/setup-web.test.ts`, and `tests/doctor-roles.test.ts`.
- Pin updates include `CLAUDE.md:52`; change `spinnerTips().toHaveLength(12)` at `tests/open-args.test.ts:481` to 14 after adding both tips; add both agent files to the role list and both roles to the five-role constrained loop in `tests/plugin-manifest.test.ts:231-238` and `:254`; and add both roles to the six-role loop in `tests/prompt-layers.test.ts:172`.

The naming check also read `src/config/orchestrator-mode.ts`. Its `explorer` label belongs to `OrchestratorModeLabel` and `EXPLORER_PRESET`, not to `ROLES`.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| SC-01 | Register and parse both roles | Specify | Specified |
| SC-02 | Register and parse both roles | Specify | Specified |
| SC-03 | Configure and inspect both roles | Specify | Specified |
| SC-04 | Configure and inspect both roles | Specify | Specified |
| SC-05 | Configure and inspect both roles | Specify | Specified |
| SC-06 | Configure and inspect both roles | Specify | Specified |
| SC-07 | Configure and inspect both roles | Specify | Specified |
| SC-08 | Configure and inspect both roles | Specify | Specified |
| SC-09 | Configure and inspect both roles | Specify | Specified |
| SC-10 | Configure and inspect both roles | Specify | Specified |
| SC-11 | Apply the existing read-only boundary | Specify | Specified |
| SC-12 | Apply the existing read-only boundary | Specify | Specified |
| SC-13 | Apply the existing read-only boundary | Specify | Specified |
| SC-14 | Apply the existing read-only boundary | Specify | Specified |
| SC-15 | Apply the existing read-only boundary | Specify | Specified |
| SC-16 | Apply the existing read-only boundary | Specify | Specified |
| SC-17 | Apply the existing read-only boundary | Specify | Specified |
| SC-18 | Report factual findings as scout | Specify | Specified |
| SC-19 | Report factual findings as scout | Specify | Specified |
| SC-20 | Report factual findings as scout | Specify | Specified |
| SC-21 | Report factual findings as scout | Specify | Specified |
| SC-22 | Recommend options and diagnose causes as consultant | Specify | Specified |
| SC-23 | Recommend options and diagnose causes as consultant | Specify | Specified |
| SC-24 | Recommend options and diagnose causes as consultant | Specify | Specified |
| SC-25 | Recommend options and diagnose causes as consultant | Specify | Specified |
| SC-26 | Recommend options and diagnose causes as consultant | Specify | Specified |
| SC-27 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-28 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-29 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-30 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-31 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-32 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-33 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-34 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-35 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-36 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-37 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-38 | Route discovery, diagnosis, implementation, and review | Specify | Specified |
| SC-39 | Document the six roles | Specify | Specified |
| SC-40 | Document agent-facing role inventories | Specify | Specified |
