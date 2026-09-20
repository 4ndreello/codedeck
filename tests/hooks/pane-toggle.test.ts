import { describe, expect, it } from "vitest";

import { togglePane } from "../../plugin/hooks/pane-toggle.js";

describe("togglePane", () => {
  it("opens a closed pane", async () => {
    const calls: string[] = [];

    const open = await togglePane(false, {
      open: async () => calls.push("open"),
      close: async () => calls.push("close"),
    });

    expect(open).toBe(true);
    expect(calls).toEqual(["open"]);
  });

  it("closes an open pane", async () => {
    const calls: string[] = [];

    const open = await togglePane(true, {
      open: async () => calls.push("open"),
      close: async () => calls.push("close"),
    });

    expect(open).toBe(false);
    expect(calls).toEqual(["close"]);
  });
});
