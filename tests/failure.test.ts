import { describe, it, expect } from "vitest";
import { classifyFailure, exitCodeForOutcome } from "../src/core/errors.js";

describe("classifyFailure", () => {
  it("reads EPIPE / unhandled rejection as a retryable harness crash", () => {
    // The exact crash shape from the field: omp died inside a sub-agent.
    const f = classifyFailure("Unhandled rejection: EPIPE: broken pipe, write\nreason: unhandled_rejection\nkind: fatal");
    expect(f).toMatchObject({ code: "HARNESS_CRASH", blame: "harness", retryable: true, reason: "unhandled_rejection" });
  });

  it("matches EPIPE on its own", () => {
    expect(classifyFailure("EPIPE: broken pipe, write")).toMatchObject({
      code: "HARNESS_CRASH",
      blame: "harness",
      retryable: true,
    });
  });

  it("reads fatal signals (name or 128+N exit code) as harness crash", () => {
    expect(classifyFailure("", null, "SIGSEGV")).toMatchObject({ blame: "harness", signal: "SIGSEGV" });
    expect(classifyFailure("", 139)).toMatchObject({ blame: "harness", signal: "SIGSEGV" });
  });

  it("defaults an unknown non-zero exit to a non-retryable task error", () => {
    expect(classifyFailure("tests failed", 1)).toMatchObject({
      code: "TASK_ERROR",
      blame: "task",
      retryable: false,
    });
  });

  it("treats a signature-less stream loss as harness (retryable)", () => {
    expect(classifyFailure("")).toMatchObject({ code: "UNKNOWN", blame: "harness", retryable: true });
  });
});

describe("exitCodeForOutcome", () => {
  it("maps 0 completed / 1 task / 2 harness / 3 infra", () => {
    expect(exitCodeForOutcome({ status: "completed" })).toBe(0);
    expect(exitCodeForOutcome({ status: "stopped" })).toBe(0);
    expect(exitCodeForOutcome({ status: "failed", failure: { code: "TASK_ERROR", blame: "task", retryable: false } })).toBe(1);
    expect(exitCodeForOutcome({ status: "failed", failure: { code: "HARNESS_CRASH", blame: "harness", retryable: true } })).toBe(2);
    expect(exitCodeForOutcome({ status: "failed", failure: { code: "SPAWN_FAILED", blame: "infra", retryable: false } })).toBe(3);
    // No failure info on a failed session: assume task (1), never 0.
    expect(exitCodeForOutcome({ status: "failed" })).toBe(1);
  });
});
