import { createReadStream, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { computeSessionCost, type SessionCostUsage } from "./pricing.js";

export interface TranscriptUsage {
  state: "cost-state" | "tokens" | "no-price";
  cost?: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model?: string;
  endedAt?: string;
  cwd?: string;
}

type JsonRecord = Record<string, unknown>;

interface UsageTotals extends SessionCostUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

function usageFromCostState(value: JsonRecord): TranscriptUsage {
  const totals = emptyUsage();
  const modelUsage = isRecord(value.modelUsage) ? value.modelUsage : {};
  let model: string | undefined;
  let highestModelCost = Number.NEGATIVE_INFINITY;

  for (const [name, rawUsage] of Object.entries(modelUsage)) {
    if (!isRecord(rawUsage)) continue;
    totals.inputTokens += tokenCount(rawUsage.inputTokens);
    totals.outputTokens += tokenCount(rawUsage.outputTokens);
    totals.cachedTokens += tokenCount(rawUsage.cacheReadInputTokens) + tokenCount(rawUsage.cacheCreationInputTokens);

    const modelCost = finiteNumber(rawUsage.costUSD);
    if (modelCost !== undefined && modelCost > highestModelCost) {
      highestModelCost = modelCost;
      model = name;
    }
  }

  const cost = finiteNumber(value.totalCostUSD);
  return {
    state: "cost-state",
    ...(cost === undefined ? {} : { cost }),
    ...totals,
    ...(model === undefined ? {} : { model }),
  };
}

export function findTranscript(
  nativeId: string,
  projectsDir = path.join(os.homedir(), ".claude", "projects"),
): string | undefined {
  let projects;
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(projectsDir, project.name, `${nativeId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
}

export async function readTranscriptUsage(file: string): Promise<TranscriptUsage> {
  let latestCostState: TranscriptUsage | undefined;
  let endedAt: string | undefined;
  let cwd: string | undefined;
  const seenMessages = new Set<string>();
  const usageByModel = new Map<string | undefined, UsageTotals>();

  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    if (typeof parsed.timestamp === "string") endedAt = parsed.timestamp;
    if (typeof parsed.cwd === "string") cwd = parsed.cwd;

    if (parsed.type === "cost-state") {
      latestCostState = usageFromCostState(parsed);
      continue;
    }

    if (parsed.type !== "assistant" || !isRecord(parsed.message) || !isRecord(parsed.message.usage)) continue;

    const usage = parsed.message.usage;
    const inputTokens = tokenCount(usage.input_tokens);
    const outputTokens = tokenCount(usage.output_tokens);
    const cacheReadTokens = tokenCount(usage.cache_read_input_tokens);
    const cacheCreationTokens = tokenCount(usage.cache_creation_input_tokens);
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) continue;

    const messageId = parsed.message.id;
    const requestId = parsed.requestId;
    if (messageId != null && requestId != null) {
      const key = JSON.stringify([messageId, requestId]);
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
    }

    const model = typeof parsed.message.model === "string" ? parsed.message.model : undefined;
    const totals = usageByModel.get(model) ?? emptyUsage();
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cachedTokens += cacheReadTokens + cacheCreationTokens;
    usageByModel.set(model, totals);
  }

  if (latestCostState) {
    return {
      ...latestCostState,
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(cwd === undefined ? {} : { cwd }),
    };
  }

  const totals = emptyUsage();
  let cost = 0;
  let allModelsPriced = true;
  for (const [model, usage] of usageByModel) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cachedTokens += usage.cachedTokens;
    const modelCost = computeSessionCost({ model, usage });
    if (modelCost === null) allModelsPriced = false;
    else cost += modelCost;
  }

  return {
    state: allModelsPriced ? "tokens" : "no-price",
    ...(allModelsPriced ? { cost } : {}),
    ...totals,
    ...(usageByModel.size === 1 && usageByModel.keys().next().value !== undefined
      ? { model: usageByModel.keys().next().value }
      : {}),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}
