import { describe, it, expect } from "vitest";

// Test session logic without DB dependency: test pure helpers
import { generateSessionId, isTerminalStatus, isActiveStatus, generateBranchName } from "../src/core/session.js";
import { createEvent } from "../src/core/events.js";

describe("session helpers", () => {
  it("generates 4-char hex id", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{4}$/);
  });
  it("terminal vs active", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("working")).toBe(false);
    expect(isActiveStatus("working")).toBe(true);
    expect(isActiveStatus("failed")).toBe(false);
  });
  it("branch name slugifies", () => {
    expect(generateBranchName("Implement OAuth!!!", "a83f")).toBe("ra/implement-oauth-a83f");
  });
  it("createEvent adds timestamp", () => {
    const ev = createEvent({ type: "message", sessionId: "s1", role: "assistant", content: "hi" } as any);
    expect(ev.timestamp).toBeDefined();
    expect(ev.type).toBe("message");
  });
});

describe("event raw preservation", () => {
  it("keeps raw field", () => {
    const ev = createEvent({ type: "tool.started", sessionId: "s1", timestamp: new Date().toISOString(), tool: { name: "bash" }, raw: { foo: 1 } } as any);
    expect((ev as any).raw.foo).toBe(1);
  });
});
