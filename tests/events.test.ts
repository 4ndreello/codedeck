import { describe, it, expect } from "vitest";
import { parseClaudeLine } from "../src/drivers/claude/parser.js";
import { parseCodexLine } from "../src/drivers/codex/parser.js";

describe("Claude parser", () => {
  it("parses system init to session.started", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "abc123", model: "claude-opus-5", cwd: "/tmp" });
    const evs = parseClaudeLine(line, "sess1");
    expect(evs.some(e => e.type === "session.started")).toBe(true);
    const s = evs.find(e => e.type === "session.started") as any;
    expect(s.nativeSessionId).toBe("abc123");
  });

  it("parses assistant message", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] }, session_id: "abc" });
    const evs = parseClaudeLine(line, "sess1");
    expect(evs.some(e => e.type === "message" && (e as any).content === "hello")).toBe(true);
  });

  it("parses result completed with usage", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
    const evs = parseClaudeLine(line, "s1");
    expect(evs.some(e => e.type === "usage.updated")).toBe(true);
    expect(evs.some(e => e.type === "session.completed")).toBe(true);
  });

  it("preserves raw", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const evs = parseClaudeLine(line, "s1");
    expect((evs[0] as any).raw).toBeDefined();
  });
});

describe("Codex parser", () => {
  it("parses thread.started", () => {
    const evs = parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "tid123" }), "s1");
    expect(evs[0].type).toBe("session.started");
    expect((evs[0] as any).nativeSessionId).toBe("tid123");
  });

  it("parses item.completed agent_message", () => {
    const evs = parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "4" } }), "s1");
    expect(evs.some(e => e.type === "message" && (e as any).content === "4")).toBe(true);
  });

  it("parses turn.completed usage", () => {
    const evs = parseCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } }), "s1");
    expect(evs.some(e => e.type === "usage.updated")).toBe(true);
  });
});
