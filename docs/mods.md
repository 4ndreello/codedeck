# CodeDeck mods (arcade)

Function hooks backing the arcade mod. Boards and game logic live in the MOD
slice; this file covers integration only: how the hooks get enabled, typed,
and validated.

## Enablement

`codedeck open` launches claude sessions with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
in the spawn environment (`sanitizeEnv` in `src/open/runtime.ts`, set with
`??=` so an explicit value of the user's own wins and an opt-out keeps
working).

The variable is namespaced to Claude Code: the opencode and codex spawns that
share the helper carry it inertly and behave exactly as before. The
`--no-bypass`, `--no-theme` and `--no-pty` escape hatches ride in argv, not
env, so they are untouched.

## Declaration

`plugin/hooks/hooks.json` carries a top-level `modules` array with one entry
pointing at the register file, plus a description naming the arcade mod and
its function hooks requirement. The existing `hooks` key (`SessionStart` for
`session-id.sh`, `UserPromptSubmit` for `session-name.sh`) is unchanged.

The new capability bumps the plugin to 0.3.0 in
`plugin/.claude-plugin/plugin.json`.

## plugin-types flow

Run the plugin-types flow from the repo root. It writes the generated types
under `.claude/`, which stays gitignored, so generated output never lands in a
diff or a review.

## Validation

Validate the manifest path after any manifest edit:

```sh
claude plugin validate plugin/.claude-plugin/plugin.json
```

Validate the whole plugin from the repo root:

```sh
claude plugin validate .
```

Root-level validation resolves the `modules` entry, so it needs
`plugin/hooks/register.tsx` from the MOD slice and stays pending until that
slice lands.

## Board constraints

Board files in the MOD slice hold to these limits:

- Never a local variable named `h`.
- `Client` module paths are string literals.
- Board height stays around half the terminal height band.
- Redraw runs around ten frames per second.
- Click gives keyboard focus; Esc returns to the prompt.
- Terminal only: nothing renders in headless desktop or mobile.
- Version gate: Claude Code 2.1.269 or later (verified against installed
  2.1.270).
