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
 * the code. All entries use OpenRouter list prices fetched 2026-09-25 unless
 * noted otherwise. Models absent here deliberately have no fallback price and
 * therefore produce null from computeSessionCost().
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // OpenRouter list prices, fetched 2026-09-25.
  "gpt-6-luna": { input: 0.1, output: 0.5, cached: 0.01 },
  "gpt-5": { input: 1.25, output: 10, cached: 0.125 },
  "gpt-5.5": { input: 5, output: 30, cached: 0.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cached: 0.02 },
  // Still a placeholder.
  "gpt-5.7": { input: 1, output: 5 },
  // This id is not listed on OpenRouter; keep the existing price.
  "meta/muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cached: 0.002 },
  "openrouter/z-ai/glm-5.3-flash": { input: 0.045, output: 0.6, cached: 0.0285 },
  "openai-codex/gpt-5.6-luna": { input: 0.2, output: 1.2, cached: 0.02 },
  "deepseek-v4-flash-0731": { input: 0.03, output: 0.32, cached: 0.016 },
  // Free tier by name; not listed on OpenRouter.
  "muse-spark-1.3-contributor-free": { input: 0, output: 0, cached: 0 },

  "claude-opus-4-8": { input: 5, output: 25, cached: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cached: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 },
  "claude-fable-5": { input: 10, output: 50, cached: 1 },
  "claude-fable-5-1": { input: 10, output: 50, cached: 0.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cached: 0.3 },
  "claude-sonnet-5": { input: 2, output: 10, cached: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cached: 0.1 },

  // Alibaba Qwen models.
  "qwen3.8-max": { input: 2, output: 6, cached: 0.25 },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cached: 0.016 },
  // qwen-max and qwen-turbo are not listed on OpenRouter; prices kept as before.
  "qwen-max": { input: 2, output: 6, cached: 0.2 },
  "qwen-plus": { input: 0.26, output: 0.78, cached: 0.052 },
  "qwen-turbo": { input: 0.05, output: 0.2, cached: 0.005 },

  // Google Antigravity (Gemini) models.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.8-flash-high": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.8-flash-medium": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.8-flash-low": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash-high": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash-medium": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash-low": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash-high": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash-medium": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash-low": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.1-pro": { input: 2, output: 12, cached: 0.2 },
  "gemini-3.1-pro-high": { input: 2, output: 12, cached: 0.2 },
  "gemini-3.1-pro-low": { input: 2, output: 12, cached: 0.2 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cached: 0.125 },
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
  cachedInInput?: boolean;
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
 * Resolves a model name to its ModelPrice configuration.
 * Handles exact matches, stripped display labels, and stripping provider prefixes
 * like 'opencode/', 'alibaba-token-plan/', 'openrouter/', etc.
 */
export function resolveModelPrice(model: string | undefined | null): ModelPrice | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;

  const idOnly = trimmed.split(/\s+/)[0] ?? trimmed;
  const candidates = [trimmed, idOnly];

  // Strip leading provider prefixes such as "opencode/..." and "openrouter/...".
  const slashIdx = idOnly.indexOf("/");
  if (slashIdx !== -1) {
    const afterFirstSlash = idOnly.slice(slashIdx + 1);
    candidates.push(afterFirstSlash);

    const lastSlashIdx = idOnly.lastIndexOf("/");
    if (lastSlashIdx !== slashIdx) {
      candidates.push(idOnly.slice(lastSlashIdx + 1));
    }
  }

  for (const candidate of candidates) {
    const price = resolvePriceCandidate(candidate);
    if (price) return price;
  }

  // Case-insensitive fallback.
  const lower = idOnly.toLowerCase();
  if (lower !== idOnly) {
    return resolveModelPrice(lower);
  }

  return undefined;
}

function resolvePriceCandidate(candidate: string): ModelPrice | undefined {
  const pending = [candidate];
  for (const modelId of pending) {
    const price = MODEL_PRICES[modelId];
    if (price) return price;

    const withoutDate = modelId.replace(/-\d{8}$/, "");
    if (withoutDate !== modelId) pending.push(withoutDate);

    const withoutContext = modelId.replace(/\[[^\]]+\]$/, "");
    if (withoutContext !== modelId) pending.push(withoutContext);
  }
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
  cachedInInput = false,
}: ComputeSessionCostInput): number | null {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cachedTokens = usage?.cachedTokens ?? 0;
  if (
    cachedInInput &&
    isFiniteNumber(inputTokens) &&
    isFiniteNumber(cachedTokens) &&
    cachedTokens > inputTokens
  ) {
    return null;
  }

  if (isFiniteNumber(reportedCost) && reportedCost < 0) return null;
  // Zero is a valid reported cost and must win over every table entry.
  if (isFiniteNumber(reportedCost) && reportedCost >= 0) return reportedCost;

  const price = resolveModelPrice(model);
  if (!price || !isUsablePrice(price)) return null;

  if (
    !isValidTokenCount(inputTokens) ||
    !isValidTokenCount(outputTokens) ||
    !isValidTokenCount(cachedTokens)
  ) {
    return null;
  }

  const cachedPrice = price.cached ?? price.input;
  return (
    (cachedInInput ? inputTokens - cachedTokens : inputTokens) * price.input +
    outputTokens * price.output +
    cachedTokens * cachedPrice
  ) / 1_000_000;
}

export function cachedInInputFor(agent: string | undefined | null): boolean {
  return agent === "codex";
}

export function totalTokensFor(
  agent: string | undefined | null,
  usage?: SessionCostUsage,
): number {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cachedTokens = usage?.cachedTokens ?? 0;
  return inputTokens + outputTokens + (cachedInInputFor(agent) ? 0 : cachedTokens);
}
