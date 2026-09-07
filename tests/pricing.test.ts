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

  it("returns null for an unknown model without a reported cost", () => {
    expect(
      computeSessionCost({
        model: "model-that-is-not-versioned",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 },
      }),
    ).toBeNull();
  });
});
