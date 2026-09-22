# CodeDeck mods

Function hooks backing codedeck plugin mods. This file covers integration:
how the hooks get enabled, typed, and validated, and the engine contract a
module has to satisfy.

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
pointing at the register file, plus a description stating what the plugin
provides and its function hooks requirement. The existing `hooks` key
(`SessionStart` for `session-id.sh`, `UserPromptSubmit` for `session-name.sh`)
is unchanged.

The new capability bumps the plugin to 0.3.0 in
`plugin/.claude-plugin/plugin.json`.

## Runtime contract

The rules below are what the engine actually enforces on a hooks module. They
were recovered from error strings in the Claude Code binary while porting a
game into this module, and none of them appear in public Claude Code docs. The
exact wording is quoted in backticks because it is what shows up in your
terminal when a hook is refused, so you can grep for it.

### One tree element

A `ui.render` handler returns exactly one tree element, never an array. The
validator rejects anything else with `something that is not a tree element`,
surfaced as:

```
codedeck: ui.render hook skipped: returned the wrong shape (something that is not a tree element)
```

To keep the rest of the UI drawing, nest the downstream result as the last
child of your single element: `{await next(e)}`.

### ui.render fires per drawn component

The event runs once for each of `AbovePrompt`, `Pane`, `UserMessage`,
`ToolUse`, and `ToolResult`. A handler that does not gate draws in all of
them. The gate:

```tsx
if (e.surface !== "terminal" || e.component !== "AbovePrompt") return await next(e);
```

The engine also refuses some components outright, with wording of the form
`<component> is drawn by the engine alone`.

### Box lays children out in a row

`Box` defaults to `flexDirection: "row"`, so a list of `Text` children is
drawn side by side, not stacked. A 51 line drawing came out as vertical
slivers of box characters, one per column, with no error anywhere: the module
loaded, the hook ran, the engine was happy. Only a screen capture showed it.
Any multi line drawing needs the direction spelled out:

```tsx
<Box flexDirection="column">
  {lines.map((line) => <Text key={line}>{line}</Text>)}
  {await next(e)}
</Box>
```

### A docked pane reports its own size, and ignores the one you ask for

`$.ui.open({ id, side: "right" })` opens the dock. `width` is accepted and
then ignored: the engine sizes the dock. What comes back on every `ui.render`
is the truth, and a module that assumes a number instead of reading these
draws off the edge:

- `e.requestId` carries the id from `open`. `e.id` is `undefined` on the
  render event, so it is the only way to tell one pane from another
- `e.props.bodyColumns` is the usable width
- `e.props.scroll` is `{ offset, bodyRows }`, and `bodyRows` is the usable
  height. Anything taller is clipped at the bottom with no warning, which
  silently eats a footer
- `e.viewport` is the space left over for everything else, not the terminal
  and not the pane

Measured together in one 200 by 50 terminal: `bodyColumns` 89,
`scroll.bodyRows` 44, `viewport` `{ columns: 110, rows: 50 }`.

The first snapshot loads during session start, so the button can show agent
status before the first turn. The pane stays closed until the button or `/band`
opens it.

### Capitalized tags, resolved from the event

With `/** @jsx h */`, a lowercase tag compiles to a string literal and a
capitalized tag to an identifier. The intrinsic table in a hooks module is
exactly `{ Box: 'Box', Text: 'Text' }`, so `<text>` fails. The refusal
arrives whole, and its tail names every tag that does resolve:

```
JSX element <text> is not an element: a render hook draws with the table $.ui.resolve(e) returns (Box, Text, Button, Input, Select, Link, Code, Client, Svg) and what next(e) returned
```

Take the components from the event:

```tsx
const { Box, Text } = await $.ui.resolve(e, "Box", "Text");
```

A surface module is different. It gets its element set from
`surface.elements`: on the terminal that is `Box, Text, Button, Input,
Select, Link, Code` and `Client`. `Svg` completes the table and belongs to
the desktop surface.

### Button needs a key, a label and an onPress

Three refusals:

```
JSX element <Button> needs a key: its address, what e.element carries at ui.press (the label when absent)
JSX element <Button> needs a label: the label prop, or one string child
JSX element <Button key="..."> needs an onPress function
```

A button missing any of them throws out of the render hook, and the whole
drawing is dropped. The `onPress` refusal is a runtime one too, not only a
validator rule: a live session answers

```
ui.render hook skipped: threw <plugin>: returned a Button without an onPress
function; a render hook draws one with <Button key label onPress>
```

### onPress is handed the press event, not the engine handle

The callback's first argument is the press event:

```json
{ "plugin": "…", "element": "…", "component": "AbovePrompt", "requestId": "above-prompt", "surface": "terminal" }
```

So `onPress={async ($) => { await $.ui.open(…) }}` throws
`undefined is not an object (evaluating '$.ui.open')`. The failure is quiet in
the worst way: everything the callback did before the first `await` has already
happened, so a flag flipped at the top makes the button look like it worked.

A `$` captured from the enclosing render hook does work. Verified: a button
whose `onPress` closes over the render hook's `$` opened a docked pane and the
pane drew. What does not exist is a handle delivered to the callback.

Both spellings are live. The agents pane uses a third: an empty `onPress` and
the work in a `ui.press` hook, where `e.element` is the key of the button that
was pressed and `$` is the one the engine hands that event, rather than one
captured from a render that has already finished.

A `hotkey` prop does not help at the top-level prompt: the key is typed into
the input instead of firing the button. Verified with `hotkey="a"` on an empty
prompt.

### A pane closed by its own close box tells the module nothing

The dock draws an `✕` in its top-right corner. Clicking it closes the pane and
fires no hook at all: no `ui.press`, no render, nothing. A module that tracks
open state in a flag will desync there.

`$.ui.open` on an already open pane is a no-op, no error and no second dock, so
the agents pane keeps a small internal flag for the transitions it owns. The
`/band` command and the button above the prompt both toggle the pane. Closing
with the native `✕` remains an engine limitation: the next toggle can consume
the stale close state before the pane opens again.

### Clicking a button from a test

The client turns on SGR mouse tracking, so a synthetic click is deliverable.
Confirm the flags, then send press and release at a cell:

```sh
tmux display -t <session> -p 'any=#{mouse_any_flag} sgr=#{mouse_sgr_flag}'  # any=1 sgr=1
tmux send-keys -t <session> -l $'\033[<0;<col>;<row>M'
tmux send-keys -t <session> -l $'\033[<0;<col>;<row>m'
```

Column and row are 1-based and come straight from `tmux capture-pane -p`.

### Client reads six props and silently discards the rest

`<Client>` takes `module`, `key`, `props`, `width`, `height`, and `flexGrow`.
Anything else passed at the top level is dropped with no error at all, which is
the worst failure mode here because nothing tells you. Application data goes
inside `props={{ ... }}`.

`module` must be a string literal path relative to the declaring file, and
`key` is required:

```
JSX element <Client module="..."> needs a key: its address, what e.element carries at ui.message
```

`<Client>` is a leaf and takes no children.

### command.register requires a description

```
$.command.register takes { name, description, argumentHint?, immediate? }; name is letters, digits, _ or - (up to 64)
```

Omitting the description throws
`$.command.register: <name> needs a description (what the menu shows)`, which
kills the entire `session.start` hook, not just the command.

### Do not seed surface state during render

The engine's guard reads:

```
set its state again after each of {N} renders, nothing heard between; set state on a pointer or key event, a tick, a press or new props, and let a render settle
```

This is an open defect observed in this repo, not settled theory. In a live
PTY session, a `Client` surface that seeded its state during render did not
keep state across renders. That was observed. Why is a grounded hypothesis,
the render-time seeding, not a proven fact.

### process.run

`$.process.run(argv, init?)`. **Both arguments are positional**, and this is
the one contract on this page where reading the engine implementation gives you
the wrong answer. The host function destructures `{ argv, init }`, so the
obvious call is `$.process.run({ argv: [...] })`, and that call is refused:

```
process.run: takes argv, a non-empty list of strings naming the command first
```

The module-side proxy packs positional arguments into that object before the
host sees them. Verified in a live session:

```ts
await $.process.run(["codedeck", "ps", "--all", "--json"])            // works
await $.process.run(["echo", "hi"], { timeoutMs: 5000 })              // works
await $.process.run({ argv: ["echo", "hi"] })                         // refused
```

`argv[0]` is the command and an array means no shell, so no quoting question.
`init` is `{ cwd?, env?, stdin?, timeoutMs? }`, with `timeoutMs` a whole number
from 1 to 600000 and a default of 30000. Each of stdout and stderr is captured
and truncated at 4194304 characters. The child runs under cgroup class
`plugin`. It resolves to `{ exitCode, stdout, stderr }`, with `exitCode`
falling back to `1` when the process closes without one, and it throws on
timeout or abort and on failure to start. Both throws must be caught: an
uncaught one takes the whole drawing down.

### $ is analysed statically, so never alias it

`$` can be passed into a helper function. Pulling a namespace off it cannot:

```ts
const P = $.process;   // module fails to load
```

```
$.process is used as a value (a noun...)
```

Every engine call has to appear literally as `$.<namespace>.<method>(...)` at
the call site. The engine reads the compiled source, and it names the compiled
line in the error, not the line you wrote.

## Worked example

`.specs/features/orchestrator-agents-band/reference-register.tsx` is the
arcade register after all five fixes, kept on purpose. What is verified is
its shape: the `ui.render` handler below drew correctly in a live PTY
session, and it carries the gate, the resolve, the single returned element, a
`Button` with a key, a label and `onPress`, and the nested `{await next(e)}`.
The register will not load as it stands. Its imports, and its `Client`
module path, point at the arcade slice that was deleted.

```tsx
on("ui.render", async ($, e, next) => {
  if (e.surface !== "terminal" || e.component !== "AbovePrompt") return await next(e);
  const { Box, Button, Client, Text } = await $.ui.resolve(e, "Box", "Button", "Client", "Text");
  if (openBoard === null) {
    return (
      <Box>
        <Text>Arcade boards</Text>
        <Button
          key="twenty48"
          label="twenty48"
          onPress={async () => {
            openBoard = "twenty48";
            await $.ui.invalidate("ui.render");
          }}
        />
        {await next(e)}
      </Box>
    );
  }
  return (
    <Box>
      <Client key="twenty48" module="./boards/twenty48.tsx" props={{ done, colorblind, best: best[openBoard] ?? 0 }} />
      {await next(e)}
    </Box>
  );
});
```

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
`plugin/hooks/register.tsx`.

## What validation does not prove

Two traps, both reached for during that port and both useless here.

`claude plugin validate .` proves manifest shape only. It passes cleanly
against a module that throws on every render. Never read a green validate as
evidence that anything draws.

A headless `claude -p` run is not a probe for this either. It was tried, it
reported no errors, and a control built by restoring known-broken code also
reported no errors, even with `--debug`. Only a PTY session shows these
failures. Nobody should repeat that experiment.

## Module constraints

Modules loaded through the `modules` declaration hold to these limits:

- Never a local variable named `h`.
- `Client` module paths are string literals.
- Terminal only: nothing renders in headless desktop or mobile.
- Version gate: Claude Code 2.1.269 or later (verified against installed
  2.1.270).
