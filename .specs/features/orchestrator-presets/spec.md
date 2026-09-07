# Configurable orchestrator presets

## Goal

Add one global `orchestrator` configuration block that controls how the CodeDeck orchestrator investigates, does small amounts of work, and accesses native tools when launched through `codedeck open`. The dispatcher preset remains the default and must be output-equivalent to today's behavior for existing users.

The configuration has four independent parameters. `tools` selects a native tool tier. `investigate` and `selfWork` become runtime prose. `parallelism` is an advisory prompt instruction in version 1, not a code-enforced limit.

## Configuration contract

### Parameters

| Parameter | Values | Meaning |
| --- | --- | --- |
| `investigate` | `none`, `read`, `free` | How much the orchestrator may inspect before delegating. `none` means it delegates without inspection, `read` permits read-only inspection, and `free` permits unrestricted investigation. |
| `selfWork` | `none`, `trivial`, `small` | How much work the orchestrator may perform itself without dispatching. |
| `tools` | `dispatch`, `read`, `edit` | The native tool tier available to the orchestrator. The launched harness enforces this tier on the `codedeck open` path. |
| `parallelism` | Optional positive number | An advisory concurrent-worker cap. Version 1 puts the cap in the orchestrator prompt for review verification. Code does not enforce it. Real enforcement is a follow-up. |

The nested `orchestrator` block belongs on `RunAgentConfig` in `src/config/config.ts`. The global file remains `~/.config/run-agent/config.json`, subject to `getConfigDir` and the `configFile` path assembled in `src/config/paths.ts`. `loadConfig` and `saveConfig` in `src/config/config.ts` remain the persistence seam.

The block stores parameters only:

```json
{
  "orchestrator": {
    "investigate": "read",
    "selfWork": "trivial",
    "tools": "edit",
    "parallelism": 3
  }
}
```

It must not store a preset name, a label, or a `custom` entity. Resolve an absent block in memory to the dispatcher parameters. The resolved `OrchestratorMode` is the parameter bundle, with an optional `parallelism` value. Its display label is derived from the resolved values.

### Presets and labels

| Preset label | `investigate` | `selfWork` | `tools` | `parallelism` |
| --- | --- | --- | --- | --- |
| `dispatcher` | `none` | `none` | `dispatch` | absent |
| `balanced` | `read` | `trivial` | `edit` | absent |
| `explorer` | `free` | `small` | `edit` | absent |

`dispatcher` is the default and equals today's behavior. A resolver returns `dispatcher`, `balanced`, or `explorer` only when every parameter matches the corresponding fixed bundle, including absent `parallelism`. Every other valid combination returns the derived label `custom`. The label is never persisted.

The setup description must call `parallelism` advisory in the same terms as this contract. A value such as `3` means the orchestrator should be told to run at most three workers concurrently, but version 1 does not stop a fourth worker from starting. Review verifies that the instruction is present. Real enforcement is a follow-up.

## Tier files and runtime composition

Claude agent files are keyed by the `tools` tier, not by preset. Exactly three orchestrator files exist:

| Tools tier | Claude file | Frontmatter tools |
| --- | --- | --- |
| `dispatch` | `plugin/agents/orchestrator.md` | `Bash` |
| `read` | `plugin/agents/orchestrator-read.md` | `Read`, `Grep`, `Glob`, `Bash` |
| `edit` | `plugin/agents/orchestrator-edit.md` | `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash` |

`plugin/agents/orchestrator.md` is unchanged, including `tools: Bash`, its frontmatter, and its dispatcher body. The two new files carry only their tier's allowlist and a tier-neutral orchestrator body. The body must not contain preset-specific `investigate`, `selfWork`, or `parallelism` instructions. There is no per-preset agent file and no `plugin/agents/orchestrator-custom.md`.

The `investigate` and `selfWork` values are composed at runtime into a short prose block from the resolved values. They are not baked into any agent file. The block is appended to the orchestrator prompt at these seams:

- Claude uses the append-system-prompt seam in `buildOpenArgs` in `src/open/launchers/claude.ts`.
- OpenCode appends to `agentBody` at the `prompt: agentBody` seam in `buildInlineConfig` in `src/open/launchers/opencode.ts`.

The prose should state the resolved investigation and self-work allowances plainly. The investigate/selfWork block is empty when both values are `none`. For the default dispatcher, `parallelism` is also absent, so no prose is appended at all. If a custom mode sets `parallelism` while both values remain `none`, append only its advisory cap instruction, such as `run at most N workers concurrently`.

The selection rule is fixed:

1. `tools` selects the Claude agent file and the OpenCode permission map.
2. `investigate` and `selfWork` compose the appended prose.
3. `parallelism`, when present, adds its advisory cap instruction.

This composition must express every preset and every valid custom combination without adding a new file or entity for each combination.

## Native tool policy

The `tools` tier selects the following Claude file and OpenCode permission map on the `codedeck open` path.

| Tools tier | Claude file | OpenCode permission map |
| --- | --- | --- |
| `dispatch` | `plugin/agents/orchestrator.md` | `read: deny`, `edit: deny`, `write: deny`, `task: deny`, `bash: allow` |
| `read` | `plugin/agents/orchestrator-read.md` | `read: allow`, `edit: deny`, `write: deny`, `task: deny`, `bash: allow` |
| `edit` | `plugin/agents/orchestrator-edit.md` | `read: allow`, `edit: allow`, `write: allow`, `task: deny`, `bash: allow` |

The orchestrator OpenCode map must set all five relevant permissions explicitly. It must not use `*` or rely on unspecified-permission defaults. The tier lookup belongs in `rolePermission` in `src/open/launchers/opencode.ts`; other roles keep their existing contracts.

## Wiring shape

After `loadConfig` returns in `src/cli/commands/open.ts`, resolve one `OrchestratorMode` value and pass it as a new argument into the launcher builders. The mode is separate from the role. Keep the `Role` union at its four existing values: `general`, `orchestrator`, `reviewer`, and `auditor`.

The functions that gain the mode parameter are:

- `buildOpenArgs` in `src/open/launchers/claude.ts`, which maps the orchestrator's `tools` tier to the `--agent` selection and appends the composed prose at the append-system-prompt seam. Non-orchestrator roles retain their current agent selection.
- `buildInlineConfig` in `src/open/launchers/opencode.ts`, which composes the orchestrator prompt and passes the mode to `rolePermission`.
- `rolePermission` in `src/open/launchers/opencode.ts`, which selects the explicit map from `mode.tools` for the orchestrator.

The Claude `--agent` selection must resolve the orchestrator to `codedeck:orchestrator`, `codedeck:orchestrator-read`, or `codedeck:orchestrator-edit` according to the tier. The dispatcher selection remains `codedeck:orchestrator`, with the unchanged file, frontmatter, and body.

## Setup behavior

Extend the existing setup flow with an orchestrator screen appended after the role screens in the wizard driver, with its parameter screens chained via `Screen.next` in `src/cli/commands/setup.ts`. The screen exposes the three fixed presets and the individual parameters, derives the `custom` label for any non-matching bundle, and saves only the `orchestrator` parameters through the existing `loadConfig` and `saveConfig` flow.

The screen must describe `parallelism` as advisory. It must say that version 1 places the requested cap in the orchestrator prompt for review verification and does not enforce the cap in code. Saving a fixed preset writes its parameter values without a preset-name or label field. Changing any parameter displays `custom`.

## Acceptance criteria

1. An existing config with no `orchestrator` block resolves to the dispatcher and behaves exactly as today on `codedeck open`, including no appended prose. Dispatcher output is equivalent in the following concrete ways: the same Claude agent selection, the same `tools: Bash` frontmatter, the same dispatcher body, no appended prose, and the same OpenCode permission map as today.

2. `tools=dispatch` selects `plugin/agents/orchestrator.md` unchanged, `tools=read` selects `plugin/agents/orchestrator-read.md`, and `tools=edit` selects `plugin/agents/orchestrator-edit.md`. Each file contains only the frontmatter allowlist for its tier and a tier-neutral orchestrator body.

3. The appended prose reflects the resolved `investigate` and `selfWork` values. The investigate/selfWork prose is empty when both values are `none`. A configured `parallelism` value adds an advisory cap instruction without changing the selected tier file or permission map.

4. The OpenCode permission map matches the selected tier exactly, with all five relevant keys explicit: `read`, `edit`, `write`, `task`, and `bash`. The three maps are dispatch `deny, deny, deny, deny, allow`, read `allow, deny, deny, deny, allow`, and edit `allow, allow, allow, deny, allow`, in that key order.

5. Label computation returns `dispatcher`, `balanced`, or `explorer` only on a full parameter match, including absent `parallelism`. Every other valid combination returns `custom`, and no label or preset name is written to config.

6. A config containing an explicit orchestrator block round-trips through `loadConfig` and `saveConfig` without losing any parameter, optional `parallelism`, or unrelated configuration. A block without `parallelism` remains without that property. The setup screen exposes the same parameters and surfaces the advisory parallelism note.

7. `parallelism` appears in the orchestrator prompt as an advisory cap instruction when configured. Review verifies the instruction and its wording. Version 1 does not enforce the cap in code. Real enforcement is a follow-up.

## Testing

Require unit tests for the `tools` tier to Claude frontmatter and OpenCode permission mapping, plus unit tests for label computation.

Add snapshot tests that pin the frontmatter and body of each tier file: `orchestrator.md`, `orchestrator-read.md`, and `orchestrator-edit.md`. The dispatcher snapshot must protect its unchanged body and `tools: Bash` frontmatter.

The exact investigate, selfWork, and parallelism prose is review-verified at the launch seams. It is not a unit-tested text contract.

## Execution plan

Implement the slices in this dependency order:

| Slice | Scope | Dependencies |
| --- | --- | --- |
| S1 | Add the nested config type, resolved `OrchestratorMode`, dispatcher fallback, fixed preset constants, parameter validation, and derived label computation. Cover `loadConfig` and `saveConfig` round trips. The relevant symbols are `RunAgentConfig`, `loadConfig`, and `saveConfig` in `src/config/config.ts`, plus `getConfigDir` and `configFile` in `src/config/paths.ts`. | None |
| S2 | Add `orchestrator-read.md` and `orchestrator-edit.md` tier files, with dispatch staying in `orchestrator.md`, plus the composed-prose block. Keep all three bodies tier-neutral and keep dispatcher output unchanged. | S1; may run in parallel with S4 |
| S3 | Resolve the mode in `open.ts`, select the Claude agent file by `tools` tier, compose and append the `investigate` and `selfWork` prose, inject the advisory `parallelism` instruction, and parameterize OpenCode `rolePermission` by tier. Wire the new mode argument through `buildOpenArgs` and `buildInlineConfig`. | S1 and S2 |
| S4 | Add the orchestrator screen to `buildScreens` in `src/cli/commands/setup.ts`, persist the block through the existing setup flow, display the computed preset or `custom` label, and surface the advisory parallelism note. | S1; may run in parallel with S2 |

S3 waits for the configuration contract from S1 and the tier files from S2. S2 and S4 can proceed independently after S1.

## Out of scope

1. The SITE / web UI is phase 2. Version 1 is CLI-only through `codedeck setup` plus hand-editing `config.json`. A future SITE implementation reuses the same `loadConfig` and `saveConfig` seam.

2. Native tool scoping on the `run --role orchestrator` path is out of scope. Version 1 scopes only the `codedeck open` path. The run scoping gap is recorded IN CODE with a short comment at the run seam in the `src/cli/commands/run.ts` prompt-prefix block and the `src/core/roles.ts` frontmatter-stripping function (`roleBody`). No GitHub issue is used. The design options remain recorded here:

   (a) Add driver/session tool scoping so `run` honors the mode.

   (b) Disallow `run --role orchestrator` and keep the orchestrator open-only.

   (c) Leave the behavior prose-only and document it.

   The version 1 decision is to scope only the open path. The code comment records that boundary and does not add enforcement to `run`.

3. Per-project configuration is out of scope. The orchestrator block remains global at `~/.config/run-agent/config.json`.

4. Real code enforcement of `parallelism` is a follow-up. Version 1 only injects the advisory instruction and verifies it in review.
