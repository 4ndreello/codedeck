import { describe, expect, it } from "vitest";

import {
  banner,
  directionForKey,
  initialTwenty48State,
  isFinished,
  moveGrid,
  slideRow,
} from "../../plugin/mods/arcade/games/twenty48";

describe("slideRow", () => {
  it("merges pairs once and scores the merge", () => {
    expect(slideRow([2, 2, 4, 4])).toEqual({ row: [4, 8, 0, 0], gained: 12 });
  });

  it("slides without merging distinct tiles", () => {
    expect(slideRow([0, 2, 0, 4])).toEqual({ row: [2, 4, 0, 0], gained: 0 });
  });
});

describe("moveGrid", () => {
  it("reports moved false when nothing changes", () => {
    const grid = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
    expect(moveGrid(grid, "left").moved).toBe(false);
  });

  it("moves tiles left with merges", () => {
    const grid = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const stepped = moveGrid(grid, "left");
    expect(stepped.moved).toBe(true);
    expect(stepped.grid.slice(0, 4)).toEqual([4, 0, 0, 0]);
    expect(stepped.gained).toBe(4);
  });
});

describe("directionForKey", () => {
  it.each([
    ["up", "up"],
    ["w", "up"],
    ["down", "down"],
    ["s", "down"],
    ["left", "left"],
    ["a", "left"],
    ["right", "right"],
    ["d", "right"],
  ])("maps %s", (name, expected) => {
    expect(directionForKey(name)).toBe(expected);
  });

  it("rejects other keys", () => {
    expect(directionForKey("q")).toBeNull();
  });
});

describe("isFinished", () => {
  it("is not finished with open cells", () => {
    expect(isFinished(initialTwenty48State(() => 0).grid)).toBe(false);
  });

  it("is finished on a full grid with no merges", () => {
    expect(isFinished([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2])).toBe(true);
  });

  it("is not finished when a merge is still available", () => {
    expect(isFinished([2, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768])).toBe(
      false,
    );
  });
});

describe("banner", () => {
  it("pauses once per new done value", () => {
    const seen = { current: 0 };
    let pauses = 0;
    expect(banner(0, seen, () => (pauses += 1))).toBeNull();
    expect(banner(1, seen, () => (pauses += 1))).toContain("1");
    expect(banner(1, seen, () => (pauses += 1))).toBeNull();
    expect(pauses).toBe(1);
  });
});

describe("initialTwenty48State", () => {
  it("seeds two tiles on an empty board", () => {
    const state = initialTwenty48State(() => 0);
    expect(state.grid.filter((cell) => cell !== 0)).toHaveLength(2);
    expect(state).toMatchObject({ score: 0, over: false, won: false, posted: false, paused: false });
  });
});
