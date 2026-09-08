import { describe, it, expect } from "vitest";
import {
  buildAntigravityArgs,
  parseAntigravityModelsList,
  AntigravityDriver,
} from "../src/drivers/antigravity/driver.js";
import { parseAntigravityLine } from "../src/drivers/antigravity/parser.js";
import type { AgentEvent } from "../src/core/events.js";

const S = "test-session";
const base = { sessionId: S, prompt: "do something", cwd: "/workspace" };

describe("buildAntigravityArgs", () => {
  it("builds default headless flags with auto-permissions and prompt", () => {
    const args = buildAntigravityArgs(base);
    expect(args).toEqual([
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "-p=do something",
    ]);
  });

  it("attaches the prompt to -p so it cannot swallow the next flag", () => {
    const args = buildAntigravityArgs(base);
    expect(args).not.toContain("-p");
    expect(args[args.length - 1]).toBe("-p=do something");
  });

  it("adds --conversation on resume", () => {
    const args = buildAntigravityArgs({ ...base, resumeSessionId: "conv-1234" });
    expect(args).toContain("--conversation");
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-1234");
  });

  it("adds --model when specified", () => {
    const args = buildAntigravityArgs({ ...base, model: "gemini-3.8-flash-high" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  });

  it("forwards low and medium effort verbatim", () => {
    expect(buildAntigravityArgs({ ...base, effort: "low" })).toContain("low");
    expect(buildAntigravityArgs({ ...base, effort: "medium" })).toContain("medium");
  });

  it("clamps xhigh and max reasoning effort to high for agy validation", () => {
    const argsXHigh = buildAntigravityArgs({ ...base, effort: "xhigh" });
    expect(argsXHigh[argsXHigh.indexOf("--effort") + 1]).toBe("high");

    const argsMax = buildAntigravityArgs({ ...base, effort: "max" });
    expect(argsMax[argsMax.indexOf("--effort") + 1]).toBe("high");
  });
});

describe("parseAntigravityLine", () => {
  const parse = (line: string): AgentEvent[] => parseAntigravityLine(line, S);

  it("maps init event to session.started with nativeSessionId", () => {
    const line = JSON.stringify({
      event: "init",
      conversation_id: "conv-uuid-1",
      init: { cwd: "/workspace", tools: ["run_command"], permission_mode: "always-proceed" },
    });
    const events = parse(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session.started");
    expect((events[0] as any).nativeSessionId).toBe("conv-uuid-1");
  });

  it("maps agent_response step_update to text.delta", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-uuid-1",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "Hello, World!\n",
      },
    });
    const events = parse(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("text.delta");
    expect((events[0] as any).delta).toBe("Hello, World!\n");
    expect((events[0] as any).nativeSessionId).toBe("conv-uuid-1");
  });

  it("maps active tool step_update to tool.started", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-uuid-1",
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "echo 123" },
        },
      },
    });
    const events = parse(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.started");
    const toolEv = events[0] as any;
    expect(toolEv.tool.name).toBe("run_command");
    expect(toolEv.tool.id).toBe("2");
    expect(toolEv.tool.input).toEqual({ CommandLine: "echo 123" });
  });

  it("maps done tool step_update to tool.completed", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-uuid-1",
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          output: "123\n",
        },
      },
    });
    const events = parse(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.completed");
    const toolEv = events[0] as any;
    expect(toolEv.tool.name).toBe("run_command");
    expect(toolEv.tool.output).toBe("123\n");
    expect(toolEv.tool.success).toBe(true);
  });

  it("maps error tool step_update to tool.completed with failure", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-uuid-1",
        step_index: 2,
        state: "ERROR",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          error: "command failed with exit code 1",
        },
      },
    });
    const events = parse(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.completed");
    const toolEv = events[0] as any;
    expect(toolEv.tool.success).toBe(false);
    expect(toolEv.tool.error).toBe("command failed with exit code 1");
  });

  it("maps usage update in step_update to usage.updated", () => {
    const line = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-uuid-1",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        usage: {
          input_tokens: 1500,
          output_tokens: 300,
          cache_read_tokens: 800,
        },
      },
    });
    const events = parse(line);
    const usageEv = events.find((e) => e.type === "usage.updated") as any;
    expect(usageEv).toBeDefined();
    expect(usageEv.usage.inputTokens).toBe(1500);
    expect(usageEv.usage.outputTokens).toBe(300);
    expect(usageEv.usage.cachedTokens).toBe(800);
  });

  it("maps SUCCESS result event to message, usage, and session.completed", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-uuid-1",
        status: "SUCCESS",
        response: "Task complete.\n",
        usage: {
          input_tokens: 2000,
          output_tokens: 400,
          cache_read_tokens: 1000,
        },
      },
    });
    const events = parse(line);
    expect(events.map((e) => e.type)).toEqual(["usage.updated", "message", "session.completed"]);
    const msgEv = events.find((e) => e.type === "message") as any;
    expect(msgEv.content).toBe("Task complete.\n");
    expect(msgEv.role).toBe("assistant");

    const completedEv = events.find((e) => e.type === "session.completed") as any;
    expect(completedEv.reason).toBe("completed");
    expect(completedEv.exitCode).toBe(0);
  });

  it("maps ERROR result event to session.failed", () => {
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-uuid-1",
        status: "ERROR",
        error: "Quota exceeded for model gemini-3.8-flash",
      },
    });
    const events = parse(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session.failed");
    const failedEv = events[0] as any;
    expect(failedEv.error).toContain("Quota exceeded");
    expect(failedEv.failure).toBeDefined();
  });

  it("returns empty array for invalid JSON or unrecognized event", () => {
    expect(parse("")).toEqual([]);
    expect(parse("random non json text")).toEqual([]);
    expect(parse(JSON.stringify({ event: "unknown_future_event" }))).toEqual([]);
  });
});

describe("parseAntigravityModelsList", () => {
  // Mirrors real `agy models` output: a banner line plus TAB-separated rows.
  const stdout = [
    "Fetching available models...",
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    "",
  ].join("\n");

  it("splits TAB-separated id and display name", () => {
    const providers = parseAntigravityModelsList(stdout);
    const ids = providers.flatMap((p) => p.models.map((m) => m.id));
    expect(ids).toEqual(["gemini-3.8-flash-high", "claude-sonnet-4-6", "gpt-oss-120b-medium"]);
    const names = providers.flatMap((p) => p.models.map((m) => m.name));
    expect(names).toEqual([
      "Gemini 3.8 Flash (High)",
      "Claude Sonnet 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ]);
  });

  it("drops the banner line instead of listing it as a model", () => {
    const providers = parseAntigravityModelsList(stdout);
    const ids = providers.flatMap((p) => p.models.map((m) => m.id));
    expect(ids.every((id) => !/fetching/i.test(id))).toBe(true);
  });
});

describe("AntigravityDriver", () => {
  it("declares expected capabilities", () => {
    const driver = new AntigravityDriver();
    const caps = driver.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.approvals).toBe(true);
    expect(caps.usage).toBe(true);
    expect(caps.cost).toBe(false);
    expect(caps.modelSelection).toBe(true);
    expect(caps.interrupt).toBe(true);
  });
});
