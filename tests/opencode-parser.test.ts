import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseOpencodeLine } from "../src/drivers/opencode/parser.js";
import type { AgentEvent } from "../src/core/events.js";

const here = dirname(fileURLToPath(import.meta.url));

function parseFixture(): AgentEvent[] {
  const raw = readFileSync(join(here, "fixtures", "opencode-run.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((line) => parseOpencodeLine(line, "s1"));
}

describe("Opencode parser (real --format json schema)", () => {
  it("turns a text event into a message and a text.delta from part.text", () => {
    const line = JSON.stringify({
      type: "text",
      timestamp: 1,
      sessionID: "ses_abc123",
      part: { id: "prt_text1", type: "text", text: "no blocking defects", time: { start: 1, end: 2 } },
    });
    const evs = parseOpencodeLine(line, "s1");
    const message = evs.find((e) => e.type === "message") as any;
    const delta = evs.find((e) => e.type === "text.delta") as any;
    expect(message?.content).toBe("no blocking defects");
    expect(message?.role).toBe("assistant");
    expect(delta?.delta).toBe("no blocking defects");
  });

  it("turns a completed tool_use into tool.started (with input) and tool.completed (with output)", () => {
    const line = JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      sessionID: "ses_abc123",
      part: {
        type: "tool",
        callID: "call_diff",
        tool: "bash",
        state: { status: "completed", input: { command: "gh pr diff 20" }, output: "diff text" },
      },
    });
    const evs = parseOpencodeLine(line, "s1");
    const started = evs.find((e) => e.type === "tool.started") as any;
    const completed = evs.find((e) => e.type === "tool.completed") as any;
    expect(started?.tool.name).toBe("bash");
    expect(started?.tool.id).toBe("call_diff");
    expect(started?.tool.input).toEqual({ command: "gh pr diff 20" });
    expect(completed?.tool.name).toBe("bash");
    expect(completed?.tool.output).toBe("diff text");
    expect(completed?.tool.success).toBe(true);
  });

  it("marks an errored tool_use as failed with its error text", () => {
    const line = JSON.stringify({
      type: "tool_use",
      timestamp: 1,
      sessionID: "ses_abc123",
      part: {
        type: "tool",
        callID: "call_fail",
        tool: "bash",
        state: { status: "error", input: { command: "false" }, error: "exit code 1" },
      },
    });
    const evs = parseOpencodeLine(line, "s1");
    const completed = evs.find((e) => e.type === "tool.completed") as any;
    expect(completed?.tool.success).toBe(false);
    expect(completed?.tool.error).toBe("exit code 1");
  });

  it("turns a reasoning event into a message from part.text", () => {
    const line = JSON.stringify({
      type: "reasoning",
      timestamp: 1,
      sessionID: "ses_abc123",
      part: { type: "reasoning", text: "thinking about it" },
    });
    const evs = parseOpencodeLine(line, "s1");
    const message = evs.find((e) => e.type === "message") as any;
    expect(message?.content).toBe("thinking about it");
  });

  it("ignores step_start and empty step_finish (no events)", () => {
    const start = parseOpencodeLine(JSON.stringify({ type: "step_start", sessionID: "s", part: { type: "step-start" } }), "s1");
    const emptyFinish = parseOpencodeLine(JSON.stringify({ type: "step_finish", sessionID: "s", part: { type: "step-finish" } }), "s1");
    expect(start).toEqual([]);
    expect(emptyFinish).toEqual([]);
  });

  it("parses step_finish into incremental usage.updated with reasoning folded into output", () => {
    const line = JSON.stringify({
      type: "step_finish",
      timestamp: 1789852051989,
      sessionID: "ses_abc",
      part: {
        id: "prt_123",
        reason: "tool-calls",
        type: "step-finish",
        tokens: {
          total: 15584,
          input: 1107,
          output: 76,
          reasoning: 65,
          cache: { write: 0, read: 14336 },
        },
        cost: 0,
      },
    });
    const evs = parseOpencodeLine(line, "s1");
    expect(evs).toHaveLength(1);
    const usageEv = evs[0] as any;
    expect(usageEv.type).toBe("usage.updated");
    expect(usageEv.sessionId).toBe("s1");
    expect(usageEv.incremental).toBe(true);
    expect(usageEv.usage).toEqual({
      inputTokens: 1107,
      outputTokens: 141, // 76 + 65 (reasoning tokens billed as output)
      cachedTokens: 14336,
      cost: undefined, // cost: 0 is ignored so table fallback can price it
    });
  });

  it("preserves positive reported cost from step_finish", () => {
    const line = JSON.stringify({
      type: "step_finish",
      timestamp: 1789852051989,
      sessionID: "ses_abc",
      part: {
        tokens: { input: 100, output: 50 },
        cost: 0.0042,
      },
    });
    const evs = parseOpencodeLine(line, "s1");
    expect(evs).toHaveLength(1);
    const usageEv = evs[0] as any;
    expect(usageEv.usage.cost).toBe(0.0042);
    expect(usageEv.usage.inputTokens).toBe(100);
    expect(usageEv.usage.outputTokens).toBe(50);
  });

  it("extracts tokens and cost from root object when part lacks them", () => {
    const line = JSON.stringify({
      type: "step_finish",
      timestamp: 1789852051989,
      sessionID: "ses_abc",
      part: { type: "step-finish" },
      tokens: { input: 200, output: 40 },
      cost: 0.0015,
    });
    const evs = parseOpencodeLine(line, "s1");
    expect(evs).toHaveLength(1);
    const usageEv = evs[0] as any;
    expect(usageEv.type).toBe("usage.updated");
    expect(usageEv.incremental).toBe(true);
    expect(usageEv.usage.inputTokens).toBe(200);
    expect(usageEv.usage.outputTokens).toBe(40);
    expect(usageEv.usage.cost).toBe(0.0015);
  });

  it("ignores negative reported cost and defaults missing token fields to 0", () => {
    const line = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_abc",
      part: {
        tokens: { input: 100 },
        cost: -0.05,
      },
    });
    const evs = parseOpencodeLine(line, "s1");
    expect(evs).toHaveLength(1);
    const usageEv = evs[0] as any;
    expect(usageEv.usage.cost).toBeUndefined();
    expect(usageEv.usage.inputTokens).toBe(100);
    expect(usageEv.usage.outputTokens).toBe(0);
    expect(usageEv.usage.cachedTokens).toBe(0);
  });

  it("maps an error event to session.failed with the API message", () => {
    const line = JSON.stringify({
      type: "error",
      sessionID: "ses_x",
      error: { name: "APIError", data: { message: "Invalid API key.", statusCode: 401 } },
    });
    const evs = parseOpencodeLine(line, "s1");
    const failed = evs.find((e) => e.type === "session.failed") as any;
    expect(failed?.error).toBe("Invalid API key.");
  });

  it("captures the full transcript from a real run fixture (the regression this fixes)", () => {
    const evs = parseFixture();
    // A successful reviewer run MUST leave a message and its tool calls behind,
    // not an empty log. This is the exact symptom from the screenshot.
    expect(evs.some((e) => e.type === "message")).toBe(true);
    expect(evs.some((e) => e.type === "tool.started")).toBe(true);
    expect(evs.some((e) => e.type === "tool.completed")).toBe(true);
    const finalMessage = evs.filter((e) => e.type === "message").at(-1) as any;
    expect(finalMessage.content).toContain("no blocking defects");
  });
});
