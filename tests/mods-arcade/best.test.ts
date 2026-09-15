import { describe, expect, it } from "vitest";

import { isBetter } from "../../plugin/mods/arcade/games/best";

describe("isBetter", () => {
  it("accepts the first score for a game", () => {
    expect(isBetter("twenty48", 128, {})).toBe(true);
  });

  it("compares the new score against the stored best per game", () => {
    expect(isBetter("twenty48", 256, { twenty48: 128 })).toBe(true);
    expect(isBetter("twenty48", 64, { twenty48: 128 })).toBe(false);
    expect(isBetter("twenty48", 128, { twenty48: 128 })).toBe(false);
  });

  it("keeps bests isolated per game", () => {
    expect(isBetter("other", 10, { twenty48: 9999 })).toBe(true);
  });
});
