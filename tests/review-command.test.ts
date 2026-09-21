import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { parseReviewPort, registerReviewCommand } from "../src/cli/commands/review.js";

describe("parseReviewPort", () => {
  it("defaults to 3100", () => {
    expect(parseReviewPort(undefined)).toBe(3100);
  });

  it("accepts a valid port", () => {
    expect(parseReviewPort("8080")).toBe(8080);
  });

  it("rejects non-numeric, zero, and out-of-range ports", () => {
    for (const raw of ["abc", "0", "-1", "65536", "3.5", ""]) {
      expect(() => parseReviewPort(raw)).toThrow("--port must be a positive integer");
    }
  });
});

describe("registerReviewCommand", () => {
  it("registers review instead of the removed web command", () => {
    const program = new Command();
    registerReviewCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual(["review"]);
    expect(program.commands[0].description()).toContain("local review");
  });
});
