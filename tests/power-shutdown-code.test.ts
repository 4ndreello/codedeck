import { describe, expect, it } from "vitest";
import { exitCodeForOutcome } from "../src/core/errors.js";

describe("power shutdown exit code", () => {
  it("maps interrupted+infra to exit 3", () => {
    expect(
      exitCodeForOutcome({ status: "interrupted", failure: { code: "SHUTDOWN", blame: "infra", retryable: true } }),
    ).toBe(3);
  });

  it("maps interrupted without infra blame to exit 0", () => {
    expect(exitCodeForOutcome({ status: "interrupted", failure: null })).toBe(0);
  });

  it("keeps failed mappings unchanged", () => {
    expect(
      exitCodeForOutcome({ status: "failed", failure: { code: "TASK_ERROR", blame: "task", retryable: false } }),
    ).toBe(1);
    expect(
      exitCodeForOutcome({ status: "failed", failure: { code: "HARNESS_CRASH", blame: "harness", retryable: true } }),
    ).toBe(2);
    expect(
      exitCodeForOutcome({ status: "failed", failure: { code: "SHUTDOWN", blame: "infra", retryable: true } }),
    ).toBe(3);
  });

  it("keeps orphaned and terminal-default mappings unchanged", () => {
    expect(
      exitCodeForOutcome({ status: "orphaned", failure: { code: "HARNESS_CRASH", blame: "harness", retryable: true } }),
    ).toBe(2);
    expect(exitCodeForOutcome({ status: "completed", failure: null })).toBe(0);
  });
});
