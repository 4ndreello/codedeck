import { describe, expect, it } from "vitest";

import { DROPIN_GAMES, pickAuto, pickPool, pickRandom } from "../../plugin/mods/arcade/games/auto";

describe("pickAuto", () => {
  it("suggests deep games for turns over one minute", () => {
    expect(pickAuto({ lastTurnMs: 61_000 })).toBe("twenty48");
    expect(pickAuto({ lastTurnMs: 5 * 60_000 })).toBe("twenty48");
  });

  it("suggests quick games for turns under one minute", () => {
    expect(pickAuto({ lastTurnMs: 5_000 })).toBe("twenty48");
    expect(pickAuto({})).toBe("twenty48");
  });

  it("suggests drop-in games when idle", () => {
    expect(DROPIN_GAMES).toContain("twenty48");
    expect(pickAuto({ idle: true })).toBe("twenty48");
    expect(pickAuto({ idle: true, lastTurnMs: 10 * 60_000 })).toBe("twenty48");
  });
});

describe("pickPool", () => {
  it("flips from quick to deep across the 60000 ms threshold", () => {
    expect(pickPool({ lastTurnMs: 59_999 })).toBe("quick");
    expect(pickPool({ lastTurnMs: 60_000 })).toBe("quick");
    expect(pickPool({ lastTurnMs: 60_001 })).toBe("deep");
    expect(pickPool({ lastTurnMs: 61_000 })).toBe("deep");
  });

  it("maps idle to dropin regardless of turn length", () => {
    expect(pickPool({ idle: true })).toBe("dropin");
    expect(pickPool({ idle: true, lastTurnMs: 10 * 60_000 })).toBe("dropin");
  });

  it("defaults to quick without input", () => {
    expect(pickPool({})).toBe("quick");
    expect(pickPool({ lastTurnMs: 5_000 })).toBe("quick");
  });
});

describe("pickRandom", () => {
  it("returns a member of the given list", () => {
    expect(["a", "b"]).toContain(pickRandom(["a", "b"]));
  });

  it("falls back to the drop-in list by default", () => {
    expect(DROPIN_GAMES).toContain(pickRandom());
  });
});
