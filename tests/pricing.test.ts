import { describe, expect, it } from "vitest";
import { computeSessionCost, MODEL_PRICES, resolveModelPrice } from "../src/core/pricing.js";

describe("computeSessionCost", () => {
  it("uses a valid reported cost, including zero, without recalculating", () => {
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 },
        reportedCost: 0,
      }),
    ).toBe(0);
  });

  it("calculates input and output with the static model price", () => {
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 0 },
      }),
    ).toBe(3.5);
  });

  it("prices cached tokens at input price by default", () => {
    const price = MODEL_PRICES["gpt-5.6-luna"];
    expect(price.cached).toBeUndefined();
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000 },
      }),
    ).toBe(price.input);
  });

  it("uses an explicit cached price when the table provides one", () => {
    const price = MODEL_PRICES["gpt-5"];
    expect(price.cached).toBeDefined();
    expect(
      computeSessionCost({
        model: "gpt-5",
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000 },
      }),
    ).toBe(price.cached);
  });

  it("keeps OMP-harness model prices exact", () => {
    expect(MODEL_PRICES["meta/muse-spark-1.3-contributor"]).toEqual({
      input: 0.1,
      output: 0.2,
      cached: 0.002,
    });
    expect(MODEL_PRICES["openrouter/z-ai/glm-5.3-flash"]).toEqual({
      input: 0.075,
      output: 0.25,
      cached: 0.015,
    });
    expect(MODEL_PRICES["openai-codex/gpt-5.6-luna"]).toEqual(MODEL_PRICES["gpt-5.6-luna"]);
  });

  it("returns a cost for each OMP-harness model id", () => {
    for (const model of [
      "meta/muse-spark-1.3-contributor",
      "openrouter/z-ai/glm-5.3-flash",
      "openai-codex/gpt-5.6-luna",
    ]) {
      expect(
        computeSessionCost({
          model,
          usage: { inputTokens: 1_000_000 },
        }),
      ).not.toBeNull();
    }
  });

  it("returns null for an unknown model without a reported cost", () => {
    expect(
      computeSessionCost({
        model: "model-that-is-not-versioned",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 },
      }),
    ).toBeNull();
  });

  it("returns null for a negative reported cost", () => {
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1_000_000 },
        reportedCost: -0.01,
      }),
    ).toBeNull();
  });

  it("resolves and prices models with provider prefixes (e.g. alibaba-token-plan, opencode)", () => {
    // alibaba-token-plan/qwen3.8-max -> qwen3.8-max (input: 2.0, output: 6.0, cached: 0.2)
    const cost = computeSessionCost({
      model: "alibaba-token-plan/qwen3.8-max",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 1_000_000 },
    });
    // (1M * 2.0 + 0.5M * 6.0 + 1M * 0.2) / 1M = 2.0 + 3.0 + 0.2 = 5.2
    expect(cost).toBeCloseTo(5.2, 5);

    // alibaba-token-plan/qwen3.8-flash -> qwen3.8-flash (input: 0.16, output: 0.47, cached: 0.016)
    const flashCost = computeSessionCost({
      model: "alibaba-token-plan/qwen3.8-flash",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(flashCost).toBeCloseTo(0.63, 5);

    // opencode/claude-sonnet-4-6 -> claude-sonnet-4-6 (input: 3, output: 15, cached: 0.3)
    const claudeCost = computeSessionCost({
      model: "opencode/claude-sonnet-4-6",
      usage: { inputTokens: 1_000_000, cachedTokens: 1_000_000 },
    });
    expect(claudeCost).toBeCloseTo(3.3, 5);
  });

  it("handles models with display name suffixes (e.g. 'gemini-3.8-flash-high   Gemini 3.8 Flash (High)')", () => {
    const cost = computeSessionCost({
      model: "gemini-3.8-flash-high   Gemini 3.8 Flash (High)",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(cost).toBeCloseTo(0.5, 5);
  });

  it("resolves multi-level nested provider prefixes (e.g. openrouter/meta/muse-spark-1.3-contributor)", () => {
    const price = resolveModelPrice("openrouter/meta/muse-spark-1.3-contributor");
    expect(price).toEqual(MODEL_PRICES["meta/muse-spark-1.3-contributor"]);
  });

  it("returns null when any token count is negative", () => {
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: -1, outputTokens: 100, cachedTokens: 0 },
      }),
    ).toBeNull();
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: 100, outputTokens: -1, cachedTokens: 0 },
      }),
    ).toBeNull();
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: { inputTokens: 100, outputTokens: 100, cachedTokens: -1 },
      }),
    ).toBeNull();
  });

  it("returns null for sessions without a model or with empty/whitespace model", () => {
    expect(
      computeSessionCost({
        model: undefined,
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    ).toBeNull();
    expect(
      computeSessionCost({
        model: null,
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    ).toBeNull();
    expect(
      computeSessionCost({
        model: "",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    ).toBeNull();
    expect(
      computeSessionCost({
        model: "   ",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    ).toBeNull();
  });

  it("handles missing or empty usage gracefully (pricing defaults to 0)", () => {
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: undefined,
      }),
    ).toBe(0);
    expect(
      computeSessionCost({
        model: "gpt-5.6-luna",
        usage: {},
      }),
    ).toBe(0);
  });

  it("resolveModelPrice returns undefined for null, undefined, whitespace, or unknown models", () => {
    expect(resolveModelPrice(undefined)).toBeUndefined();
    expect(resolveModelPrice(null)).toBeUndefined();
    expect(resolveModelPrice("")).toBeUndefined();
    expect(resolveModelPrice("   ")).toBeUndefined();
    expect(resolveModelPrice("unknown-provider/nonexistent-model")).toBeUndefined();
  });

  it("resolves model names case-insensitively", () => {
    expect(resolveModelPrice("Alibaba-Token-Plan/Qwen3.8-Max")).toEqual(MODEL_PRICES["qwen3.8-max"]);
    expect(resolveModelPrice("CLAUDE-SONNET-4-6")).toEqual(MODEL_PRICES["claude-sonnet-4-6"]);
  });
});
