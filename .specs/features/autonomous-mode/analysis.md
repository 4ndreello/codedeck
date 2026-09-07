# Autonomous mode feasibility analysis

## Context and goal

The goal is a 100% autonomous, unattended orchestrator mode. A user starts a run and walks away, potentially for hours or overnight. The orchestrator should:

- try to complete the work with zero human input;
- never stop to ask a human question;
- record a decision when work is fully blocked and route around it by doing unblocked work;
- finish with a REPORT that records assumptions, deferred decisions, and unfinished work.

This document assesses feasibility. It does not lock the behavior or the implementation.

## Effect of PR #38

PR #38, branch `feat/orchestrator-presets`, provides the right place to add mode-specific behavior, but it does not make autonomy a new preset.

`src/config/orchestrator-mode.ts:3-12` defines three capability and effort axes, plus optional parallelism:

| Axis | Values |
| --- | --- |
| `investigate` | `none`, `read`, `free` |
| `selfWork` | `none`, `trivial`, `small` |
| `tools` | `dispatch`, `read`, `edit` |
| `parallelism` | Optional positive integer |

The built-in presets in `src/config/orchestrator-mode.ts:16-38` are `dispatcher` (`none/none/dispatch`), `balanced` (`read/trivial/edit`), and `explorer` (`free/small/edit`). A `custom` label is derived from parameters. Configuration stores parameters, not a preset name, as described in `spec.md:20-35`. Invalid or missing configuration resolves to `DISPATCHER_PRESET` in `src/config/orchestrator-mode.ts:48-93`.

The agent Markdown is keyed by tool tier, not by preset. PR #38 uses `plugin/agents/orchestrator.md`, `orchestrator-read.md`, and `orchestrator-edit.md`, with shared behavior in `plugin/ultra.md`. Mode-specific text is composed at runtime by `src/open/orchestrator-prose.ts:3-15`. The `codedeck open` launchers inject it through `claude.ts:94-136` and `opencode.ts:60-77`. For `codedeck run`, `src/core/roles.ts:41-93` reads the role body for each spawn and prepends it to the prompt. The daemon does not reread role Markdown.

The setup wizard in `src/cli/commands/setup.ts:126-170` offers fixed `dispatcher`, `balanced`, and `explorer` choices, a custom path, and parameter screens. `orchestratorConfigFromSelection` at `src/cli/commands/setup.ts:72-93` persists parameters rather than a preset name.

The existing axes describe effort and capability. `explorer` already represents the maximum combination. Autonomy is a separate concern, so it should be a new axis or a separate configuration field, not another preset row.

## Current state

### What already helps

- Run-mode harnesses already bypass most permission prompts. The Claude driver adds `--dangerously-skip-permissions` in `src/drivers/claude/driver.ts:12-23`. Codex runs use `--dangerously-bypass-approvals-and-sandbox` in `src/cli/commands/run.ts:28-35`.
- The session model already names `needs_input` in `src/core/session.ts:11-20`, and treats it as active at `src/core/session.ts:79-85`. Terminal states include `completed`, `failed`, `stopped`, `orphaned`, and `interrupted`.
- Existing routing commands provide useful control: `run`, `ps`, `show`, `logs`, `wait`, `send`, `stop`, and `diff`. Multiple background runs provide basic parallel dispatch. Claims add/list/release provide path ownership coordination.
- Worker role files already use a final assistant response as a report convention. `plugin/agents/reviewer.md:11-35` is an example.
- `TIMEOUT` already exists as a failure code in `src/core/errors.ts:81-87`, which leaves a named place for future deadline handling.

Workers therefore rarely hard-block on a permission prompt. The main blocking risk is an agent choosing to ask the human.

### What is missing

- No code produces `needs_input`. No driver parser or daemon branch emits it. Permission events exist in `src/core/events.ts:4-18`, but the daemon does not act on them in `src/daemon/daemon.ts:926-949`.
- `codedeck wait` has no deadline. It waits indefinitely for a non-terminal status in `src/cli/wait.ts:20-66`. `tests/wait.test.ts:58-101` confirms that `idle` and `needs_input` do not resolve the wait.
- The current reply path cannot answer a live blocked worker. `session.send` rejects a live or draining runtime with `SESSION_BUSY` in `src/daemon/daemon.ts:394-401`. `SessionDriver.send` starts a new resumed process in `src/daemon/session-driver.ts:121-139`, while the original harness ignores stdin in `src/drivers/helpers.ts:49-56`.
- No inactivity or question timeout emits `TIMEOUT`.
- Sessions persist status, usage, and failure data in `src/core/session.ts:29-65`, but no structured final report exists. `session.completed` contains only reason and exit code in `src/core/events.ts:108-118`. `wait --json` returns the session object, not a report.
- The existing routing primitives have no dependency, answer, defer, or report method in `src/daemon/protocol.ts:8-25`. `runId` groups usage only. Claims coordinate path ownership, not task dependencies.

The infrastructure gaps for true unattended execution are:

1. Blocker detection and `needs_input` production from each driver parser into `daemon.updateSessionFromEvent`.
2. A `session.answer` path that injects an answer into the live process.
3. An auto-answer or auto-defer policy on `run`, `RunOptions`, or configuration.
4. An inactivity or question deadline that uses `TIMEOUT` so a stuck worker cannot hang forever.
5. A deferred-questions store, either a table or per-run JSON under the paths in `src/config/paths.ts:24-38`.
6. Run-level scheduling and a dependency graph.
7. A synthesized end-of-run report finalizer, IPC method, and CLI command.

## Feasibility verdict

### Layer 1, prompt-level behavior

This layer is cheap and high value. Add an unattended behavior contract through `src/open/orchestrator-prose.ts:3-15`, or add a dedicated orchestrator agent variant in the plugin Markdown. The contract should instruct the orchestrator to:

- never ask or wait for a human;
- make reasonable assumptions and record each one;
- record a blocker and the deferred decision when a worker is fully blocked;
- stop a blocked worker when needed and dispatch work that is not blocked;
- keep a running notes log;
- write a final Markdown report and a deferred-decisions log at a known path.

The report and notes path would be a lightweight convention. The location remains an open decision. This layer needs little or no daemon change because run-mode harnesses already bypass permissions and the orchestrator controls dispatch. It does not provide process-level enforcement. A prompt cannot guarantee that an agent will never ask a question, and it cannot make `wait` or a worker process time out.

### Layer 2, infrastructure behavior

Layer 2 addresses the seven gaps above. The current system genuinely lacks both live-answer support and a producer for `needs_input`; neither can be enabled by changing prose alone. A complete infrastructure design would also need policy storage, deadlines, deferred-question persistence, scheduling, and a report finalizer with a structured artifact.

## Recommended scope

### MVP

Use Layer 1 with the report and notes convention. The orchestrator gets an explicit unattended behavior contract through the existing prose composer or a dedicated agent Markdown variant. It writes:

- a running notes log containing assumptions and blocker decisions;
- a final REPORT containing assumptions, deferred decisions, and unfinished work.

The report location should be selected before implementation. The MVP can avoid a general daemon change, but its unattended guarantee is behavioral rather than enforced.

### Phase 2

Select Layer 2 pieces after the MVP exposes real failure modes. Prioritize deadlines first, so one stuck worker cannot hold the run forever. Add a structured report artifact next, so report data is available through the daemon and CLI rather than only in worker prose. Blocker detection, live answering, auto policy, deferred-question storage, and scheduling can follow according to the chosen run model.

## Options for the orthogonal autonomy axis

No option is selected here.

### Option A, add `unattended` to `OrchestratorMode`

Add `unattended: off | notes | full` to the mode object.

Files touched:

- `src/config/orchestrator-mode.ts`, for the field, validation, defaults, resolution, and custom-mode labeling.
- `src/config/config.ts`, for persistence of the additional mode parameter.
- `src/cli/commands/setup.ts`, for the selection and `orchestratorConfigFromSelection` persistence path.
- `src/open/orchestrator-prose.ts`, for composing the selected unattended contract.
- `plugin/agents/orchestrator.md`, `orchestrator-read.md`, and `orchestrator-edit.md`, for the tier-specific contract text where required.

Pros:

- Capability, effort, and autonomy resolve in one mode object.
- The existing setup and runtime resolution paths remain the main entry points.
- `off`, `notes`, and `full` make a future distinction between prompt-level notes and stronger infrastructure behavior possible.

Cons:

- It mixes an autonomy concern into a type whose other fields describe capability and effort.
- Preset and custom-mode labeling becomes more complex.
- `full` may imply guarantees that the MVP cannot enforce.

### Option B, use a separate top-level configuration field

Keep `OrchestratorMode` focused on investigation, self-work, tools, and parallelism. Add a separate unattended setting at the top level.

Files touched:

- `src/config/config.ts`, for the top-level setting and its default.
- `src/cli/commands/setup.ts`, if setup exposes the setting.
- `src/open/orchestrator-prose.ts`, for combining the resolved mode with the unattended setting.
- `plugin/agents/orchestrator.md`, `orchestrator-read.md`, and `orchestrator-edit.md`, for the contract text where required.

`src/config/orchestrator-mode.ts` would remain unchanged. It would only be touched if the resolver is made responsible for returning both values.

Pros:

- The existing mode axes retain one meaning.
- Autonomy can evolve independently of the preset system.
- The configuration makes the orthogonal relationship explicit.

Cons:

- Runtime code must resolve two related configuration values.
- Setup presents two separate concepts and more combinations.
- Future run-level policy may need a separate path through `RunOptions` as well.

## Open decisions

- What counts as blocked operationally? A worker question, a known permission event, no progress, a failed process, or a combination?
- How aggressive may autonomous assumptions be, and which decisions must always be deferred?
- Are Phase 2 deadlines in scope for the first autonomous release?
- Where should the Markdown report, notes log, and deferred-decisions log live?
- Should autonomous mode be selectable in setup, or enabled only through configuration or the prompt contract?

## Risks

- The orchestrator may make a wrong assumption with no human check and produce a plausible but incorrect result.
- Without a deadline, a worker can hang indefinitely and prevent the run from reaching its report step.
- Report quality depends on prose compliance until a structured report artifact exists.
- Prompt-level instructions cannot guarantee that every worker follows the no-question rule.
- Permission bypass reduces one source of blocking, but it also lets an unattended worker make changes without an interactive approval step.
