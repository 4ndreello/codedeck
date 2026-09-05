import { emitKeypressEvents } from "node:readline";

import {
  applyKey,
  initialState,
  reanchor,
  type Key,
  type Screen,
  type ScreenResult,
} from "./picker-state.js";
import { readDimensions, renderFrame, viewportHeight, type Colors } from "./ui.js";

export type { ScreenResult } from "./picker-state.js";

export interface PickerIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
  output: NodeJS.WritableStream & { rows?: number; columns?: number };
  onResize?(listener: () => void): () => void;
}

const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

interface Frame {
  height: number;
  repaint: () => void;
}

/**
 * Sole owner of raw mode, the listeners and the cleanup. Acquiring per screen
 * would let one screen's type-ahead leak into the next.
 */
export async function runScreens(
  screens: Screen[],
  io: PickerIO,
  c: Colors,
): Promise<ScreenResult[]> {
  const { input, output } = io;
  const results: ScreenResult[] = [];

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      output.write(`${PASTE_OFF}\n`);
    } catch {
      // A dead stdout (EPIPE under `| head`) must not cost the terminal its
      // cooked mode: the write is the disposable half of restoring.
    }
    input.setRawMode?.(false);
    input.pause();
  };

  // SIGTERM does not run the `exit` handler, and counting on Node to restore
  // the TTY by itself is counting on luck.
  const onExit = () => restore();
  const onSigterm = () => {
    restore();
    process.exit(143);
  };
  process.on("exit", onExit);
  process.on("SIGTERM", onSigterm);

  // One frame and one resize listener for the whole run: a listener per screen
  // piled up four of them on a four agent run.
  const frame: Frame = { height: 0, repaint: () => {} };
  let stopResize: (() => void) | undefined;

  // Setup lives inside the try because raw mode is on from its second line: a
  // throw between there and the loop used to skip the finally entirely.
  try {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    output.write(PASTE_ON);
    stopResize = io.onResize?.(() => frame.repaint());

    for (const screen of screens) {
      const result = await runScreen(screen, io, c, frame);
      results.push(result);
      if (result.kind === "aborted") break;
    }
  } finally {
    frame.repaint = () => {};
    stopResize?.();
    process.off("exit", onExit);
    process.off("SIGTERM", onSigterm);
    restore();
  }

  return results;
}

function runScreen(screen: Screen, io: PickerIO, c: Colors, frame: Frame): Promise<ScreenResult> {
  return new Promise<ScreenResult>((resolve, reject) => {
    const { input, output } = io;
    let state = initialState(screen);

    const paint = () => {
      const dim = readDimensions(output);
      // A resize can shrink the viewport under a cursor that was scrolled into
      // the old one. Reanchoring here covers the repaint the resize triggers,
      // where no key ran to fix the offset.
      state = reanchor(state, viewportHeight(state, dim));
      const lines = renderFrame(state, dim, c);
      // Go up by the previous frame's height and clear from there down, or a
      // smaller frame leaves the bigger one's leftovers on screen.
      const prefix = frame.height > 0 ? `\x1b[${frame.height}A\x1b[0J` : "";
      output.write(`${prefix}${lines.join("\n")}\n`);
      frame.height = lines.length;
    };

    const detach = () => {
      input.off("keypress", onKey);
      frame.repaint = () => {};
    };

    const onKey = (sequence: string | undefined, key: Key | undefined) => {
      const pressed: Key = key
        ? { ...key, sequence: key.sequence ?? sequence ?? "" }
        : { sequence: sequence ?? "", ctrl: false, meta: false };
      try {
        const outcome = applyKey(state, pressed, viewportHeight(state, readDimensions(output)));
        state = outcome.state;
        if (outcome.action.kind === "none") {
          paint();
          return;
        }
        detach();
        if (outcome.action.kind === "picked") {
          resolve({ kind: "picked", agent: screen.agent, id: outcome.action.id });
          return;
        }
        if (outcome.action.kind === "skipped") {
          resolve({ kind: "skipped", agent: screen.agent });
          return;
        }
        resolve({ kind: "aborted" });
      } catch (error) {
        detach();
        reject(error);
      }
    };

    input.on("keypress", onKey);
    frame.repaint = paint;
    try {
      paint();
    } catch (error) {
      detach();
      reject(error);
    }
  });
}
