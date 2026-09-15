import { describe, expect, it } from "vitest";

import { randomInt } from "../../plugin/mods/arcade/games/random";

describe("randomInt", () => {
  it("rejects non-positive integer bounds", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-4)).toThrow(RangeError);
    expect(() => randomInt(1.5)).toThrow(RangeError);
  });

  it("returns 0 for a bound of 1", () => {
    expect(randomInt(1)).toBe(0);
  });

  it("stays an integer inside the bound", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      const value = randomInt(16);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(16);
      seen.add(value);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
