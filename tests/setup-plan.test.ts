import { describe, expect, it } from "vitest";

import type { BatchModelsResult, HarnessModels } from "../src/core/models.js";
import type { RunAgentConfig } from "../src/config/config.js";
import {
  buildSetupPlan,
  validateBindings,
} from "../src/config/setup.js";

describe("buildSetupPlan", () => {
  it("applies selected fields, preserves unrelated config, and returns their diff paths", () => {
    const current = {
      defaultAgent: "claude",
      worktree: false,
      remoteControl: true,
      pty: true,
      custom: { keep: true },
      agents: {
        general: { harness: "claude", model: "sonnet" },
        reviewer: { harness: "claude", model: "old", effort: "low" },
      },
      orchestrator: { investigate: "none", selfWork: "none", tools: "dispatch" },
      defaultSandbox: "workspace-write",
      autocompact: { enabled: false, cap: 300_000, percent: 0.7, tokens: 210_000, mode: "tokens" },
    } as RunAgentConfig;
    const original = structuredClone(current);
    const plan = buildSetupPlan(current, {
      agents: { reviewer: { harness: "codex", model: "gpt-5.7", effort: "high" } },
      orchestrator: { investigate: "read", selfWork: "small", tools: "edit", parallelism: 7 },
      sandbox: "danger-full-access",
      autocompact: { enabled: true },
    });

    expect(plan.proposedConfig).toEqual({
      ...current,
      agents: {
        general: { harness: "claude", model: "sonnet" },
        reviewer: { harness: "codex", model: "gpt-5.7", effort: "high" },
      },
      orchestrator: { investigate: "read", selfWork: "small", tools: "edit", parallelism: 7 },
      defaultSandbox: "danger-full-access",
      autocompact: { enabled: true, cap: 300_000, percent: 0.7, tokens: 210_000, mode: "tokens" },
    });
    expect(plan.diff.map((change) => change.path)).toEqual([
      "/agents/reviewer/effort",
      "/agents/reviewer/harness",
      "/agents/reviewer/model",
      "/autocompact/enabled",
      "/defaultSandbox",
      "/orchestrator/investigate",
      "/orchestrator/parallelism",
      "/orchestrator/selfWork",
      "/orchestrator/tools",
    ]);
    expect(plan.diff.find((change) => change.path === "/orchestrator/parallelism")).toMatchObject({
      beforePresent: false,
      afterPresent: true,
      after: 7,
    });
    expect(current).toEqual(original);
  });

  it("preserves skipped bindings and an omitted orchestrator", () => {
    const binding = { harness: "codex", model: "typed:model", effort: "max" } as const;
    const orchestrator = { investigate: "free", selfWork: "small", tools: "read", parallelism: 4 } as const;
    const current: RunAgentConfig = { agents: { reviewer: binding }, orchestrator };
    const plan = buildSetupPlan(current, { agents: {} });

    expect(plan.proposedConfig.agents).toEqual({ reviewer: binding });
    expect(plan.proposedConfig.orchestrator).toEqual(orchestrator);
    expect(plan.diff).toEqual([]);
  });

  it("preserves an absent orchestrator and absent autocompact when they are not selected", () => {
    const current: RunAgentConfig = {
      agents: { general: { harness: "claude", model: "sonnet" } },
      defaultSandbox: "workspace-write",
    };
    const plan = buildSetupPlan(current, {
      agents: { general: current.agents!.general! },
      autocompact: { enabled: false },
    });

    expect(Object.hasOwn(plan.proposedConfig, "orchestrator")).toBe(false);
    expect(Object.hasOwn(plan.proposedConfig, "autocompact")).toBe(false);
    expect(plan.diff).toEqual([]);
  });

  it("turns off an existing autocompact block and preserves its other fields", () => {
    const current: RunAgentConfig = {
      agents: { general: { harness: "claude", model: "sonnet" } },
      autocompact: { enabled: true, cap: 300_000, percent: 0.7, tokens: 210_000, mode: "tokens" },
    };

    const plan = buildSetupPlan(current, {
      agents: { general: current.agents!.general! },
      autocompact: { enabled: false },
    });

    expect(plan.proposedConfig.autocompact).toEqual({
      enabled: false,
      cap: 300_000,
      percent: 0.7,
      tokens: 210_000,
      mode: "tokens",
    });
    expect(plan.diff.map((change) => change.path)).toEqual(["/autocompact/enabled"]);
  });

  it("preserves unknown legacy setup values while updating top-level fields", () => {
    const pointerKey = ["active", String.fromCharCode(80), "rofile"].join("");
    const savedSetsKey = ["pro", "files"].join("");
    const savedSets = { x: { agents: { reviewer: { harness: "omp", model: "legacy" } } } };
    const current = {
      agents: { reviewer: { harness: "claude", model: "current" } },
      [pointerKey]: "x",
      [savedSetsKey]: savedSets,
    } as RunAgentConfig;

    const plan = buildSetupPlan(current, {
      agents: { reviewer: { harness: "codex", model: "selected" } },
    });
    const proposed = plan.proposedConfig as RunAgentConfig & Record<string, unknown>;

    expect(proposed.agents?.reviewer).toEqual({ harness: "codex", model: "selected" });
    expect(proposed[pointerKey]).toBe("x");
    expect(proposed[savedSetsKey]).toEqual(savedSets);
  });
});

describe("setup binding validation", () => {
  function catalog(status: BatchModelsResult["status"], models: HarnessModels[]): BatchModelsResult {
    return {
      models,
      status,
      source: status === "fresh" ? "cache" : status === "offline" ? "stale-cache" : "none",
      ageMs: status === "unavailable" ? null : 1,
      cacheWriteFailed: false,
    };
  }

  const codex: HarnessModels = {
    agent: "codex",
    available: true,
    providers: [
      {
        provider: "openai",
        models: [{ id: "gpt-5.7", name: "GPT-5.7", provider: "openai", aliases: ["gpt-latest"] }],
      },
    ],
  };

  it("validates a catalog alias separately from planning", () => {
    const plan = buildSetupPlan(
      {},
      { agents: { reviewer: { harness: "codex", model: "gpt-latest" } } },
    );
    const validation = validateBindings(
      [{ role: "reviewer", binding: { harness: "codex", model: "gpt-latest" } }],
      catalog("fresh", [codex]),
    );

    expect(plan.proposedConfig.agents?.reviewer).toEqual({ harness: "codex", model: "gpt-latest" });
    expect(validation).toEqual({
      entries: [{
        role: "reviewer",
        harness: "codex",
        model: "gpt-latest",
        status: "accepted",
        message: "",
      }],
      code: undefined,
      message: null,
    });
  });

  it("reports an off-catalog selection from separate validation", () => {
    const selected: RunAgentConfig = {};
    const plan = buildSetupPlan(selected, {
      agents: { reviewer: { harness: "codex", model: "typed:model" } },
    });
    const validation = validateBindings(
      [{ role: "reviewer", binding: { harness: "codex", model: "typed:model" } }],
      catalog("fresh", [codex]),
    );

    expect(plan.proposedConfig.agents?.reviewer).toEqual({ harness: "codex", model: "typed:model" });
    expect(validation.entries).toEqual([{
      role: "reviewer",
      harness: "codex",
      model: "typed:model",
      status: "unknown-model",
      message: 'Model "typed:model" is not in the codex catalog for role "reviewer".',
    }]);
    expect(validation.code).toBe(12);
  });

  it("keeps stale unknown bindings unverified", () => {
    const validation = validateBindings(
      [{ role: "reviewer", binding: { harness: "codex", model: "typed:model" } }],
      catalog("offline", [codex]),
    );

    expect(validation.entries[0]).toMatchObject({ status: "unverified" });
    expect(validation.code).toBe(13);
    expect(validation.message).toContain("catalog is stale");
  });
});
