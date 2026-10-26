import { describe, expect, it } from "vitest";
import { buildGrokArgs, parseGrokModelsList, parseGrokVersion } from "../src/drivers/grok/driver.js";
import { parseGrokLine } from "../src/drivers/grok/parser.js";

const base = { sessionId: "s1", cwd: "/repo", prompt: "summarize this module" };

describe("buildGrokArgs", () => {
  it("asks for the Messages stream and leaves the prompt unchanged", () => {
    expect(buildGrokArgs(base)).toEqual([
      "--output-format",
      "streaming-messages-json",
      "--always-approve",
      "--verbatim",
      "--single",
      "summarize this module",
    ]);
  });

  it("forwards model, effort, resume and a fork of that resume", () => {
    expect(
      buildGrokArgs({
        ...base,
        model: "grok-4.7",
        effort: "high",
        resumeSessionId: "abc123",
        fork: true,
        passthrough: ["--max-turns", "4"],
      }),
    ).toEqual([
      "--output-format",
      "streaming-messages-json",
      "--always-approve",
      "--verbatim",
      "--model",
      "grok-4.7",
      "--reasoning-effort",
      "high",
      "--resume",
      "abc123",
      "--fork-session",
      "--single",
      "summarize this module",
      "--max-turns",
      "4",
    ]);
  });

  it("sends max as xhigh because grok 1.0.70 rejects max", () => {
    const args = buildGrokArgs({ ...base, effort: "max" });
    expect(args).toContain("--reasoning-effort");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("xhigh");
  });

  it("does not fork a new session", () => {
    expect(buildGrokArgs({ ...base, fork: true })).not.toContain("--fork-session");
  });

  it("glues a dash-leading prompt to --single", () => {
    const args = buildGrokArgs({ ...base, prompt: "--help me" });
    expect(args).toContain("--single=--help me");
    expect(args).not.toContain("--single");
  });
});

describe("parseGrokLine", () => {
  it("records the native session id from init", () => {
    const events = parseGrokLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc123", model: "grok-4.7" }),
      "s1",
    );
    expect(events.map((event) => event.type)).toEqual(["session.started", "usage.updated"]);
    expect(events[0]).toMatchObject({ type: "session.started", nativeSessionId: "abc123" });
    expect(events[1]).toMatchObject({ type: "usage.updated", usage: { model: "grok-4.7" } });
  });

  it("emits assistant text and a tool start from one message", () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read." },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "src/main.rs" } },
          ],
        },
      }),
      "s1",
    );
    expect(events.map((event) => event.type)).toEqual(["tool.started", "message", "text.delta"]);
    expect(events[0]).toMatchObject({
      type: "tool.started",
      tool: { name: "read_file", id: "call_1", input: { path: "src/main.rs" } },
    });
    expect(events[1]).toMatchObject({ type: "message", content: "Let me read." });
  });

  it("completes a tool from the user result", () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "fn main() {}", is_error: false }],
        },
      }),
      "s1",
    );
    expect(events).toMatchObject([
      { type: "tool.completed", tool: { id: "call_1", output: "fn main() {}", success: true } },
    ]);
  });

  it("closes a successful turn with usage and completion", () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Here's a summary",
        total_cost_usd: 0.0127,
        usage: {
          input_tokens: 812,
          output_tokens: 210,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 1,
        },
        session_id: "abc123",
      }),
      "s1",
    );
    expect(events.map((event) => event.type)).toEqual(["usage.updated", "message", "session.completed"]);
    expect(events[0]).toMatchObject({
      type: "usage.updated",
      usage: { inputTokens: 812, outputTokens: 210, cachedTokens: 5, cost: 0.0127 },
    });
    expect(events[2]).toMatchObject({ type: "session.completed", reason: "success" });
  });

  it("fails a result whose subtype starts with error", () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Couldn't start session"],
      }),
      "s1",
    );
    expect(events).toMatchObject([{ type: "session.failed", error: "Couldn't start session" }]);
  });

  it("uses a Grok fallback when an error result carries no text", () => {
    const events = parseGrokLine(
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false }),
      "s1",
    );
    expect(events).toMatchObject([{ type: "session.failed", error: "Grok execution failed" }]);
  });

  it("ignores a line that is not JSON", () => {
    expect(parseGrokLine("mise by @jdx", "s1")).toEqual([]);
  });
});

describe("parseGrokModelsList", () => {
  it("skips the installer banner and marks the default model", () => {
    const stdout = [
      "mise by @jdx",
      "You are logged in with grok.com.",
      "",
      "Default model: grok-4.7",
      "",
      "Available models:",
      "  * grok-4.7 (default)",
      "  - grok-4.7-build-fast",
      "  - grok-4.6",
    ].join("\n");

    expect(parseGrokModelsList(stdout)).toEqual([
      {
        provider: "xai",
        displayName: "xAI",
        models: [
          { id: "grok-4.7", name: "grok-4.7", provider: "xai", isDefault: true, supportsThinking: true },
          { id: "grok-4.7-build-fast", name: "grok-4.7-build-fast", provider: "xai", isDefault: false, supportsThinking: true },
          { id: "grok-4.6", name: "grok-4.6", provider: "xai", isDefault: false, supportsThinking: true },
        ],
      },
    ]);
  });

  it("returns nothing when the list header never arrives", () => {
    expect(parseGrokModelsList("not logged in\n")).toEqual([]);
  });
});

describe("parseGrokVersion", () => {
  it("reads the version line under a mise banner", () => {
    expect(parseGrokVersion("mise by @jdx\ngrok 1.0.70 (f50904eaee6c) [stable]\n")).toBe("1.0.70");
  });

  it("returns undefined when grok did not print a version", () => {
    expect(parseGrokVersion("mise by @jdx\n")).toBeUndefined();
  });
});
