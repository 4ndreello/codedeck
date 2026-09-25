# Model pricing refresh

## Problem statement

Usage estimates use the static `MODEL_PRICES` table in `src/core/pricing.ts`.
Missing cached prices and outdated list prices can make fallback estimates
wrong. The refreshed prices below use the OpenRouter model list fetched on
2026-09-25. The free Muse Spark entry is not listed on OpenRouter; its zero
price follows the model's free-tier name.

## Acceptance criteria

- R1. MODEL_PRICES SHALL hold the prices in the table below (USD per 1M tokens: input / output / cached).
- R2. WHEN a model id ends in a date suffix `-YYYYMMDD` (e.g. `claude-haiku-4-5-20251001`) and the id without it is priced, THEN `resolveModelPrice` SHALL return the undated price.
- R3. WHEN a model id ends in a bracketed context tag (e.g. `claude-opus-5[1m]`) and the id without it is priced, THEN `resolveModelPrice` SHALL return the untagged price.
- R4. WHEN the model is unknown and no cost is reported, THEN `computeSessionCost` SHALL return null, both when tokens are non-zero and when the usage object is absent (existing behavior, pinned by a test).

## Price table

Prices are USD per 1,000,000 tokens. The cached value for `gpt-5.7` is unset,
so cached tokens use its input price. `gpt-5.7` remains a placeholder.

| Model id | Input | Output | Cached |
| --- | ---: | ---: | ---: |
| `gpt-6-luna` | 0.1 | 0.5 | 0.01 |
| `gpt-5` | 1.25 | 10 | 0.125 |
| `gpt-5.5` | 5 | 30 | 0.5 |
| `gpt-5.6-luna` | 0.2 | 1.2 | 0.02 |
| `gpt-5.7` | 1 | 5 | input fallback |
| `meta/muse-spark-1.3-contributor` | 0.1 | 0.2 | 0.002 |
| `openrouter/z-ai/glm-5.3-flash` | 0.045 | 0.6 | 0.0285 |
| `openai-codex/gpt-5.6-luna` | 0.2 | 1.2 | 0.02 |
| `deepseek-v4-flash-0731` | 0.03 | 0.32 | 0.016 |
| `muse-spark-1.3-contributor-free` | 0 | 0 | 0 |
| `claude-opus-4-8` | 5 | 25 | 0.5 |
| `claude-opus-5` | 5 | 25 | 0.5 |
| `claude-opus-5-5` | 4 | 20 | 0.2 |
| `claude-fable-5` | 10 | 50 | 1 |
| `claude-fable-5-1` | 10 | 50 | 0.25 |
| `claude-sonnet-4-6` | 3 | 15 | 0.3 |
| `claude-sonnet-5` | 2 | 10 | 0.2 |
| `claude-haiku-4-5` | 1 | 5 | 0.1 |
| `qwen3.8-max` | 2 | 6 | 0.25 |
| `qwen3.8-flash` | 0.15 | 0.47 | 0.016 |
| `qwen-max` | 2 | 6 | 0.2 |
| `qwen-plus` | 0.26 | 0.78 | 0.052 |
| `qwen-turbo` | 0.05 | 0.2 | 0.005 |
| `gemini-3.8-flash` | 0.75 | 3.75 | 0.075 |
| `gemini-3.8-flash-high` | 0.75 | 3.75 | 0.075 |
| `gemini-3.8-flash-medium` | 0.75 | 3.75 | 0.075 |
| `gemini-3.8-flash-low` | 0.75 | 3.75 | 0.075 |
| `gemini-3.7-flash` | 0.75 | 3.75 | 0.075 |
| `gemini-3.7-flash-high` | 0.75 | 3.75 | 0.075 |
| `gemini-3.7-flash-medium` | 0.75 | 3.75 | 0.075 |
| `gemini-3.7-flash-low` | 0.75 | 3.75 | 0.075 |
| `gemini-3.6-flash` | 0.75 | 3.75 | 0.075 |
| `gemini-3.6-flash-high` | 0.75 | 3.75 | 0.075 |
| `gemini-3.6-flash-medium` | 0.75 | 3.75 | 0.075 |
| `gemini-3.6-flash-low` | 0.75 | 3.75 | 0.075 |
| `gemini-3.1-pro` | 2 | 12 | 0.2 |
| `gemini-3.1-pro-high` | 2 | 12 | 0.2 |
| `gemini-3.1-pro-low` | 2 | 12 | 0.2 |
| `gemini-2.5-flash` | 0.3 | 2.5 | 0.03 |
| `gemini-2.5-pro` | 1.25 | 10 | 0.125 |

Provider ids `openrouter/deepseek/deepseek-v4-flash-0731` and
`opencode/muse-spark-1.3-contributor-free` resolve through existing provider
prefix stripping.

## Unknown model behavior

Do not treat zero or absent token usage as a reported zero cost for an unknown
model. In the database, NULL usage means usage was never recorded.
`tests/usage.test.ts`, in "marks an open row without a calculable cost", pins
that a row without calculable cost remains incomplete.

## Out of scope

- Fetching prices at runtime, adding dependencies, or making prices configurable.
- Validating model names entered by a user.
- Changing session, usage, transcript, driver, web, or database behavior outside
  the pricing resolver and its tests.
- Reading or changing the real `~/.run-agent` database.
