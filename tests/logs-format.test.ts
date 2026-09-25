import { describe, expect, it } from "vitest";
import { formatEvent } from "../src/cli/commands/logs.js";

describe("formatEvent", () => {
  it("prints full assistant and user messages", () => {
    const content = "m".repeat(1200);

    for (const role of ["assistant", "user"]) {
      const formatted = formatEvent({
        type: "message",
        timestamp: "2026-09-25T12:00:00.000Z",
        role,
        content,
      });

      expect(formatted.endsWith(content)).toBe(true);
    }
  });

  it("keeps tool.completed output truncated to 200 characters", () => {
    const output = "x".repeat(300);
    const formatted = formatEvent({
      type: "tool.completed",
      timestamp: "2026-09-25T12:00:00.000Z",
      tool: { name: "read", success: true, output },
    });

    expect(formatted.endsWith(output.slice(0, 200))).toBe(true);
    expect(formatted).not.toContain(output);
  });
});
