import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Screen } from "../src/cli/picker-state.js";
import { runScreens, type PickerIO } from "../src/cli/picker.js";
import { colors } from "../src/cli/ui.js";

const plain = colors(false);

function fakeIO() {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (v: boolean) => void;
  };
  input.isTTY = true;
  const rawCalls: boolean[] = [];
  input.setRawMode = (value: boolean) => {
    rawCalls.push(value);
    return input;
  };

  const output = new PassThrough() as PassThrough & { rows?: number; columns?: number };
  output.rows = 40;
  output.columns = 80;
  const written: string[] = [];
  output.on("data", (chunk) => written.push(String(chunk)));

  const resizeListeners: Array<() => void> = [];
  const io: PickerIO = {
    input,
    output,
    onResize(listener) {
      resizeListeners.push(listener);
      return () => {
        const at = resizeListeners.indexOf(listener);
        if (at >= 0) resizeListeners.splice(at, 1);
      };
    },
  };
  return { io, input, output, written, rawCalls, resizeListeners };
}

const screen = (agent: string): Screen => ({
  agent,
  title: agent,
  counter: "agente 1 de 1",
  pinned: false,
  known: new Set(["alpha", "beta"]),
  items: [
    { id: "alpha", label: "alpha", group: "g" },
    { id: "beta", label: "beta", group: "g" },
  ],
});

/**
 * Sends the next key only after the picker has painted, so a chunk cannot
 * arrive while the next screen is still installing its listener.
 */
function drive(input: PassThrough, output: PassThrough, keys: string[]): void {
  let next = 0;
  const send = () => {
    if (next < keys.length) input.write(keys[next++]);
  };
  output.on("data", () => setImmediate(send));
  setImmediate(send);
}

describe("picker session", () => {
  it("drives a screen from a fake stdin with a no-op setRawMode", async () => {
    const { io, input, output, rawCalls } = fakeIO();
    drive(input, output, ["\x1b[B", "\r"]);

    const results = await runScreens([screen("claude")], io, plain);

    expect(results).toEqual([{ kind: "picked", agent: "claude", id: "beta" }]);
    expect(rawCalls).toEqual([true, false]);
  });

  // One session for every screen: acquiring stdin per screen would let one
  // screen's type-ahead leak into the next.
  it("acquires raw mode once for every screen", async () => {
    const { io, input, output, rawCalls } = fakeIO();
    drive(input, output, ["\r", "\x07", "\r"]);

    const results = await runScreens([screen("a"), screen("b"), screen("c")], io, plain);

    expect(results.map((r) => r.kind)).toEqual(["picked", "skipped", "picked"]);
    expect(rawCalls).toEqual([true, false]);
  });

  it("aborts every remaining screen on ctrl-c", async () => {
    const { io, input, output } = fakeIO();
    drive(input, output, ["\x03"]);

    const results = await runScreens([screen("a"), screen("b")], io, plain);

    expect(results).toEqual([{ kind: "aborted" }]);
  });

  it("restores raw mode when a screen throws", async () => {
    const { io, input, output, rawCalls } = fakeIO();
    const broken = {
      ...screen("a"),
      get items(): never {
        throw new Error("boom");
      },
    };
    drive(input, output, ["\r"]);

    await expect(runScreens([broken as unknown as Screen], io, plain)).rejects.toThrow("boom");
    expect(rawCalls.at(-1)).toBe(false);
  });

  // A listener per screen piled up four of them on a four agent run.
  it("installs one resize listener and removes it at the end", async () => {
    const { io, input, output, resizeListeners } = fakeIO();
    drive(input, output, ["\r", "\r", "\r"]);

    await runScreens([screen("a"), screen("b"), screen("c")], io, plain);

    expect(resizeListeners).toHaveLength(0);
  });

  it("turns bracketed paste on at the start and off at the end", async () => {
    const { io, input, output, written } = fakeIO();
    drive(input, output, ["\r"]);

    await runScreens([screen("a")], io, plain);
    const all = written.join("");

    expect(all).toContain("\x1b[?2004h");
    expect(all).toContain("\x1b[?2004l");
  });

  // A frame that shrinks has to clear the physical lines of the previous one.
  it("clears the previous frame before writing a smaller one", async () => {
    const { io, input, output, written } = fakeIO();
    drive(input, output, ["a", "l", "\r"]);

    await runScreens([screen("a")], io, plain);

    expect(written.join("")).toMatch(/\x1b\[\d+A/);
  });
});
