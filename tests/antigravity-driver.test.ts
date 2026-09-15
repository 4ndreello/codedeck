import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAntigravityArgs,
  parseAntigravityModelsList,
  AntigravityDriver,
  alignAntigravityLogOffset,
  replayAntigravityOutput,
} from "../src/drivers/antigravity/driver.js";
import { createAntigravityParser, parseAntigravityLine } from "../src/drivers/antigravity/parser.js";
import type { StartOptions } from "../src/core/driver.js";
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

  it("keeps a dash-leading prompt attached to -p", () => {
    const args = buildAntigravityArgs({ ...base, prompt: "--help is a flag" });
    expect(args).toContain("-p=--help is a flag");
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

  it("fails a successful result with an empty response when no deltas were seen", () => {
    const events = parse(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-uuid-1", status: "SUCCESS", response: "" },
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
    expect((events[0] as any).error).toMatch(/empty|whitespace/i);
    expect((events[0] as any).error).toMatch(/text deltas/i);
  });

  it("fails a successful result with a whitespace-only response when no deltas were seen", () => {
    const events = parse(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-uuid-1", status: "SUCCESS", response: " \n\t" },
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
    expect((events[0] as any).error).toMatch(/empty|whitespace/i);
    expect((events[0] as any).error).toMatch(/text deltas/i);
  });

  it("uses accumulated text.delta chunks when the successful result response is empty", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-uuid-1",
          step_type: "agent_response",
          text_delta: "Hello, ",
        },
      }),
      S,
    );
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-uuid-1",
          step_type: "agent_response",
          text_delta: "World!",
        },
      }),
      S,
    );

    const events = streamParser(
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conv-uuid-1", status: "SUCCESS", response: "" },
      }),
      S,
    );

    expect(events.map((event) => event.type)).toEqual(["message", "session.completed"]);
    expect((events[0] as any).content).toBe("Hello, World!");
  });

  it("uses accumulated text.delta chunks when the result response is whitespace", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Hello, World!" },
      }),
      S,
    );

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: " \n\t" } }),
      S,
    );

    expect(events.map((event) => event.type)).toEqual(["message", "session.completed"]);
    expect((events[0] as any).content).toBe("Hello, World!");
  });

  it("prefers a non-empty result response over accumulated deltas", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "final" } }),
      S,
    );

    expect((events.find((event) => event.type === "message") as any).content).toBe("final");

    const afterResult = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(afterResult.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("fails when only whitespace text deltas were seen", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: " \n\t" },
      }),
      S,
    );

    const events = streamParser(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "" },
      }),
      S,
    );

    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
    expect((events[0] as any).error).toContain("no usable text deltas");
  });

  it("clears accumulated text after an empty-result failure", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: " \n" },
      }),
      S,
    );
    const firstResult = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    const secondResult = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );

    expect(firstResult.map((event) => event.type)).toEqual(["session.failed"]);
    expect(secondResult.map((event) => event.type)).toEqual(["session.failed"]);
    expect((secondResult[0] as any).error).toContain("no text deltas");
  });

  it("clears accumulated text when a new init event starts", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );
    streamParser(JSON.stringify({ event: "init", conversation_id: "new-conversation" }), S);

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("clears accumulated text after an error result", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );
    streamParser(
      JSON.stringify({ event: "result", result: { status: "ERROR", error: "failed" } }),
      S,
    );

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("clears accumulated text after a generic error line", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );
    streamParser(JSON.stringify({ error: "failed" }), S);

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("marks text truncated when accumulated output exceeds the safety limit", () => {
    const streamParser = createAntigravityParser();
    const oversized = "x".repeat(8 * 1024 * 1024 + 10);
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: oversized },
      }),
      S,
    );

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    const content = (events.find((event) => event.type === "message") as any).content as string;

    expect(content).toMatch(/^\[truncated 10 characters\]\n/);
    expect(content.endsWith("x".repeat(8 * 1024 * 1024))).toBe(true);
  });

  it("does not retain a lone surrogate at the accumulated output boundary", () => {
    const streamParser = createAntigravityParser();
    const cap = 8 * 1024 * 1024;
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "x".repeat(9) + "\ud83d" },
      }),
      S,
    );
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "\ude00" + "y".repeat(cap - 1) },
      }),
      S,
    );

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    const content = (events.find((event) => event.type === "message") as any).content as string;

    expect(content).toBe(`[truncated 11 characters]\n${"y".repeat(cap - 1)}`);
    expect(content.charCodeAt("[truncated 11 characters]\n".length)).not.toBe(0xde00);
  });

  it("keeps accumulated responses isolated by session", () => {
    const streamParser = createAntigravityParser();
    const delta = (sessionId: string, text: string) =>
      streamParser(
        JSON.stringify({
          event: "step_update",
          step_update: { step_type: "agent_response", text_delta: text },
        }),
        sessionId,
      );
    const result = (sessionId: string) =>
      streamParser(
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
        sessionId,
      );

    delta("session-a", "AAA");
    delta("session-b", "BBB");

    expect((result("session-a").find((event) => event.type === "message") as any).content).toBe("AAA");
    expect((result("session-b").find((event) => event.type === "message") as any).content).toBe("BBB");
  });

  it("resets accumulated text for a new turn", () => {
    const streamParser = createAntigravityParser();
    streamParser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );
    streamParser.reset(S);

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );

    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("accumulates plain-text output for an empty result response", () => {
    const streamParser = createAntigravityParser();
    expect(streamParser("Here is the plain-text answer.", S)[0]?.type).toBe("text.delta");

    const events = streamParser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );

    expect((events.find((event) => event.type === "message") as any).content).toBe(
      "Here is the plain-text answer.\n",
    );
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

  it("strips spinner-prefixed banner output", () => {
    const providers = parseAntigravityModelsList(
      "⠋ Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n",
    );
    const ids = providers.flatMap((p) => p.models.map((m) => m.id));
    expect(ids).toEqual(["gemini-3.8-flash-high"]);
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

  it("replays only the consumed complete output before reattach", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-replay-"));
    const stdoutPath = path.join(tempDir, "session.ndjson");
    const firstLine = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "Hello, " },
    });
    const secondLine = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "World!" },
    });
    const thirdLine = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: " Again!" },
    });
    const tailLine = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: " Do not replay." },
    });
    const output = `${firstLine}\n${secondLine}\n${thirdLine}\n${tailLine}\n`;
    fs.writeFileSync(stdoutPath, output);

    try {
      const streamParser = createAntigravityParser();
      replayAntigravityOutput(
        stdoutPath,
        Buffer.byteLength(`${firstLine}\n${secondLine}\n${thirdLine}\n`),
        streamParser,
        S,
      );
      const events = streamParser(
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
        S,
      );

      expect((events.find((event) => event.type === "message") as any).content).toBe("Hello, World! Again!");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discards an unterminated replay fragment at a mid-line offset", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-replay-fragment-"));
    const stdoutPath = path.join(tempDir, "session.ndjson");
    const firstLine = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "Hello, " },
    });
    const partialPlainText = "do not replay this partial line";
    fs.writeFileSync(stdoutPath, `${firstLine}\n${partialPlainText}\n`);

    try {
      const streamParser = createAntigravityParser();
      const firstLineEnd = Buffer.byteLength(`${firstLine}\n`);
      replayAntigravityOutput(stdoutPath, firstLineEnd + 5, streamParser, S);
      const events = streamParser(
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
        S,
      );

      expect((events.find((event) => event.type === "message") as any).content).toBe("Hello, ");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("aligns reattach offsets to the start of a complete line", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-offset-"));
    const stdoutPath = path.join(tempDir, "session.ndjson");
    const firstLine = JSON.stringify({ event: "step_update", step_update: { text_delta: "first" } });
    const secondLine = JSON.stringify({ event: "step_update", step_update: { text_delta: "second" } });
    fs.writeFileSync(stdoutPath, `${firstLine}\n${secondLine}\n`);

    try {
      const lineStart = Buffer.byteLength(`${firstLine}\n`);
      expect(alignAntigravityLogOffset(stdoutPath, lineStart + 5)).toBe(lineStart);
      expect(alignAntigravityLogOffset(stdoutPath, lineStart)).toBe(lineStart);
      expect(alignAntigravityLogOffset(stdoutPath, fs.statSync(stdoutPath).size + 1)).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resets parser state before attaching a session", async () => {
    const driver = new AntigravityDriver();
    const parser = (driver as any).parser as ReturnType<typeof createAntigravityParser>;
    parser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );

    await driver.attach({ sessionId: S });

    const events = parser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("resets parser state when stopping a session", async () => {
    const driver = new AntigravityDriver();
    const parser = (driver as any).parser as ReturnType<typeof createAntigravityParser>;
    parser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );
    (driver as any).handles.set(S, { stop: async () => {} });

    await driver.stop({ id: S } as any);

    const events = parser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(events.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("resets parser state when an event stream reaches a terminal event", async () => {
    const driver = new AntigravityDriver();
    const parser = (driver as any).parser as ReturnType<typeof createAntigravityParser>;
    parser(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "stale" },
      }),
      S,
    );
    (driver as any).handles.set(S, {
      events: async function* () {
        yield { type: "session.failed", sessionId: S, timestamp: new Date().toISOString(), error: "done" };
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of driver.events({ id: S } as any)) events.push(event);
    expect(events).toHaveLength(1);

    const afterTerminal = parser(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
      S,
    );
    expect(afterTerminal.map((event) => event.type)).toEqual(["session.failed"]);
  });

  it("resets parser state before starting a new turn", async () => {
    class NoopAntigravityDriver extends AntigravityDriver {
      protected override getCommand(): string {
        return process.execPath;
      }

      protected override buildArgs(_options: StartOptions): string[] {
        return ["-e", ""];
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-start-"));
    const previousRunAgentDir = process.env.RUN_AGENT_DIR;
    const previousNoScope = process.env.CODEDECK_NO_SCOPE;
    process.env.RUN_AGENT_DIR = tempDir;
    process.env.CODEDECK_NO_SCOPE = "1";
    let session: Awaited<ReturnType<AntigravityDriver["start"]>> | undefined;

    try {
      const driver = new NoopAntigravityDriver();
      const parser = (driver as any).parser as ReturnType<typeof createAntigravityParser>;
      parser(
        JSON.stringify({
          event: "step_update",
          step_update: { step_type: "agent_response", text_delta: "stale" },
        }),
        S,
      );

      session = await driver.start({ ...base, cwd: tempDir });
      const afterStart = parser(
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
        S,
      );
      expect(afterStart.map((event) => event.type)).toEqual(["session.failed"]);

      const emitted: AgentEvent[] = [];
      for await (const event of driver.events(session)) emitted.push(event);
      expect(emitted.at(-1)?.type).toBe("session.completed");
      await driver.stop(session);
    } finally {
      if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previousRunAgentDir;
      if (previousNoScope === undefined) delete process.env.CODEDECK_NO_SCOPE;
      else process.env.CODEDECK_NO_SCOPE = previousNoScope;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the session stdout path when attaching", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-attach-"));
    const previousRunAgentDir = process.env.RUN_AGENT_DIR;
    process.env.RUN_AGENT_DIR = tempDir;
    const stdoutPath = path.join(tempDir, "logs", `${S}.ndjson`);
    const firstLine = JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "from stdout" },
    });
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.writeFileSync(stdoutPath, `${firstLine}\n`);

    try {
      const driver = new AntigravityDriver();
      await driver.attach({ sessionId: S, logOffset: Buffer.byteLength(`${firstLine}\n`) });
      const parser = (driver as any).parser as ReturnType<typeof createAntigravityParser>;
      const events = parser(
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }),
        S,
      );

      expect((events.find((event) => event.type === "message") as any).content).toBe("from stdout");
    } finally {
      if (previousRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
      else process.env.RUN_AGENT_DIR = previousRunAgentDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
