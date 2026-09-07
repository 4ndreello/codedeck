export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** Optional USD per 1,000,000 cached tokens. Defaults to input. */
  cached?: number;
}

/**
 * Static prices are USD per 1,000,000 tokens. Keep this table versioned with
 * the code. Models discovered at runtime but absent here deliberately have no
 * fallback price and therefore produce null from computeSessionCost().
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Codex models currently named by CodeDeck. These ids are specific to the
  // installed Codex catalog, so the values are placeholders. TODO: ajustar preço.
  "gpt-5": { input: 1, output: 5, cached: 0.5 },
  "gpt-5.5": { input: 1, output: 5 },
  "gpt-5.6-luna": { input: 1, output: 5 },
  "gpt-5.7": { input: 1, output: 5 },

  // Claude's current CodeDeck default and model examples. Claude normally
  // reports its own cost, but these entries keep the fallback table complete.
  // TODO: ajustar preço for these model ids if their catalog prices change.
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
};

export interface SessionCostUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface ComputeSessionCostInput {
  model?: string | null;
  usage?: SessionCostUsage;
  reportedCost?: number | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTokenCount(value: number | undefined): value is number | undefined {
  return value === undefined || (isFiniteNumber(value) && value >= 0);
}

function isUsablePrice(price: ModelPrice): boolean {
  return (
    isFiniteNumber(price.input) &&
    price.input >= 0 &&
    isFiniteNumber(price.output) &&
    price.output >= 0 &&
    (price.cached === undefined || (isFiniteNumber(price.cached) && price.cached >= 0))
  );
}

/**
 * Returns a reported cost when one exists, otherwise calculates a static-table
 * estimate. Cached tokens use the input price unless the model declares its
 * own cached price. Invalid or unknown data has no known cost and returns null.
 */
export function computeSessionCost({
  model,
  usage,
  reportedCost,
}: ComputeSessionCostInput): number | null {
  // Zero is a valid reported cost and must win over every table entry.
  if (isFiniteNumber(reportedCost) && reportedCost >= 0) return reportedCost;

  const price = model === undefined || model === null ? undefined : MODEL_PRICES[model];
  if (!price || !isUsablePrice(price)) return null;

  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cachedTokens = usage?.cachedTokens ?? 0;
  if (
    !isValidTokenCount(inputTokens) ||
    !isValidTokenCount(outputTokens) ||
    !isValidTokenCount(cachedTokens)
  ) {
    return null;
  }

  const cachedPrice = price.cached ?? price.input;
  return (
    inputTokens * price.input +
    outputTokens * price.output +
    cachedTokens * cachedPrice
  ) / 1_000_000;
}
