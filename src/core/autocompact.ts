export const AUTOCOMPACT_MIN_TOKENS = 100_000;
export const AUTOCOMPACT_MAX_TOKENS = 1_000_000;
export const AUTOCOMPACT_DEFAULT_CAP = 260_000;
export const AUTOCOMPACT_DEFAULT_PERCENT = 0.8;

export interface AutocompactConfig {
  enabled?: boolean;
  cap?: number;
  percent?: number;
  tokens?: number;
  mode?: "auto" | "tokens";
}

export type AutocompactTokens = number | "auto";
export type AutocompactValue = boolean | number | "auto";
export type AutocompactExplicit = AutocompactValue | "--no-autocompact" | string;

export interface AutocompactResolutionOptions {
  contextWindow?: number;
  config?: { autocompact?: AutocompactConfig };
  explicit?: AutocompactExplicit;
  passthrough?: readonly string[];
}

export function parseAutocompact(value: unknown): AutocompactValue | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  if (typeof value !== "string") {
    throw invalidAutocompactValue(value);
  }
  if (value === "auto") return value;
  if (/^\d+$/.test(value)) {
    const tokens = Number(value);
    if (Number.isSafeInteger(tokens) && tokens >= AUTOCOMPACT_MIN_TOKENS && tokens <= AUTOCOMPACT_MAX_TOKENS) {
      return tokens;
    }
  }
  throw invalidAutocompactValue(value);
}

function invalidAutocompactValue(value: unknown): Error {
  return new Error(
    `Invalid --autocompact value "${String(value)}". Expected "auto" or an integer from ${AUTOCOMPACT_MIN_TOKENS} to ${AUTOCOMPACT_MAX_TOKENS}.`,
  );
}

function clampTokens(tokens: number): number {
  return Math.min(AUTOCOMPACT_MAX_TOKENS, Math.max(AUTOCOMPACT_MIN_TOKENS, Math.floor(tokens)));
}

function hasPassthroughOverride(passthrough: readonly string[] | undefined): boolean {
  return passthrough?.some(
    (token) => token === "--autocompact" || token.startsWith("--autocompact=") || token === "--no-autocompact",
  ) ?? false;
}

function explicitTokens(explicit: AutocompactExplicit | undefined): AutocompactTokens | true | false | undefined {
  if (explicit === undefined || explicit === true || explicit === false) return explicit;
  if (explicit === "--no-autocompact") return false;
  if (explicit === "auto") return "auto";
  if (typeof explicit === "number") return Number.isFinite(explicit) ? clampTokens(explicit) : undefined;

  const parsed = parseAutocompact(explicit);
  if (parsed === undefined || parsed === true || parsed === false) return parsed;
  return parsed === "auto" ? parsed : clampTokens(parsed);
}

export function resolveAutocompactTokens(
  options: AutocompactResolutionOptions = {},
): AutocompactTokens | undefined {
  const explicit = explicitTokens(options.explicit);
  if (explicit === false) return undefined;
  if (hasPassthroughOverride(options.passthrough)) return undefined;
  if (explicit !== undefined && explicit !== true) return explicit;

  const config = options.config?.autocompact;
  if (config?.enabled === false && explicit !== true) return undefined;
  if (typeof config?.tokens === "number" && Number.isFinite(config.tokens)) {
    return clampTokens(config.tokens);
  }
  if (config?.mode === "auto") return "auto";

  const cap = typeof config?.cap === "number" && Number.isFinite(config.cap)
    ? config.cap
    : AUTOCOMPACT_DEFAULT_CAP;
  const percent = typeof config?.percent === "number" && Number.isFinite(config.percent)
    ? config.percent
    : AUTOCOMPACT_DEFAULT_PERCENT;
  const requested = typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow)
    ? Math.min(cap, Math.floor(percent * options.contextWindow))
    : cap;
  return clampTokens(requested);
}

export function autocompactArgs(options: AutocompactResolutionOptions = {}): string[] {
  const tokens = resolveAutocompactTokens(options);
  return tokens === undefined ? [] : ["--autocompact", String(tokens)];
}
