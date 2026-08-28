import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/core/session.js";
import { formatWaitResult, registerWaitCommand } from "../src/cli/commands/wait.js";

function session(status: Session["status"]): Session {
  const now = new Date();
  return {
    id: "e395",
    agent: "claude",
    status,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now,
  };
}

describe("wait command", () => {
  it("registers wait with an id argument and JSON output", () => {
    const program = new Command();
    registerWaitCommand(program);
    const wait = program.commands.find((command) => command.name() === "wait");

    expect(wait).toBeDefined();
    expect(wait?.registeredArguments[0]?.name()).toBe("id");
    expect(wait?.options.some((option) => option.long === "--json")).toBe(true);
  });

  it("renders only the terminal result", () => {
    expect(formatWaitResult(session("completed"))).toBe("✓ Session e395 completed");
    expect(formatWaitResult(session("stopped"))).toBe("✓ Session e395 stopped");
  });
});
