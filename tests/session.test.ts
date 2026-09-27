import { randomBytes } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn() };
});

// Test session logic without DB dependency: test pure helpers
import { generateSessionId, isTerminalStatus, isActiveStatus, generateBranchName } from "../src/core/session.js";
import { createEvent } from "../src/core/events.js";

describe("session helpers", () => {
  afterEach(() => {
    vi.mocked(randomBytes).mockReset();
    vi.restoreAllMocks();
  });

  it("generates a 16-character lowercase hex id from eight crypto bytes", () => {
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from("0123456789abcdef", "hex"));

    const id = generateSessionId();

    expect(randomBytes).toHaveBeenCalledWith(8);
    expect(id).toBe("0123456789abcdef");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not fall back to Math.random when crypto fails", () => {
    const cryptoError = new Error("crypto unavailable");
    vi.mocked(randomBytes).mockImplementationOnce(() => { throw cryptoError; });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(generateSessionId).toThrow(cryptoError);
    expect(random).not.toHaveBeenCalled();
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
