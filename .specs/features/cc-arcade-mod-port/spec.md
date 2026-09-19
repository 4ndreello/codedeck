# cc-arcade Mod Port (arcade)

## Goal

Port the cc-arcade pattern (sezaakgun cc-arcade v0.2.0 at github.com/sezaakgun/cc-arcade) into the codedeck plugin as a Mod named `arcade`.

Source behavior to port (from session 2bab discovery):

- `hooks/register.tsx` registers the arcade slash command with `immediate: true` on `session.start`.
- Draws a picker or a board above the prompt on `ui.render` for `AbovePrompt` using `Box`, `Button`, `Client`, `Text` from `$.ui.resolve`.
- Mounts one `Client` surface module per board from `hooks/boards`.
- Records turn start time on `turn.start` for the auto picker heuristic.
- Pauses the open game with a banner on `turn.complete`.
- Feeds a pet from `tool.call` by matching Bash test runner patterns plus `git commit` plus `Edit`, `Write`, `NotebookEdit`, keeping counters only with no command text stored.
- Persists pet plus best scores plus colorblind flag with `$.store`.
- Costs zero tokens because command handling runs locally.

Codedeck baseline (from session e1ed mapping):

- Plugin version 0.2.0.
- `plugin/hooks/hooks.json` declares only `SessionStart` and `UserPromptSubmit` shell command hooks with no function hooks module.
- `codedeck open` builds the settings payload at launch with theme plus fullscreen renderer plus spinner verbs plus tips plus statusline.
- Installed claude is 2.1.270, above the 2.1.269 drawing gate.
- Root tsconfig includes only `src`, so plugin tsx never breaks `npm run build`.
- Vitest includes `tests/**/*.test.ts`.

Port deliverables:

1. `arcade` slash command.
2. `AbovePrompt` board.
3. Pure pet plus best plus auto logic with unit tests.
4. Manifest declaring the hooks module.
5. `open` enabling function hooks.
6. Docs.

Port constraints carried over from upstream:

- Never declare a local variable named `h` in board files.
- `Client` module paths must be string literals.
- The band is about half the terminal height.
- Redraw is about ten times per second with doom at twenty.
- The board needs a click for keyboard focus and Esc always returns to the prompt.
- Terminal only with nothing drawn in `claude -p` headless, desktop, or mobile.
- A failed hot reload needs a session restart.

Upstream validation reference: `bun test` for pure logic, `oxlint`, `claude plugin validate`, and `/plugin-types` generating git ignored `.claude/types`.

## Acceptance criteria

- Arcade picker renders above the prompt in terminal sessions with function hooks on.
- One demo board is playable with keyboard after a click and Esc returns to the prompt.
- `turn.complete` pauses with a visible banner.
- `tool.call` feeds pet counters only.
- Best scores persist across sessions.
- `claude plugin validate` passes on the manifest and on the repo root.
- The scoped vitest run on the new tests passes.
- Existing suite expectations stay green.

## Out of scope

- Full nine game catalog parity including doom.
- Desktop, mobile, and headless support.
- Cross machine sync.
- Any dependency install, fetch, or vendor.
- Any push or destructive git action.

## Verification

Scoped runs only. Do not run the full suite. Do not install or fetch anything.

- `npm run build`
- `npx vitest run tests/mods-arcade`
- `claude plugin validate .claude-plugin/plugin.json`
- `claude plugin validate .`

Each command is run scoped as listed. Quote the output when reporting results.

## Stop conditions

- If `/plugin-types` cannot run noninteractively, specify engine types as stubbed and continue.
- Never invent engine APIs.
