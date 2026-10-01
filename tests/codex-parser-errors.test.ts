import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/drivers/codex/parser.js";

describe("Codex error frames", () => {
  it.each([
    ["reconnect", "Reconnecting... 2/5 (stream disconnected before completion: failed to lookup address information: Try again)"],
    ["skill budget", "Skill descriptions were shortened because the context budget was exceeded."],
    ["websocket fallback", "Falling back from WebSockets to HTTPS transport..."],
  ])("emits a non-terminal error event for %s notices", (_name, message) => {
    const raw = { type: "error", message };
    const events = parseCodexLine(JSON.stringify(raw), "session-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      sessionId: "session-1",
      error: message,
      raw,
    });
    expect(events.some((event) => event.type === "session.failed")).toBe(false);
  });

  it.each([
    ["turn.failed", { message: "Codex turn failed" }],
    ["thread.failed", "Codex turn failed"],
  ])(
    "keeps %s as a terminal session failure",
    (type, error) => {
      const raw = { type, error };
      const events = parseCodexLine(JSON.stringify(raw), "session-1");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "session.failed",
        sessionId: "session-1",
        error: "Codex turn failed",
        raw,
      });
    },
  );
});
