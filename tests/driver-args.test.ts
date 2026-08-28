import { describe, it, expect } from "vitest";

import { buildCodexArgs, parseCodexStderrLine } from "../src/drivers/codex/driver.js";
import { buildClaudeArgs } from "../src/drivers/claude/driver.js";
import { buildOmpArgs } from "../src/drivers/omp/driver.js";

// Every harness exposes reasoning effort and (except Claude) an OpenAI service
// tier, but the drivers only ever forwarded `--model`. These tests pin the flag
// spellings measured against codex-cli 0.150.1, claude, and omp 18.0.7 — the
// three CLIs disagree on every one of them.

const S = "test-session";
const base = { sessionId: S, prompt: "do it", cwd: "/work" };

// Args are positional pairs, so asserting "contains X" is not enough: `-c` and
// its value must be adjacent, or codex reads the next flag as the value.
// Multiple `-c` flags can coexist (effort + fast), so check any occurrence.
const hasPair = (args: readonly string[], flag: string, value: string) =>
  args.some((v, i) => v === flag && args[i + 1] === value);

describe("buildCodexArgs", () => {
  it("requests the workspace-write sandbox so the agent can edit files", () => {
    // Regression: without `-s`, codex falls back to its read-only default and
    // every patch is rejected with "writing is blocked by read-only sandbox"
    // while the process still exits 0 — a session that looks completed and
    // wrote nothing.
    expect(hasPair(buildCodexArgs(base), "-s", "workspace-write")).toBe(true);
  });

  it("maps effort onto the model_reasoning_effort config override", () => {
    const args = buildCodexArgs({ ...base, effort: "max" });
    expect(hasPair(args, "-c", 'model_reasoning_effort="max"')).toBe(true);
  });

  it("maps fast onto the priority service tier", () => {
    // "Fast" in the model cache is the `priority` tier (1.5x speed).
    const args = buildCodexArgs({ ...base, fast: true });
    expect(hasPair(args, "-c", 'service_tier="priority"')).toBe(true);
  });

  it("omits both config overrides when neither is requested", () => {
    expect(buildCodexArgs(base)).not.toContain("-c");
  });

  it("uses only resume-compatible options on the resume path", () => {
    const args = buildCodexArgs({ ...base, resumeSessionId: "thread-1", effort: "high" });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-C");
    expect(args).toContain("--skip-git-repo-check");
    expect(hasPair(args, "-c", 'model_reasoning_effort="high"')).toBe(true);
  });

  it("keeps both config overrides when effort and fast are set together", () => {
    const args = buildCodexArgs({ ...base, effort: "max", fast: true });
    expect(hasPair(args, "-c", 'model_reasoning_effort="max"')).toBe(true);
    expect(hasPair(args, "-c", 'service_tier="priority"')).toBe(true);
  });

  it("mirrors fast and effort onto the resume path together", () => {
    const args = buildCodexArgs({ ...base, resumeSessionId: "thread-1", effort: "high", fast: true });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(hasPair(args, "-c", 'model_reasoning_effort="high"')).toBe(true);
    expect(hasPair(args, "-c", 'service_tier="priority"')).toBe(true);
  });
});

describe("buildClaudeArgs", () => {
  it("passes effort as a first-class flag", () => {
    expect(hasPair(buildClaudeArgs({ ...base, effort: "max" }), "--effort", "max")).toBe(true);
  });

  it("ignores fast because Claude has no service tier flag", () => {
    // `service_tier` is an OpenAI concept; claude --help exposes no equivalent,
    // so --fast must be a documented no-op here rather than an invalid flag.
    const args = buildClaudeArgs({ ...base, fast: true });
    expect(args.join(" ")).not.toMatch(/tier|priority|fast/);
  });
});

describe("buildOmpArgs", () => {
  it("maps effort onto --thinking", () => {
    expect(hasPair(buildOmpArgs({ ...base, effort: "max" }), "--thinking", "max")).toBe(true);
  });

  it("maps fast onto --service-tier", () => {
    expect(hasPair(buildOmpArgs({ ...base, fast: true }), "--service-tier", "priority")).toBe(true);
  });
});

describe("parseCodexStderrLine", () => {
  it("surfaces a tool rejection that never reaches the JSON stream", () => {
    // VERBATIM stderr from codex-cli 0.150.1. The matching stdout carried only
    // an agent_message and turn.completed — no error frame at all — so this
    // line is the ONLY evidence the write was refused.
    const ev = parseCodexStderrLine(
      "2026-08-27T17:14:26.548162Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings",
      S,
    );
    expect(ev?.type).toBe("error");
    expect((ev as any).error).toContain("patch rejected");
    expect(ev?.sessionId).toBe(S);
  });

  it("ignores non-error stderr noise", () => {
    // codex prints this on every single run; treating it as an error would make
    // every session look broken.
    expect(parseCodexStderrLine("Reading additional input from stdin...", S)).toBeNull();
  });
});
