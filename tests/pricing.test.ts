import { describe, expect, it } from "vitest";
import { computeSessionCost, MODEL_PRICES } from "../src/core/pricing.js";

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
});
