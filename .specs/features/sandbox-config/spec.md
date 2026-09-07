# Global default sandbox config

## Goal

Add one global `defaultSandbox` setting so a user can choose the Codex sandbox once instead of repeating `--sandbox danger-full-access` on every dispatch.

Today the Codex harness falls back to `workspace-write`. That mode blocks network access and the desktop keyring, so workers cannot reach tools such as `gh` or CI unless each dispatch opts into `danger-full-access`. The new setting changes that default only when the user chooses it. Existing users and configs with no setting keep the current safe behavior.

## Locked decisions

### D1: Optional global field

Add `defaultSandbox?: CodexSandbox` to `RunAgentConfig` in `src/config/config.ts`.

When the field is absent, the effective Codex sandbox remains `workspace-write`, exactly as it does today. Only a configured value changes the default. The field is global, not per role, project, or session.

### D2: Codex only

Only the Codex driver honors this setting. Claude, opencode, and omp ignore it. Around `run.ts:126-132`, the existing code strips sandbox options for non-Codex agents and warns, so the config-derived value must follow the same rule. The setting is meaningful only for Codex workers.

### D3: One setup toggle

The setup screen exposes one `Danger full access` toggle:

| Toggle | Saved `defaultSandbox` |
| --- | --- |
| OFF | `workspace-write` |
| ON | `danger-full-access` |

The config field stores the complete `CodexSandbox` enum, so a user may hand-edit `config.json` to `read-only`. The setup UI must not expose `read-only` as a choice.

This setting selects the Codex sandbox mode. It does not imply `--dangerously-bypass-approvals-and-sandbox` or change the separate approval-bypass flag.

## Configuration contract

`RunAgentConfig` in `src/config/config.ts` gains a top-level field beside the other global settings:

```ts
import type { CodexSandbox } from "../core/driver.js";

export interface RunAgentConfig {
  defaultAgent?: AgentId;
  worktree?: boolean;
  defaultModel?: string;
  remoteControl?: boolean;
  defaultSandbox?: CodexSandbox;
  // existing fields remain unchanged
}
```

The stored JSON shape is flat:

```json
{
  "defaultSandbox": "danger-full-access"
}
```

Valid values are the existing `CodexSandbox` members: `read-only`, `workspace-write`, and `danger-full-access`. Do not add a second sandbox enum or change the enum in `src/core/driver.ts`.

`DEFAULT_CONFIG` must preserve the absence of this field for users who have not selected a setting. `loadConfig` continues to shallow-merge the saved object over `DEFAULT_CONFIG`. `saveConfig` continues to write the whole `RunAgentConfig` object. A valid `defaultSandbox` must pass through `loadConfig` and `saveConfig` without losing unrelated global fields or changing the field name.

Expose one shared, non-throwing `resolveDefaultSandbox(config)` resolver from `src/config/config.ts`. It returns a valid configured `CodexSandbox` or `undefined` when the field is absent or invalid. Both `run.ts` and the daemon must use this same resolver so config validation and fallback cannot drift between the CLI and IPC paths.

Validation happens before the value is used to launch Codex. A hand-edited value such as `"network"`, a number, an object, or another invalid JSON value must be treated as unset, fall back to the existing `workspace-write` behavior, and never crash setup, `run`, daemon session creation, or the driver. The validation seam may return an unset value so `CodexDriver` applies its existing fallback, but an invalid value must never reach `codex -s`.

The config contract does not rewrite a bad hand-edited value merely by loading it. It only prevents that value from being used. Selecting either setup toggle state writes a valid value.

## Sandbox resolution and plumbing

The precedence is fixed:

| Priority | Source | Behavior |
| --- | --- | --- |
| 1 | Explicit `--sandbox <mode>` | Parse and use the explicit CLI value. An invalid CLI value still fails as a usage error before a session row is created. |
| 2 | `config.defaultSandbox` | If no flag was supplied and the config value is a valid `CodexSandbox`, use it. Treat an absent or invalid value as unset. |
| 3 | Codex driver fallback | If neither earlier source supplies a valid value, retain the driver's existing `workspace-write` fallback. |

The existing `--dangerously-bypass-approvals-and-sandbox` behavior remains an explicit request for `danger-full-access`. Its current conflict handling with an explicit `--sandbox` stays intact.

### CLI run path

In `src/cli/commands/run.ts`, apply the precedence while resolving the sandbox in the existing block around `run.ts:99-125`:

1. Parse `opts.sandbox` when present.
2. When it is absent, resolve the validated `cfg.defaultSandbox`.
3. Keep the existing bypass-flag handling.
4. Keep `effectiveSandbox` Codex-only. Non-Codex agents receive `undefined` and the existing warning behavior.

Propagate the resolved Codex value through `params.sandbox` at the existing session request around `run.ts:171`. The request must carry the explicit value when one was supplied, the valid global value when no flag was supplied, and no value when the driver should use its fallback. Do not let a global setting override an explicit flag.

The final launch fallback remains in `buildCodexArgs` in `src/drivers/codex/driver.ts` around `28-31`, where an omitted sandbox becomes `workspace-write`. Do not change that driver default.

### Daemon session.create path

The daemon is a second config consumer. In `src/daemon/daemon.ts`, the `session.create` handler around `daemon.ts:247` loads `cfg` independently of the CLI. Resolve the sandbox at this boundary before constructing the session object around `daemon.ts:288-307`:

- For Codex, a valid request `p.sandbox` wins over a valid `cfg.defaultSandbox`.
- If the request has no sandbox, use the validated global value.
- If neither value is valid or present, leave the option unset so the Codex driver keeps its `workspace-write` fallback.
- For Claude, opencode, and omp, keep the sandbox unset regardless of the global config.

This covers callers that use the IPC boundary without going through `run.ts`. The session row and the driver start options must receive the resolved value used at creation time. A bad config value must be ignored safely at this boundary as well.

## Codex-only semantics

`StartOptions.sandbox` and `DriverSession.sandbox` already carry `CodexSandbox`. Only `src/drivers/codex/driver.ts` reads `StartOptions.sandbox` and emits `-s <mode>`. Claude, opencode, and omp must not receive a config-derived sandbox argument or gain new sandbox behavior.

The existing non-Codex behavior in `run.ts` remains the contract: clear the sandbox before sending it to the daemon and warn that `--sandbox` has no effect. The global setting must not bypass that guard. A config value is not a request to enforce a sandbox on a non-Codex harness.

## Setup toggle UX

Extend the setup flow in `src/cli/commands/setup.ts` with one non-role toggle screen after the existing role and orchestrator setup screens. Reuse the `Screen.next` pattern already used by the merged orchestrator-presets feature. `src/cli/picker-state.ts`, `src/cli/picker.ts`, and `src/cli/ui.ts` already provide the generic screen and skip/abort behavior; no sandbox-specific picker primitive is needed.

The screen must be named and described as `Danger full access`, with only OFF and ON states. OFF writes `defaultSandbox: "workspace-write"`. ON writes `defaultSandbox: "danger-full-access"`. There is no `read-only` item, label, or third state in the setup UI. A hand-edited `read-only` value remains available only through `config.json`.

Use the current config value to initialize the toggle's effective state. If the field is absent or invalid, the effective state is OFF because the runtime fallback is `workspace-write`. If the saved value is `read-only`, render the safe OFF position for interaction, but do not overwrite the saved value unless the user explicitly chooses OFF or ON. Do not expose `read-only` as a selectable state. Skipping the screen must preserve the prior property exactly, including an absent or hand-edited value. Choosing OFF or ON replaces it with the corresponding valid value.

An aborted wizard must call no config save and must leave the complete prior config unchanged. A skipped toggle may allow other completed setup changes to save, but it must not alter `defaultSandbox`. The existing config fields, including the merged orchestrator block, must survive the save.

## `open` remains unchanged

`src/cli/commands/open.ts` only launches Claude and opencode. It is Codex-blind and needs no sandbox wiring. Do not add `defaultSandbox` resolution or Codex sandbox flags to `open.ts`, `buildOpenArgs`, `buildInlineConfig`, or the Claude and opencode launch paths.

Add a regression unit test that exercises the open launch argument builders and proves the path contains no Codex sandbox-bearing launch option: no `--sandbox`, no Codex `-s <mode>`, and no `--dangerously-bypass-approvals-and-sandbox`. The existing Claude `--dangerously-skip-permissions` option is unrelated and remains unchanged. The test should also pin that `open` continues to select only its Claude or opencode launchers.

## Resume safety

An existing session keeps the sandbox selected when it was created. A later change to `config.defaultSandbox` must not retroactively change a live or resumable thread.

Preserve the current behavior in `src/drivers/session-driver.ts:125-135`: `SessionDriver.send` reuses `session.sandbox` rather than loading the current global config. Preserve the Codex resume behavior in `src/drivers/codex/driver.ts`: `codex exec resume` does not receive `-s`, because the native thread owns its original sandbox policy. The persisted session value records the creation-time choice, and a resumed thread must keep that choice even after the global setting changes.

## Acceptance criteria

Each criterion must be covered by a focused unit test.

1. `RunAgentConfig` accepts a top-level `defaultSandbox` with each valid `CodexSandbox` value, and a valid value round-trips through `loadConfig` and `saveConfig` without dropping unrelated config fields.

2. A config with no `defaultSandbox` resolves to the existing Codex `workspace-write` behavior. The driver still emits `-s workspace-write`, and the config loader does not invent a user-selected value.

3. A config containing an invalid, non-string, or otherwise malformed `defaultSandbox` never throws during config resolution, `run`, or daemon session creation. The invalid value is treated as unset and Codex falls back to `workspace-write`; it never reaches a Codex sandbox argument.

4. On `run`, an explicit valid `--sandbox` beats a different valid `config.defaultSandbox`, a missing flag uses the valid config value, and an absent or invalid config value leaves `params.sandbox` unset so the driver applies its fallback. The request sent to `session.create` contains the expected sandbox value in each case.

5. On the daemon `session.create` path, a valid request sandbox beats the global config, a missing request sandbox uses the global config, and neither value leaves the option unset for the Codex driver fallback. The daemon test must exercise the IPC boundary independently of the CLI.

6. A global sandbox value never changes a Claude, opencode, or omp launch. Non-Codex run requests clear the value and retain the existing warning behavior, and the daemon does not store or pass a config-derived sandbox for those agents.

7. The setup screen exposes exactly the two toggle states OFF and ON. OFF saves `workspace-write`, ON saves `danger-full-access`, and no setup item exposes `read-only`.

8. Skipping the sandbox screen preserves the prior `defaultSandbox` property, including when it is absent or hand-edited to `read-only`. Aborting the wizard performs no save and leaves the prior config unchanged.

9. The open launch path remains Codex-blind. Its Claude and opencode arguments contain no `--sandbox`, Codex `-s`, or `--dangerously-bypass-approvals-and-sandbox` option, and launcher selection remains limited to Claude and opencode.

10. A session created with one sandbox keeps that creation-time value when `config.defaultSandbox` changes. `SessionDriver.send` uses the session's stored value, and the Codex resume argument list omits `-s` so the native thread's sandbox is not changed.

11. The Codex driver's fallback remains `workspace-write` when no valid explicit or configured sandbox exists. No change is made to the Codex driver's default.

## Testing

Add focused tests for config validation and round-tripping, run precedence and non-Codex stripping, daemon `session.create` resolution, setup toggle behavior, open launch argument regression, and resume safety. Keep the existing Codex driver argument tests and add coverage only where needed to prove the new configured value reaches `buildCodexArgs` without changing its fallback or resume rules.

Do not use an end-to-end harness launch for the open regression. The pure launch argument builders and launcher selection are enough to prove that `open` has no Codex sandbox-bearing path.

## Execution plan

Implement these five slices in order. Each slice owns its listed files end to end and must pass its gate before the next dependent slice starts.

### Slice 1: config contract

Owned files: `src/config/config.ts`, `tests/config-sandbox.test.ts`.

Tests: Add the optional `defaultSandbox` field with a type-only `CodexSandbox` import, the shared `resolveDefaultSandbox` resolver, valid load/save round trips, absent-field fallback behavior, and non-throwing validation for malformed hand-edited values.

Gate: Focused config tests pass. A valid value survives persistence, an invalid value resolves as unset, and `DEFAULT_CONFIG` still represents an unconfigured user.

### Slice 2: setup toggle

Owned files: `src/cli/commands/setup.ts`, `tests/setup-wizard.test.ts`.

Tests: Cover the two-state `Danger full access` screen, OFF and ON mappings, the absence of a `read-only` choice, preservation on skip, no save on abort, and preservation of unrelated config fields.

Gate: Focused setup tests pass. Completing the screen writes exactly one valid global enum value, while skip and abort follow the existing wizard semantics.

### Slice 3: run wiring

Owned files: `src/cli/commands/run.ts`, `tests/run-sandbox.test.ts`, `tests/driver-args.test.ts`.

Tests: Cover explicit flag over config, config over driver fallback, invalid config fallback, propagation to `params.sandbox`, the existing bypass-flag conflict behavior, and stripping plus warnings for non-Codex agents.

Gate: Focused run tests pass, and the request sent by `run` cannot replace an explicit sandbox with the global default. The existing driver fallback assertion remains covered by `tests/driver-args.test.ts`; no driver default change is allowed.

### Slice 4: daemon boundary

Owned files: `src/daemon/daemon.ts`, `tests/daemon-sandbox.test.ts`, `tests/session-driver-sandbox.test.ts`.

Tests: Call `session.create` through the daemon boundary with explicit, configured, absent, invalid, and non-Codex cases. Assert the session row and Codex start options receive the correct creation-time value. The session-driver test changes the global config after creation, confirms `SessionDriver.send` reuses the stored sandbox, and confirms Codex resume omits `-s`.

Gate: Focused daemon and session-driver tests pass independently of the CLI path. Direct IPC callers receive the same precedence and fallback behavior as `run` callers, and the existing driver fallback remains `workspace-write`.

### Slice 5: open regression test

Owned files: `tests/open-sandbox.test.ts`.

Protected unchanged files: `src/cli/commands/open.ts`, `src/open/launchers/claude.ts`, `src/open/launchers/opencode.ts`.

Tests: Exercise Claude and opencode launcher selection and argument builders, asserting that no Codex sandbox option can be emitted. Verify that `open.ts` has no sandbox wiring.

Gate: The focused open regression test passes, and `git diff -- src/cli/commands/open.ts src/open/launchers/claude.ts src/open/launchers/opencode.ts` is empty. The feature is ready only with the open command and its launchers unchanged.

## Out of scope

1. Making `open` honor sandbox. `open` launches Claude and opencode only.

2. Per-project configuration. `defaultSandbox` is global in `~/.config/run-agent/config.json`, using the existing `getPaths` and `loadConfig` / `saveConfig` seams.

3. Enforcing a sandbox on non-Codex agents. Claude, opencode, and omp ignore this Codex-only setting.

4. Exposing `read-only` in the setup UI. It remains available only through hand-editing `config.json`.

5. Changing the Codex driver default. An absent or invalid configured value still ends at the existing `workspace-write` fallback.
