import { describe, it, expect } from "vitest";

import { parseOmpLine } from "../src/drivers/omp/driver.js";
import { synthesizeTerminalEvent } from "../src/drivers/terminal.js";

// Every frame below is a VERBATIM line captured from `omp -p --mode json`
// (omp 18.0.7), not an invented shape. The driver previously ran omp under
// `--mode rpc`, which is the interactive protocol server: it printed a
// handshake, waited for request frames on stdin and exited without ever
// running a turn. Nothing here was reachable, so nothing here was mapped.

const S = "test-session";
const one = (line: string) => {
  const evs = parseOmpLine(line, S);
  expect(evs).toHaveLength(1);
  return evs[0] as any;
};

describe("parseOmpLine — omp --mode json frames", () => {
  it("takes the native session id from the opening session frame", () => {
    // `--resume` needs this id, so send() is broken if the frame is not mapped.
    const ev = one(
      '{"type":"session","version":3,"id":"01a0431c-76be-70f2-b85d-bd8cf3b1852f","timestamp":"2026-08-27T12:05:34.014Z","cwd":"/tmp"}',
    );
    expect(ev.type).toBe("session.started");
    expect(ev.nativeSessionId).toBe("01a0431c-76be-70f2-b85d-bd8cf3b1852f");
  });

  it("reads streamed text from the NESTED assistantMessageEvent", () => {
    // Streaming text is not a top-level `text_delta` frame — it is wrapped in
    // message_update, which is why the top-level branch alone caught nothing.
    const ev = one(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"OK"}}',
    );
    expect(ev.type).toBe("text.delta");
    expect(ev.delta).toBe("OK");
  });

  it("ignores nested events that are not text deltas", () => {
    expect(
      parseOmpLine(
        '{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}',
        S,
      ),
    ).toEqual([]);
  });

  it("joins ONLY the text parts of a finished assistant message", () => {
    // `content` mixes part kinds. Selecting by `type === "text"` is what keeps
    // a non-text part out of the message body — dropping the check lets any
    // part that happens to carry a `text` field through, and the thinking part
    // alone does not prove that (its payload lives in `thinkingSignature`, so
    // `part.text` is undefined and join() would swallow it either way).
    const ev = one(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", thinkingSignature: '{"encrypted_content":"blob"}' },
            { type: "redacted_reasoning", text: "SHOULD-NOT-APPEAR" },
            { type: "text", text: "OK" },
          ],
        },
      }),
    );
    expect(ev.type).toBe("message");
    expect(ev.content).toBe("OK");
  });

  it("does not emit a message for a user message_end", () => {
    expect(
      parseOmpLine(
        '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"oi"}]}}',
        S,
      ),
    ).toEqual([]);
  });

  it("maps tool execution start with its name and arguments", () => {
    const ev = one(
      '{"type":"tool_execution_start","toolCallId":"call_abc|fc_abc","toolName":"bash","args":{"command":"echo oi"},"intent":"echo"}',
    );
    expect(ev.type).toBe("tool.started");
    expect(ev.tool.name).toBe("bash");
    expect(ev.tool.id).toBe("call_abc|fc_abc");
    expect(ev.tool.input).toEqual({ command: "echo oi" });
  });

  it("maps tool execution end, and isError decides success", () => {
    const ok = one(
      '{"type":"tool_execution_end","toolCallId":"call_abc","toolName":"bash","result":{"content":[]},"isError":false}',
    );
    expect(ok.type).toBe("tool.completed");
    expect(ok.tool.success).toBe(true);

    const bad = one(
      '{"type":"tool_execution_end","toolCallId":"call_abc","toolName":"bash","result":{"content":[]},"isError":true}',
    );
    expect(bad.tool.success).toBe(false);
  });

  it("treats agent_end as the terminal frame", () => {
    const ev = one('{"type":"agent_end","messages":[]}');
    expect(ev.type).toBe("session.completed");
  });

  it("returns nothing for a line that is not JSON", () => {
    expect(parseOmpLine("Working...", S)).toEqual([]);
  });
});

describe("parseOmpLine — harness-reported error frames", () => {
  it("classifies an EPIPE error frame as harness crash, retryable", () => {
    const evs = parseOmpLine(JSON.stringify({ error: "Unhandled rejection: EPIPE: broken pipe, write" }), S);
    expect(evs).toHaveLength(1);
    const ev = evs[0];
    expect(ev.type).toBe("session.failed");
    if (ev.type === "session.failed") {
      expect(ev.failure).toMatchObject({ code: "HARNESS_CRASH", blame: "harness", retryable: true });
    }
  });
});

describe("synthesizeTerminalEvent — close without a terminal frame", () => {
  const base = { sessionId: S, harness: "OMP", hasTerminal: false, hasMessage: true, stderr: "" };

  it("emits nothing when a terminal event already exists", () => {
    expect(synthesizeTerminalEvent({ ...base, exitCode: 1, hasTerminal: true })).toBeNull();
  });

  it("non-zero exit with EPIPE stderr → harness crash, retryable", () => {
    const ev = synthesizeTerminalEvent({
      ...base,
      exitCode: 1,
      stderr: "Unhandled rejection: EPIPE: broken pipe, write\nreason: unhandled_rejection\nkind: fatal",
    });
    expect(ev?.type).toBe("session.failed");
    if (ev?.type === "session.failed") {
      expect(ev.failure).toMatchObject({ code: "HARNESS_CRASH", blame: "harness", retryable: true });
    }
  });

  it("non-zero exit without a harness signature → task failure", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: 1 });
    expect(ev?.type).toBe("session.failed");
    if (ev?.type === "session.failed") {
      expect(ev.failure).toMatchObject({ blame: "task", retryable: false });
    }
  });

  it("exit 0 with output → completed", () => {
    expect(synthesizeTerminalEvent({ ...base, exitCode: 0 })?.type).toBe("session.completed");
  });

  it("exit 0 with stderr but NO output → failed (crash), never a ghost completion", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: 0, hasMessage: false, stderr: "Unhandled rejection: EPIPE" });
    expect(ev?.type).toBe("session.failed");
    if (ev?.type === "session.failed") {
      expect(ev.failure).toMatchObject({ blame: "harness", retryable: true });
    }
  });
});
