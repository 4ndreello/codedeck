import { describe, it, expect } from "vitest";
import { getPaths } from "../src/config/paths.js";
import fs from "node:fs";

describe("IPC protocol", () => {
  it("paths are under ~/.run-agent", () => {
    const p = getPaths();
    expect(p.base).toContain(".run-agent");
    expect(p.daemonSock).toContain("daemon.sock");
    expect(p.db).toContain("run-agent.db");
  });

  it("framing is JSON + newline", () => {
    const req = { id: "abc", method: "session.list", params: { all: true } };
    const line = JSON.stringify(req) + "\n";
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(parsed.method).toBe("session.list");
  });
});

describe("state machine", () => {
  it("terminal states", async () => {
    const { isTerminalStatus, isActiveStatus } = await import("../src/core/session.js");
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("stopped")).toBe(true);
    expect(isTerminalStatus("working")).toBe(false);
    expect(isActiveStatus("working")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
  });
});
