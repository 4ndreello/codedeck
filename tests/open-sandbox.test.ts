import { describe, expect, it } from "vitest";

import { launcherFor } from "../src/cli/commands/open.js";
import { buildOpenArgs } from "../src/open/launchers/claude.js";
import { buildArgs as buildOpencodeArgs } from "../src/open/launchers/opencode.js";

const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

function isCodexSandboxArg(arg: string): boolean {
  return (
    arg === "--sandbox" ||
    arg.startsWith("--sandbox=") ||
    arg === "-s" ||
    CODEX_SANDBOX_MODES.some((mode) => arg === `-s${mode}` || arg === `-s=${mode}`) ||
    arg === CODEX_BYPASS ||
    arg.startsWith(`${CODEX_BYPASS}=`)
  );
}

function expectNoCodexSandboxArgs(args: string[]): void {
  expect(args.some(isCodexSandboxArg)).toBe(false);
}

describe("open remains Codex-blind", () => {
  it("keeps Claude launch arguments free of Codex sandbox options", () => {
    const args = buildOpenArgs("orchestrator", {}, "/opt/codedeck/plugin", [], "/worktree");

    expect(args).toContain("--dangerously-skip-permissions");
    expectNoCodexSandboxArgs(args);
  });

  it("keeps opencode launch arguments free of Codex sandbox options", () => {
    const args = buildOpencodeArgs(
      "reviewer",
      { model: "anthropic/claude-sonnet-4-6", bypass: false, resume: "session-1" },
      [],
    );

    expectNoCodexSandboxArgs(args);
  });

  it("selects only Claude or opencode launchers", () => {
    expect(launcherFor("general", undefined)).toBe("claude");
    expect(launcherFor("reviewer", { harness: "claude", model: "claude-opus-4-8" })).toBe("claude");
    expect(launcherFor("reviewer", { harness: "opencode", model: "anthropic/claude-sonnet-4-6" })).toBe(
      "opencode",
    );
    expect(() => launcherFor("reviewer", { harness: "codex", model: "gpt-5" })).toThrow(/codex/);
    expect(() => launcherFor("reviewer", { harness: "omp", model: "gpt-5" })).toThrow(/omp/);
  });
});
