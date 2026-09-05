import { describe, expect, it } from "vitest";
import { isActiveStatus, isTerminalStatus, type SessionStatus } from "../src/core/session.js";

describe("power interrupted status", () => {
  it("treats interrupted as terminal", () => {
    expect(isTerminalStatus("interrupted")).toBe(true);
  });

  it("treats interrupted as not active", () => {
    expect(isActiveStatus("interrupted")).toBe(false);
  });

  it("keeps existing terminal statuses terminal", () => {
    const terminal: SessionStatus[] = ["completed", "failed", "stopped", "orphaned"];
    for (const s of terminal) expect(isTerminalStatus(s)).toBe(true);
  });

  it("keeps existing active statuses active and non-terminal", () => {
    const active: SessionStatus[] = ["starting", "working", "needs_input", "idle"];
    for (const s of active) {
      expect(isActiveStatus(s)).toBe(true);
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});
