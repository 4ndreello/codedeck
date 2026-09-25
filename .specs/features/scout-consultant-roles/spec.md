# Scout and consultant roles specification

## Problem Statement

CodeDeck sends codebase discovery questions to `general`, which can edit files
and uses the implementation binding. Users also have no role for a second
opinion on a decision or diagnosis before code exists. `reviewer` evaluates
existing changes after implementation, so it does not fill either gap.

## Goals

- Add `scout` for read-only fact-finding about repository code and external
  documentation.
- Add `consultant` for read-only decisions and diagnosis before implementation.
- Route discovery and decision questions to those roles while keeping
  implementation on `general` and review on `reviewer` or `auditor`.
- Expose both roles anywhere CodeDeck registers, binds, launches, describes, or
  documents its roles.

## Out of Scope

| Feature | Reason |
| --- | --- |
| A `planner` role | A write-only-in-`.specs` permission cannot be enforced by any current harness. |
| Domain roles such as backend, devops, migrator, api-designer, and performance | These roles are outside the two fact-finding and advice gaps. |
| Changes to existing role contracts beyond the routing lines in `general` and the orchestrator prompts | Existing role behavior is not part of this feature. |
| Default model choices in code | Users bind each role to their own harness and model. |
| Changes to the user's CodeDeck role bindings or other runtime configuration | This feature registers roles but does not edit a user's configuration. |
| Native permission enforcement on `run --role` | `run --role` currently sends role prose after stripping frontmatter. |
| Changing Codex bypass defaults | Codex `open` currently adds its bypass flag by default. |
| Reconciling the existing divergence between `skills/use-codedeck/SKILL.md` and `~/.claude/skills/use-codedeck/SKILL.md` | Both copies must receive the new role text, but unrelated differences between the copies are pre-existing. |
| `design.md` and `tasks.md` | Those artifacts belong to later slices. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Role names and prefixes | Append `scout` and `consultant`, in that order, after the four existing entries in `ROLES`. Their three-character prefixes are `sco` and `con`. | `MIN_ROLE_PREFIX_LENGTH` is 3. The current `ROLES` are `general`, `orchestrator`, `reviewer`, and `auditor`; none starts with `sco` or `con`, so both prefixes resolve uniquely after registration. | Default from the orchestrator's recommendation; user said proceed. |
| `explorer` name | Use `scout`, not `explorer`. | `explorer` is already an `OrchestratorModeLabel` and the label for `EXPLORER_PRESET` in `src/config/orchestrator-mode.ts`; it is not a CodeDeck role. | Default from the orchestrator's recommendation; user said proceed. |
| Scout purpose and binding | Make `scout` a read-only, non-dispatching fact-finder for codebase facts and external documentation. Bind it to a fast, low-cost model by user choice. | This closes the discovery gap without adding a separate librarian role. | Default from the orchestrator's recommendation; user said proceed. |
| Consultant purpose and binding | Make `consultant` a read-only, non-dispatching adviser for pre-implementation decisions and diagnosis. Bind it to the strongest model with high effort by user choice. | This gives users a second opinion before an implementation exists. | Default from the orchestrator's recommendation; user said proceed. |
| Harness enforcement | Give both roles the same enforcement as `reviewer` on every current path and harness. | A new sandbox is outside this feature. Existing harness boundaries are documented below. | Default from the orchestrator's recommendation; user said proceed. |
| Claude tool list | Write `tools: Read, Grep, Glob, Bash, WebFetch, WebSearch`, with no `Task`, `Edit`, or `Write`. Prompt text directs repository searches through `Bash` and `rg`. | `docs/harness-behaviour.md` measures that granting `Bash` removes `Grep` and `Glob` from Claude's resolved toolset. The resolved set is `Read`, `Bash`, `WebFetch`, and `WebSearch`; the prompt must not claim `Grep` or `Glob` are available. | Default from the orchestrator's recommendation; user said proceed. |
| Orchestrator routing | Route fact-finding to `scout`, decisions and diagnosis to `consultant`, implementation to `general`, and review to `reviewer` or `auditor`. Let `general` consult `consultant` when stuck on a decision or diagnosis. | These are the two identified gaps and the existing implementation and review roles remain in place. | Default from the orchestrator's recommendation; user said proceed. |
| Auditor routing | Leave the `auditor` contract unchanged. | Its delegated slices return review findings; the new `scout` route is for orchestrator discovery and does not change audit ownership. | Default from the orchestrator's recommendation; user said proceed. |
| Unbound roles | Preserve current unbound-role behavior, with no new fallback. | `resolveRoleBinding` returns `undefined` when a binding is missing or invalid. `run --role` then uses the existing harness/model fallback and prints its unbound warning. Doctor reports the role as unbound and names the fallback harness. | Default from the orchestrator's recommendation; user said proceed. |
| Configuration and session persistence | Add the roles to the existing `Partial<Record<Role, RoleBinding>>` map without a configuration version or migration. | `Session.role` is an optional string persisted in the existing `sessions.role TEXT` column, so these role values need no database schema change. | Default from the orchestrator's recommendation; user said proceed. |
| Installed skill copy | Add the new role guidance to the repository skill and the installed `~/.claude` copy. | The two current files already diverge, so mirroring only the new role text avoids folding unrelated edits into this feature. | Default from the orchestrator's recommendation; user said proceed. |

**Enforcement boundary:** Claude's `--agent` path in `open` applies the
agent's `tools:` allowlist, but `Bash` remains available and can write through
shell redirection or launch CodeDeck commands. The requested list includes
`Grep` and `Glob`, but the measured Claude behavior removes both when `Bash`
is granted; role prompts use `Bash` with `rg` for searches. Codex `open` passes
the role's `read-only` sandbox setting on new sessions, but its default bypass
flag disables the sandbox's effect. `--no-bypass` omits that flag and leaves
the read-only sandbox active. OpenCode denies `edit`, `write`, and `task`,
while allowing `bash`, which can still write or launch commands. `run --role`
strips frontmatter and delivers the role contract as prose, without native
permission enforcement. The read-only and no-dispatch contracts therefore
remain prompt rules wherever an allowed shell can act. These are the same
limits that apply to `reviewer` today.

**Open questions:** none. The auditor routing choice is recorded above.

## User Stories

### P1: Register and parse both roles

**User Story:** As a CodeDeck user, I want to select `scout` and `consultant`
through the existing role interfaces so that I can dispatch fact-finding and
pre-implementation advice.

**Why P1:** Role registration and parsing are required before setup, prompts,
or launchers can use either role.

**Acceptance Criteria:**

1. **R1:** The `ROLES` constant SHALL equal `["general", "orchestrator", "reviewer", "auditor", "scout", "consultant"]`.
2. **R2:** WHEN `parseRole` receives `scout` or `consultant` THEN it SHALL return the matching role.
3. **R3:** WHEN `parseRole` receives `sco` or `con` THEN it SHALL return `scout` or `consultant`, respectively.
4. **R4:** WHEN `parseRole` receives `orchestrator-read`, `orchestrator-edit`, or `explorer` THEN it SHALL return `undefined`.
5. **R5:** IF `agents[scout]` or `agents[consultant]` is missing, has an invalid harness, or has a missing or blank model THEN `resolveRoleBinding` SHALL return `undefined` for that role.
6. **R6:** WHEN `run --role` receives either registered role without a valid binding THEN it SHALL choose the harness from explicit `--agent`, `defaultAgent`, or `claude`, in that order.
7. **R7:** WHEN `run --role` receives either registered role without a valid binding THEN it SHALL choose the model from explicit `--model`, `models[harness]`, `defaultModel`, or the driver's default, in that order.
8. **R8:** WHEN `run --role` receives either role name or prefix without a valid binding THEN it SHALL print the existing warning containing `role "<raw --role argument>" is not bound`.
9. **R9:** WHEN `run --role` receives `sco` or `con` THEN it SHALL pass `scout` or `consultant`, respectively, to session creation.

**Independent Test:** `tests/roles.test.ts`, `tests/config-models.test.ts`,
`tests/run-role.test.ts`, and `tests/open-args.test.ts`; run
`npx vitest run tests/roles.test.ts tests/config-models.test.ts tests/run-role.test.ts tests/open-args.test.ts`.

### P1: Apply the existing read-only enforcement per harness

**User Story:** As a user, I want both roles to use the same read-only
enforcement as `reviewer` so that their launch behavior follows the current
role boundary on each harness.

**Why P1:** The role names alone do not select permissions; each launcher and
prompt path must classify them consistently.

**Acceptance Criteria:**

1. **R10:** The source role prompt manifests for `scout` and `consultant` SHALL declare the exact `tools:` allowlist `Read, Grep, Glob, Bash, WebFetch, WebSearch`.
2. **R11:** The generated Claude agent files for `scout` and `consultant` SHALL declare the exact `tools:` allowlist `Read, Grep, Glob, Bash, WebFetch, WebSearch`, which contains no `Task`, `Edit`, or `Write`.
3. **R12:** The generated prompt body for each role SHALL contain the exact instruction ``Use `Bash` with `rg` for repository searches.``
4. **R13:** WHEN `roleSandbox` receives `scout` or `consultant` THEN it SHALL return `read-only`.
5. **R14:** WHEN `rolePermission` receives `scout` or `consultant` THEN it SHALL return `{ edit: "deny", write: "deny", task: "deny", bash: "allow" }`.
6. **R15:** WHEN Codex `open` starts a new session for either role with `--no-bypass` THEN its arguments SHALL include `-s read-only` and omit `--dangerously-bypass-approvals-and-sandbox`.
7. **R16:** WHEN `run --role` composes either role THEN it SHALL remove the frontmatter and include the role contract body in the prompt.
8. **R17:** WHEN `scripts/copy-plugin.mjs` generates the plugin THEN it SHALL create `plugin/agents/scout.md` and `plugin/agents/consultant.md` from their role prompt manifests.
9. **R18:** The `scout` and `consultant` role prompt manifests SHALL list `proof` followed by `rename-run` in `includes:`.
10. **R19:** WHEN `scripts/copy-plugin.mjs` resolves `proof` for `scout` or `consultant` THEN the resolved partial SHALL contain the exact sentence `Verify before you claim.`.
11. **R20:** WHEN `scripts/copy-plugin.mjs` resolves `proof` for `scout` or `consultant` THEN the resolved partial SHALL omit the exact sentence ``Read `codedeck diff <id>` yourself before believing any worker.``
12. **R21:** `tests/prompt-layers.test.ts` SHALL set both roles' `EXPECTED` phrases to `[12, 14]`.
13. **R22:** `tests/prompt-layers.test.ts` SHALL set both roles' `BUDGETS` to `8192` bytes.

**Independent Test:** `tests/plugin-manifest.test.ts`,
`tests/prompt-layers.test.ts`, `tests/open-codex.test.ts`,
`tests/open-opencode.test.ts`, `tests/open-contract.test.ts`,
`tests/open-sandbox.test.ts`, `tests/config-sandbox.test.ts`,
`tests/open-worktree-prompt.test.ts`, and `tests/run-role.test.ts`; run
`npx vitest run tests/plugin-manifest.test.ts tests/prompt-layers.test.ts tests/open-codex.test.ts tests/open-opencode.test.ts tests/open-contract.test.ts tests/open-sandbox.test.ts tests/config-sandbox.test.ts tests/open-worktree-prompt.test.ts tests/run-role.test.ts`.

### P1: Answer factual questions as scout

**User Story:** As a CodeDeck user, I want `scout` to report sourced facts
without advising or editing so that I can gather evidence before choosing an
approach.

**Why P1:** Codebase discovery and external-document lookup are the first gap
this feature closes.

**Acceptance Criteria:**

1. **R23:** The generated `scout` agent file SHALL contain the exact headings `## Confirmed facts`, `## Guesses`, and `## Could not determine`.
2. **R24:** The generated `scout` agent file SHALL contain the exact instruction `Cite each confirmed code fact as file:line from a file you opened. Cite each confirmed external fact with the URL you opened.`
3. **R25:** The generated `scout` agent file SHALL contain the exact instruction `Label each unverified claim as a guess under ## Guesses.`
4. **R26:** The generated `scout` agent file SHALL contain the exact instruction `List unanswered facts under ## Could not determine.`
5. **R27:** The generated `scout` agent file SHALL contain the exact instruction `Do not recommend changes.`
6. **R28:** The generated `scout` agent file SHALL contain the exact instruction `Do not edit or write files.`
7. **R29:** The generated `scout` agent file SHALL contain the exact instruction `Never dispatch workers or subagents.`

**Independent Test:** `tests/plugin-manifest.test.ts` and
`tests/prompt-layers.test.ts`; run
`npx vitest run tests/plugin-manifest.test.ts tests/prompt-layers.test.ts`.

### P1: Give pre-implementation advice as consultant

**User Story:** As a CodeDeck user, I want `consultant` to recommend an
approach or diagnose a suspected cause before code exists so that I can make a
decision with its alternatives and risks in view.

**Why P1:** No current role provides a second opinion before implementation.

**Acceptance Criteria:**

1. **R30:** The generated `consultant` agent file SHALL contain the exact instruction `Answer decision and diagnosis questions before implementation begins.`
2. **R31:** The generated `consultant` agent file SHALL contain the exact headings `## Recommendation`, `## Alternatives considered`, `## Risks`, and `## Evidence that would change this recommendation`.
3. **R32:** The generated `consultant` agent file SHALL contain the exact instruction `Give one recommendation in ## Recommendation.`
4. **R33:** The generated `consultant` agent file SHALL contain the exact instruction `For each alternative, state why you reject it in ## Alternatives considered.`
5. **R34:** The generated `consultant` agent file SHALL contain the exact instruction `List risks in ## Risks.`
6. **R35:** The generated `consultant` agent file SHALL contain the exact instruction `Name evidence that would change your recommendation in ## Evidence that would change this recommendation.`
7. **R36:** The generated `consultant` agent file SHALL contain the exact instruction `For each runtime claim, cite the probe command and its observed result. If you did not run a probe, label the claim as a guess.`
8. **R37:** The generated `consultant` agent file SHALL contain the exact instruction `Do not edit or write files.`
9. **R38:** The generated `consultant` agent file SHALL contain the exact instruction `Never dispatch workers or subagents.`

**Independent Test:** `tests/plugin-manifest.test.ts` and
`tests/prompt-layers.test.ts`; run
`npx vitest run tests/plugin-manifest.test.ts tests/prompt-layers.test.ts`.

### P1: Route discovery and advice to the new roles

**User Story:** As an orchestrator or general worker, I want factual discovery
and pre-implementation decisions routed to the matching role so that
implementation and review work keep their existing owners.

**Why P1:** Adding roles only helps if prompts use them for the questions they
were created to answer.

**Acceptance Criteria:**

1. **R39:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL contain the exact instruction `Send factual codebase and external-document discovery questions to scout.`
2. **R40:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL omit the legacy discovery instructions `You dispatch a general worker to find out and report back`, `Dispatch a worker for facts that live in the repo or environment`, `Report what you found and what you would change`, `a general worker could answer by looking`, `That is a slice for a general worker, so write the briefing and dispatch it`, `Every one of these means the same thing: write the briefing, dispatch a general worker, read its report`, and `Every file you would read, every failure you would debug, every fix you would type is a token spent at the highest rate on something a cheaper general worker does just as well.`.
3. **R41:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL contain the exact instruction `For an unknown, send codebase and environment facts to scout, pre-implementation diagnoses and decisions to consultant, and file changes plus test/build work to general.`
4. **R42:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL contain the exact instruction `For discovery, ask scout to report confirmed facts, guesses, and unknowns. Do not ask scout for changes or recommendations.`
5. **R43:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL contain the exact instruction `Send pre-implementation decision and diagnosis questions to consultant.`
6. **R44:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL contain the exact instruction `Send implementation work to general.`
7. **R45:** The `orchestrator`, `orchestrator-read`, and `orchestrator-edit` prompt manifests and generated agent files SHALL contain the exact instruction `Send change review to reviewer and broad-scope review to auditor.`
8. **R46:** The `general` prompt manifest and generated agent file SHALL contain the exact instruction `Consult consultant when you are stuck on a decision or diagnosis before implementation.`

**Independent Test:** Add `tests/orchestrator-routing.test.ts` with explicit
assertions for R39-R46 against the three orchestrator manifests, their
generated agent files, and the general manifest and generated agent file; run
`npx vitest run tests/orchestrator-routing.test.ts`.

### P1: Surface both roles in setup, doctor, web setup, and CLI guidance

**User Story:** As a CodeDeck user, I want to bind and inspect both roles
through setup, doctor, web setup, and CLI guidance so that I can choose their
harness and model and see when either role is unbound.

**Why P1:** Users need to configure the model binding that determines each
role's cost and reasoning effort.

**Acceptance Criteria:**

1. **R47:** WHEN the CLI setup wizard builds role screens THEN it SHALL include both `scout` and `consultant`.
2. **R48:** WHEN `setup --bind` receives `scout=<harness>:<model>` or `consultant=<harness>:<model>` THEN `parseBind` SHALL return a binding for the named role.
3. **R49:** IF `setup --bind` receives an unknown role THEN its error message SHALL list `general|orchestrator|reviewer|auditor|scout|consultant` as the accepted roles.
4. **R50:** WHEN the web setup page renders its role roster THEN it SHALL render the `role-row-scout` row.
5. **R51:** WHEN the web setup page renders the scout row THEN its `r-desc` element SHALL render the exact text `Scout researches code and external docs, then cites the sources it opened.`
6. **R52:** WHEN the web setup page renders the scout row THEN it SHALL render the `binding-scout` control.
7. **R53:** WHEN the web setup page renders the scout row THEN it SHALL render the `effort-scout` control.
8. **R54:** WHEN the web setup page renders its role roster THEN it SHALL render the `role-row-consultant` row.
9. **R55:** WHEN the web setup page renders the consultant row THEN its `r-desc` element SHALL render the exact text `Consultant recommends an approach or diagnosis before implementation.`
10. **R56:** WHEN the web setup page renders the consultant row THEN it SHALL render the `binding-consultant` control.
11. **R57:** WHEN the web setup page renders the consultant row THEN it SHALL render the `effort-consultant` control.
12. **R58:** WHEN web setup validates a binding payload THEN it SHALL accept `scout` and `consultant` as role keys in `agents` and per-role confirmation data.
13. **R59:** WHEN doctor renders the roles section THEN it SHALL include a row for `scout` and a row for `consultant`.
14. **R60:** WHEN either role is unbound in doctor output THEN its row SHALL print `unbound, runs on <harness>`, where `<harness>` is `config.defaultAgent` or `claude` when no default is set.
15. **R61:** WHEN `CODEDECK_CLI_NAME` is `codedeck-dev` THEN `spinnerTips()` SHALL contain the exact entries `codedeck-dev open scout answers codebase and documentation questions with citations.` and `codedeck-dev run --role consultant gives a decision or diagnosis before implementation.`

**Independent Test:** `tests/setup-wizard.test.ts`,
`tests/setup-cli-contract.test.ts`, `tests/setup-page.test.ts`,
`tests/setup-web.test.ts`, `tests/setup-plan.test.ts`,
`tests/picker-session.test.ts`, `tests/doctor-roles.test.ts`, and
`tests/open-args.test.ts`; run
`npx vitest run tests/setup-wizard.test.ts tests/setup-cli-contract.test.ts tests/setup-page.test.ts tests/setup-web.test.ts tests/setup-plan.test.ts tests/picker-session.test.ts tests/doctor-roles.test.ts tests/open-args.test.ts`.

### P1: Document the new role choices

**User Story:** As a CodeDeck user or agent, I want current role guidance to
explain `scout` and `consultant` so that I can choose and dispatch the right
role.

**Why P1:** The README and agent skill are the main role references used by
people and agents.

**Acceptance Criteria:**

1. **R62:** The current role table in `README.md` SHALL contain the exact row ``| `scout` | no `Edit`/`Write` | no | codebase facts and external-document research with citations |``.
2. **R63:** The current role table in `README.md` SHALL contain the exact row ``| `consultant` | no `Edit`/`Write` | no | pre-implementation decisions and diagnosis |``.
3. **R64:** The current role table in `README.md` SHALL have exactly six rows for `general`, `orchestrator`, `auditor`, `reviewer`, `scout`, and `consultant`.
4. **R65:** The role overview in `README.md` SHALL replace the prior phrase `Four roles.` with the exact sentence `Six roles ship: reviewer, auditor, scout, and consultant have no Claude Edit or Write tools; the orchestrator role has read and edit agent files.`
5. **R66:** The role overview in `README.md` SHALL replace the phrase `the three that lose` with the phrase `the read-only roles`.
6. **R67:** The setup description in `README.md` SHALL refer to `each of the six roles` when describing harness and model bindings.
7. **R68:** `docs/harness-behaviour.md` SHALL contain the exact standalone sentence ``Scout and consultant use `Bash` with `rg` for repository searches.``
8. **R69:** `skills/use-codedeck/SKILL.md` and `~/.claude/skills/use-codedeck/SKILL.md` SHALL both contain the exact rows ``| `scout` | no | no | codebase facts and external-document research with citations |`` and ``| `consultant` | no | no | pre-implementation decisions and diagnosis |``.
9. **R70:** `skills/handoff/SKILL.md` SHALL contain the exact suggested-role list ``(`general`, `orchestrator`, `auditor`, `reviewer`, `scout`, `consultant`)``.

**Independent Test:** Check the exact new README rows, role roster, README
counts, harness note, and both skill copies with the following scoped commands.

```bash
grep -Fxn '| `scout` | no `Edit`/`Write` | no | codebase facts and external-document research with citations |' README.md
grep -Fxn '| `consultant` | no `Edit`/`Write` | no | pre-implementation decisions and diagnosis |' README.md
python3 - <<'PY'
from pathlib import Path
import re
lines = Path("README.md").read_text().splitlines()
start = lines.index("| Role | Can write? | Can dispatch? | For |")
rows = []
for line in lines[start + 2:]:
    if not line.startswith("|"):
        break
    rows.append(re.match(r"\| `([^`]+)` \|", line).group(1))
assert len(rows) == 6 and set(rows) == {"general", "orchestrator", "auditor", "reviewer", "scout", "consultant"}
PY
grep -F 'Six roles ship: reviewer, auditor, scout, and consultant have no Claude Edit or Write tools; the orchestrator role has read and edit agent files.' README.md && grep -F 'the read-only roles' README.md && grep -F 'each of the six roles' README.md
! grep -F 'Four roles.' README.md && ! grep -F 'the three that lose' README.md && ! grep -F 'each of the four agents' README.md
grep -Fxn 'Scout and consultant use `Bash` with `rg` for repository searches.' docs/harness-behaviour.md
grep -Fn '| `scout` | no | no | codebase facts and external-document research with citations |' skills/use-codedeck/SKILL.md "$HOME/.claude/skills/use-codedeck/SKILL.md"
grep -Fn '| `consultant` | no | no | pre-implementation decisions and diagnosis |' skills/use-codedeck/SKILL.md "$HOME/.claude/skills/use-codedeck/SKILL.md"
grep -Fn '(`general`, `orchestrator`, `auditor`, `reviewer`, `scout`, `consultant`)' skills/handoff/SKILL.md
```

## Repository surfaces found by grep

These files enumerate roles, branch on a CodeDeck role, bind roles, generate
role agents, or give current role guidance. They are implementation surfaces
for later slices; this Specify slice changes only this spec.

| Surface | Role use |
| --- | --- |
| `src/core/roles.ts` | Base role list, parser, prefixes, and prompt file resolution. |
| `src/config/config.ts`, `src/config/setup.ts` | Role binding type, resolution, and setup configuration plan. |
| `src/cli/commands/run.ts`, `src/cli/commands/open.ts`, `src/daemon/daemon.ts` | Role parsing, run dispatch, open selection, and session role parsing. |
| `src/cli/commands/setup.ts` | CLI setup wizard screens, `setup --bind` parsing, and invalid-role help text. |
| `src/cli/commands/doctor.ts` | Role rows and unbound fallback display. |
| `src/core/session.ts`, `src/store/database.ts`, `src/store/sessions.ts` | Session role identity and its existing nullable `TEXT` storage column. |
| `src/open/contract.ts`, `src/open/launchers/claude.ts` | Role contract selection and Claude agent selection. |
| `src/open/launchers/codex.ts` | `roleSandbox` mapping and Codex open arguments. |
| `src/open/launchers/opencode.ts` | Per-role OpenCode permission map. |
| `src/open/runtime.ts` | Spinner tips that describe role-specific CLI use. |
| `src/web/setup-page.ts` | `SETUP_ROLE_ORDER` near line 167, `ROLE_COPY` near line 172, rendered binding and effort controls. |
| `src/web/setup-routes.ts` | Role-key validation and binding request handling. |
| `scripts/copy-plugin.mjs` | Prompt manifest composition and generated plugin agent files. |
| `plugin/prompts/roles/*.md`, `plugin/prompts/_partials/*.md` | Role contracts and shared role routing text. |
| `plugin/agents/*.md` | Generated agent output checked against prompt manifests. |
| `tests/__snapshots__/orchestrator-agents.test.ts.snap` | Generated orchestrator-agent prompt snapshots. |
| `skills/use-codedeck/SKILL.md`, `~/.claude/skills/use-codedeck/SKILL.md` | Role selection guidance; both copies need the new text. |
| `skills/handoff/SKILL.md` | Suggested role list for follow-up work. |
| `README.md`, `docs/harness-behaviour.md` | Current product and harness documentation describing CodeDeck roles. |
| `docs/superpowers/plans/open-adopt-release.md`, `docs/superpowers/specs/open-adopt-release.md` | Historical plans mentioning role fields and examples; preserve their historical record. |

The naming check also read `src/config/orchestrator-mode.ts`. Its `explorer`
label belongs to `OrchestratorModeLabel` and `EXPLORER_PRESET`, not to `ROLES`.

The source and documentation path inventory used
`grep -rnE '\b(general|orchestrator|reviewer|auditor|--role|ROLES|RoleBinding|explorer)\b' src scripts plugin/prompts skills docs README.md --exclude-dir=node_modules | cut -d: -f1 | sort -u`
and
`grep -rnE '\b(general|orchestrator|reviewer|auditor|role|roles|--role)\b' README.md docs --include='*.md' | cut -d: -f1 | sort -u`.
The searches included role registration, prefix parsing, permission maps,
generated prompt text, setup rows, and current documentation. They did not
use `head`.

The broad docs search also returned `docs/mods.md` because it mentions the
historical feature path `.specs/features/orchestrator-agents-band`. Opening
that file showed no CodeDeck role reference, so it is not an implementation
surface.

## Tests found by grep

The following focused tests pin role lists, generated prompt text, per-harness
permissions, role routing, or setup and doctor role output:

- `tests/roles.test.ts`
- `tests/config-models.test.ts`
- `tests/config-sandbox.test.ts`
- `tests/create-report.test.ts`
- `tests/run-role.test.ts`
- `tests/run-sandbox.test.ts`
- `tests/open-args.test.ts`
- `tests/open-action.test.ts`
- `tests/open-contract.test.ts`
- `tests/open-sandbox.test.ts`
- `tests/open-worktree-prompt.test.ts`
- `tests/open-codex.test.ts`
- `tests/open-opencode.test.ts`
- `tests/plugin-manifest.test.ts`
- `tests/prompt-layers.test.ts`
- `tests/orchestrator-prose.test.ts`
- `tests/orchestrator-agents.test.ts`
- `tests/__snapshots__/orchestrator-agents.test.ts.snap`
- `tests/doctor-roles.test.ts`
- `tests/setup-cli-contract.test.ts`
- `tests/setup-plan.test.ts`
- `tests/setup-page.test.ts`
- `tests/setup-web.test.ts`
- `tests/setup-wizard.test.ts`
- `tests/picker-session.test.ts`
- `tests/orchestrator-mode.test.ts`
- `tests/tlc-spec-driven.test.ts`

The focused test-path search was
`grep -rnE 'ROLES|parseRole|resolveRoleBinding|roleSandbox|rolePermission|launcherFor|SETUP_ROLE_ORDER|role-row-|parseBind|Invalid --bind|orchestrator-read|orchestrator-edit|orchestrator|codedeck run --role|toMatchSnapshot|reviewer|auditor' tests --include='*.test.ts' --include='*.snap' | cut -d: -f1 | sort -u`.
Because this grep also returns incidental words such as `orchestrator` in
unrelated tests, the list above includes the opened matches that pin a role
roster, role-specific launch or binding behavior, setup or doctor output, or
generated role prompt text. A targeted follow-up for sandbox and worktree
launch behavior was
`grep -rnE 'reviewer|roleSandbox|launcherFor|agents:' tests/config-sandbox.test.ts tests/open-worktree-prompt.test.ts tests/open-sandbox.test.ts`.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| R-01 | Register and parse both roles | Specify | Specified |
| R-02 | Register and parse both roles | Specify | Specified |
| R-03 | Register and parse both roles | Specify | Specified |
| R-04 | Register and parse both roles | Specify | Specified |
| R-05 | Register and parse both roles | Specify | Specified |
| R-06 | Register and parse both roles | Specify | Specified |
| R-07 | Register and parse both roles | Specify | Specified |
| R-08 | Register and parse both roles | Specify | Specified |
| R-09 | Register and parse both roles | Specify | Specified |
| R-10 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-11 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-12 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-13 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-14 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-15 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-16 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-17 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-18 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-19 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-20 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-21 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-22 | Apply the existing read-only enforcement per harness | Specify | Specified |
| R-23 | Answer factual questions as scout | Specify | Specified |
| R-24 | Answer factual questions as scout | Specify | Specified |
| R-25 | Answer factual questions as scout | Specify | Specified |
| R-26 | Answer factual questions as scout | Specify | Specified |
| R-27 | Answer factual questions as scout | Specify | Specified |
| R-28 | Answer factual questions as scout | Specify | Specified |
| R-29 | Answer factual questions as scout | Specify | Specified |
| R-30 | Give pre-implementation advice as consultant | Specify | Specified |
| R-31 | Give pre-implementation advice as consultant | Specify | Specified |
| R-32 | Give pre-implementation advice as consultant | Specify | Specified |
| R-33 | Give pre-implementation advice as consultant | Specify | Specified |
| R-34 | Give pre-implementation advice as consultant | Specify | Specified |
| R-35 | Give pre-implementation advice as consultant | Specify | Specified |
| R-36 | Give pre-implementation advice as consultant | Specify | Specified |
| R-37 | Give pre-implementation advice as consultant | Specify | Specified |
| R-38 | Give pre-implementation advice as consultant | Specify | Specified |
| R-39 | Route discovery and advice to the new roles | Specify | Specified |
| R-40 | Route discovery and advice to the new roles | Specify | Specified |
| R-41 | Route discovery and advice to the new roles | Specify | Specified |
| R-42 | Route discovery and advice to the new roles | Specify | Specified |
| R-43 | Route discovery and advice to the new roles | Specify | Specified |
| R-44 | Route discovery and advice to the new roles | Specify | Specified |
| R-45 | Route discovery and advice to the new roles | Specify | Specified |
| R-46 | Route discovery and advice to the new roles | Specify | Specified |
| R-47 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-48 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-49 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-50 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-51 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-52 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-53 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-54 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-55 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-56 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-57 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-58 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-59 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-60 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-61 | Surface both roles in setup, doctor, web setup, and CLI guidance | Specify | Specified |
| R-62 | Document the new role choices | Specify | Specified |
| R-63 | Document the new role choices | Specify | Specified |
| R-64 | Document the new role choices | Specify | Specified |
| R-65 | Document the new role choices | Specify | Specified |
| R-66 | Document the new role choices | Specify | Specified |
| R-67 | Document the new role choices | Specify | Specified |
| R-68 | Document the new role choices | Specify | Specified |
| R-69 | Document the new role choices | Specify | Specified |
| R-70 | Document the new role choices | Specify | Specified |
