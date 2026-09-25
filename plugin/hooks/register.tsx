/** @jsx h */
import type { Register } from "claude-code";

// The .js extension on a .ts source is the proven import form here:
// `npm run build:plugin` copies plugin/ verbatim and the engine loads the .ts
// file directly, so what resolves is what the engine's loader accepts.
import { formatPane, paneButtonLabel, selectPane } from "../mods/agents/pane.js";
import { parseRows } from "../mods/agents/parse.js";
import type { PaneSnapshot } from "../mods/agents/types.js";
import { createPaneTicker, type PaneTicker } from "./pane-ticker.js";
import { togglePane } from "./pane-toggle.js";

// Stable pane id: 1 to 64 letters, digits, "_" or "-". open carries it into
// e.requestId on the render event, which is how this module tells its own pane
// from any other: e.id is undefined on that event. Verified live.
const PANE_ID = "codedeck-agents";

// Key of the button drawn above the prompt. It comes back as e.element on the
// press event, which is how this module tells its own button from every other
// plugin's. Verified live.
const BUTTON_KEY = "codedeck-agents-open";

// The engine ships no type package for $, so this mirrors only the
// capabilities the refresh helper calls. Both arguments of process.run are
// positional: the host implementation destructures { argv, init }, but the
// module-side proxy packs the positional arguments into that object first, and
// calling it with the object shape is refused at runtime with "process.run:
// takes argv, a non-empty list of strings naming the command first". Verified
// in a live PTY session, see docs/mods.md.
type Engine$ = {
  env: {
    get(name: string): Promise<string | undefined>;
  };
  process: {
    run(
      argv: string[],
      init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  ui: {
    open(pane: { id: string; width?: number; side?: "right" }): Promise<unknown>;
    close(pane: { id: string }): Promise<unknown>;
    invalidate(target: string): Promise<unknown>;
  };
};

const toggleAgentsPane = async ($: Engine$, isOpen: boolean): Promise<boolean> =>
  togglePane(isOpen, {
    open: () => $.ui.open({ id: PANE_ID, side: "right" }),
    close: () => $.ui.close({ id: PANE_ID }),
  });

// Passing $ into a helper is allowed, verified. What the engine refuses is
// pulling a namespace off it: `const P = $.process` fails to load the module.
// refresh takes $ as a parameter; its state and paneOpen stay in this register.
type PaneState = {
  // Last good snapshot; undefined until one refresh has fully succeeded, which
  // is how the pane draws nothing rather than a guess.
  snapshot: PaneSnapshot | undefined;
  inFlight: boolean;
  lastRefreshEndedAt: number;
  ticker: PaneTicker | undefined;
  paneOpen: boolean;
  tickInvalidate: () => unknown;
  tickRefresh: () => unknown;
  // True once session.start saw a CODEDECK_RUN_ID. Cached because ui.render
  // fires on every drawing pass and must not await an env read to decide
  // whether to draw one button.
  hasRun: boolean;
};

const TOOL_REFRESH_GAP_MS = 1500;

function syncTicker($: Engine$, state: PaneState, refreshCompleted = false): void {
  state.tickInvalidate = () => $.ui.invalidate("ui.render");
  state.tickRefresh = () => refresh($, state);
  if (refreshCompleted) state.ticker?.refreshed();
  state.ticker?.update(state.paneOpen, state.snapshot);
}

const refresh = async ($: Engine$, state: PaneState): Promise<void> => {
  // Claim the slot before the first await. Guard and set must not straddle a
  // yield point: with the `$.env.get` read in between, two tool.call firings
  // that interleave in that window both pass the guard and both spawn
  // `codedeck ps`. Nothing between these two lines can yield.
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    // Not process.env: a hooks module runs in a realm with no `process`
    // global at all, and reading it throws
    // `ReferenceError: process is not defined`. The engine's own $.env.get is
    // the door, and it takes a literal name. Verified live: this returns the
    // run id that `codedeck open` exports. The await sits inside the try
    // because the call sites use `void refresh(...)`: a rejection here must
    // land in the catch, not surface as an unhandled rejection.
    const runId = await $.env.get("CODEDECK_RUN_ID");
    if (!runId) return;
    const { exitCode, stdout } = await $.process.run(["codedeck", "ps", "--all", "--json"]);
    if (exitCode !== 0) return;
    const rows = parseRows(stdout);
    if (!rows) return;
    const nextSnapshot = selectPane(rows, runId);
    // Cheap compare: an unchanged list must not invalidate, or the tool.call
    // cadence turns into a redraw storm.
    const drawn = JSON.stringify(state.snapshot);
    state.snapshot = nextSnapshot;
    if (JSON.stringify(nextSnapshot) !== drawn) {
      await $.ui.invalidate("ui.render");
    }
  } catch {
    // $.process.run throws on timeout and on start failure. A thrown hook
    // makes the engine drop the whole drawing, so nothing escapes here: the
    // pane keeps the last good snapshot.
  } finally {
    state.inFlight = false;
    state.lastRefreshEndedAt = Date.now();
    syncTicker($, state, true);
  }
};

export const register: Register = (on) => {
  const state: PaneState = {
    snapshot: undefined,
    inFlight: false,
    lastRefreshEndedAt: 0,
    hasRun: false,
    ticker: undefined,
    paneOpen: false,
    tickInvalidate: () => undefined,
    tickRefresh: () => undefined,
  };
  state.ticker = createPaneTicker({
    now: () => Date.now(),
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    invalidate: () => state.tickInvalidate(),
    refresh: () => state.tickRefresh(),
  });

  on("session.start", async ($, e, next) => {
    syncTicker($, state);
    // Not "agents": the engine refuses it with `$.command.register: "/agents"
    // refused: it is the built-in /agents`. "band", "deck" and
    // "codedeck-agents" were each verified free. The description is load
    // bearing: without it the whole session.start hook dies.
    await $.command.register({
      name: "band",
      description: "toggle the codedeck agents pane",
      immediate: true,
    });
    // Only show the button when there is actually a run behind the pane. A
    // session that loads this plugin by manual --plugin-dir or a global
    // install has no CODEDECK_RUN_ID, and its dock stays empty. /band remains
    // available for anyone who wants to open it anyway.
    const runId = await $.env.get("CODEDECK_RUN_ID");
    state.hasRun = Boolean(runId);
    if (runId) {
      // Prime the button label without taking screen space when the session
      // starts. The panel opens only on an explicit button press or /band.
      void refresh($, state);
    }
    return next(e);
  });

  on("command.run", { command: "band" }, async ($) => {
    // The action derives from the current state and the flag flips only after
    // the engine call resolves: if $.ui.close ever rejects, its argument shape
    // is the one call here not yet verified in a PTY session, paneOpen stays
    // true and the next /band retries the close, instead of the flag and the
    // pane desyncing for the rest of the session.
    state.paneOpen = await toggleAgentsPane($, state.paneOpen);
    syncTicker($, state);
    await $.ui.invalidate("ui.render");
    if (state.paneOpen) void refresh($, state);
    return { text: state.paneOpen ? "agents pane open" : "agents pane closed" };
  });

  on("turn.complete", async ($, e, next) => {
    void refresh($, state);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (Date.now() - state.lastRefreshEndedAt >= TOOL_REFRESH_GAP_MS) {
      void refresh($, state);
    }
    // The downstream result goes back unchanged: the pane must never alter a
    // tool result.
    return await next(e);
  });

  on("ui.press", async ($, e, next) => {
    // e.element is the key of the pressed button, so everything else on screen
    // belongs to somebody else. The work sits here rather than in the button's
    // own onPress because this $ is the one the engine hands the press event.
    // A $ captured from a past render does work, verified, but it outlives the
    // event it came from and nothing promises how long.
    if ((e as { element?: string }).element === BUTTON_KEY) {
      state.paneOpen = await toggleAgentsPane($, state.paneOpen);
      syncTicker($, state);
      await $.ui.invalidate("ui.render");
      if (state.paneOpen) void refresh($, state);
    }
    return await next(e);
  });

  // Both drawings. The pane carries the canvas; above the prompt there is one
  // button and nothing else, which is all that is left of the rejected design's
  // flat table. ui.render fires once per component, so every gate here is load
  // bearing, and each branch returns exactly one tree element, never an array,
  // or the engine drops the drawing with "ui.render hook skipped: returned the
  // wrong shape".
  on("ui.render", async ($, e, next) => {
    if (e.surface !== "terminal") return await next(e);
    // The pane can be closed from its own close box, which fires no hook.
    // Keep one button above the prompt as the visible toggle for the state
    // transitions this module owns.
    if (e.component === "AbovePrompt") {
      if (!state.hasRun) return await next(e);
      const { Box, Button } = await $.ui.resolve(e, "Box", "Button");
      return (
        <Box flexDirection="column">
          <Button
            key={BUTTON_KEY}
            label={paneButtonLabel(state.snapshot)}
            // Mandatory, and empty on purpose: a Button without onPress makes
            // the engine drop the whole drawing with "returned a Button without
            // an onPress function". Its own argument is the press event, not $,
            // so `async ($) => $.ui.open(...)` here throws. The ui.press hook
            // above does the work.
            onPress={() => {}}
          />
          {await next(e)}
        </Box>
      );
    }
    if (e.component !== "Pane") return await next(e);
    if (e.requestId !== PANE_ID) return await next(e);
    if (state.snapshot === undefined) return await next(e);
    // The usable content size is what the pane reports, never an assumed
    // number. Width comes as props.bodyColumns and height as
    // props.scroll.bodyRows: measured live as 89 and 44 in a 200 column,
    // 50 row terminal. A requested width on $.ui.open is ignored, the engine
    // sizes the dock itself, so reading both off the event is the only way to
    // fit. Without the width there is no safe number to hand formatPane; the
    // height is optional and only caps the drawing.
    const props = (e as { props?: { bodyColumns?: number; scroll?: { bodyRows?: number } } }).props;
    const columns = props?.bodyColumns;
    if (typeof columns !== "number") return await next(e);
    const lines = formatPane(state.snapshot, columns, props?.scroll?.bodyRows);
    if (lines.length === 0) return await next(e);
    // Capitalized tags from the resolve table; a lowercase <text> is refused
    // as "JSX element <text> is not an element".
    const { Box, Text } = await $.ui.resolve(e, "Box", "Text");
    // flexDirection is load bearing: Box lays children out in a row by default,
    // so without it the 51 lines are drawn side by side as narrow columns and
    // the pane comes out as shredded box characters. Verified on screen.
    return (
      <Box flexDirection="column">
        {lines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
        {await next(e)}
      </Box>
    );
  });
};
