import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "./session.js";
import type { AgentDriver, DriverRegistry, ReasoningEffort } from "./driver.js";
import { getPaths } from "../config/paths.js";

export interface ModelCost {
  input: number;  // USD per 1M tokens
  output: number; // USD per 1M tokens
}

export interface ModelInfo {
  id: string;               // Canonical CLI selector / id (e.g. "gpt-5.6-luna", "openrouter/anthropic/claude-3.7-sonnet")
  name: string;             // Human readable display name
  provider: string;         // Provider slug (e.g. "openai", "anthropic", "openrouter")
  description?: string;     // Human readable description
  aliases?: string[];       // Ergonomic aliases accepted by CLI (e.g. ["sonnet", "claude-sonnet-5"])
  contextWindow?: number;   // Context window tokens
  maxOutputTokens?: number; // Max output completion tokens
  reasoningEfforts?: (ReasoningEffort | string)[]; // Supported reasoning effort levels
  supportsThinking?: boolean;
  isDefault?: boolean;
  cost?: ModelCost;
  raw?: unknown;            // Optional unparsed payload for debugging
}

export interface ProviderModels {
  provider: string;         // e.g. "openai", "anthropic", "openrouter", "amazon-bedrock"
  displayName?: string;     // e.g. "OpenAI", "Anthropic", "OpenRouter"
  models: ModelInfo[];
}

export interface HarnessModels {
  agent: AgentId;
  available: boolean;       // false if harness binary is not installed
  error?: string;           // discovery error or timeout message
  providers: ProviderModels[];
  cachedAt?: string;        // ISO timestamp
}

export interface ListModelsOptions {
  refresh?: boolean;
  signal?: AbortSignal;     // Enables cancellation on CLI Ctrl+C or IPC timeout
}

export const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function loadDiskModelsCache(): HarnessModels[] | null {
  try {
    const p = getPaths();
    if (!fs.existsSync(p.modelsCache)) return null;
    const raw = fs.readFileSync(p.modelsCache, "utf-8");
    const data = JSON.parse(raw) as HarnessModels[];
    if (!Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveDiskModelsCache(models: HarnessModels[]): void {
  try {
    const p = getPaths();
    fs.mkdirSync(p.cacheDir, { recursive: true });
    const tmp = `${p.modelsCache}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2), "utf-8");
    fs.renameSync(tmp, p.modelsCache);
  } catch {}
}

export async function discoverHarnessModels(
  driver: AgentDriver,
  options?: ListModelsOptions,
): Promise<HarnessModels> {
  let install: { installed: boolean; error?: string };
  try {
    install = await driver.detect();
  } catch (e) {
    return {
      agent: driver.id,
      available: false,
      error: e instanceof Error ? e.message : String(e),
      providers: [],
      cachedAt: new Date().toISOString(),
    };
  }

  if (!install.installed) {
    return {
      agent: driver.id,
      available: false,
      error: install.error || "binary not found",
      providers: [],
      cachedAt: new Date().toISOString(),
    };
  }

  if (!driver.listModels) {
    return {
      agent: driver.id,
      available: true,
      providers: [],
      cachedAt: new Date().toISOString(),
    };
  }

  try {
    const providers = await driver.listModels(options);
    return {
      agent: driver.id,
      available: true,
      providers,
      cachedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      agent: driver.id,
      available: true,
      error: e instanceof Error ? e.message : String(e),
      providers: [],
      cachedAt: new Date().toISOString(),
    };
  }
}

export async function discoverAllModels(
  registry: DriverRegistry,
  options?: { agent?: AgentId; refresh?: boolean },
): Promise<HarnessModels[]> {
  const drivers = options?.agent ? [registry.get(options.agent)] : registry.list();
  const results = await Promise.all(
    drivers.map((d) => discoverHarnessModels(d, { refresh: options?.refresh })),
  );
  return results;
}

export async function getCachedOrDiscoverModels(
  registry: DriverRegistry,
  options?: { agent?: AgentId; refresh?: boolean },
): Promise<HarnessModels[]> {
  const disk = loadDiskModelsCache();
  const now = Date.now();

  if (!options?.refresh && disk && Array.isArray(disk)) {
    const isFresh = (item: HarnessModels) =>
      Boolean(item.cachedAt && now - new Date(item.cachedAt).getTime() < CACHE_TTL_MS);

    if (options?.agent) {
      const match = disk.find((d) => d.agent === options.agent);
      if (match && isFresh(match)) {
        return [match];
      }
    } else {
      const allKnownAgents: AgentId[] = registry.list().map((d) => d.id);
      const hasAllFresh = allKnownAgents.every((id) => {
        const found = disk.find((d) => d.agent === id);
        return found && isFresh(found);
      });
      if (hasAllFresh) {
        return disk;
      }
    }
  }

  // Need discovery
  const freshResults = await discoverAllModels(registry, options);

  // Merge with existing disk cache if partial query
  let merged = freshResults;
  if (disk && options?.agent) {
    merged = disk.filter((d) => d.agent !== options.agent).concat(freshResults);
  }

  saveDiskModelsCache(merged);
  return options?.agent ? freshResults : merged;
}

export function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const matrix: number[][] = [];
  for (let i = 0; i <= al; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= bl; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[al][bl];
}

export function findClosestModel(query: string, candidates: string[]): string | undefined {
  if (!query || candidates.length === 0) return undefined;
  const q = query.toLowerCase();

  // 1. Exact match
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === q) return candidate;
  }

  // 2. Substring match - pick candidate with smallest length difference
  let bestSubMatch: string | undefined;
  let minSubDelta = Infinity;

  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    if (c.includes(q) || q.includes(c)) {
      const delta = Math.abs(c.length - q.length);
      if (delta < minSubDelta) {
        minSubDelta = delta;
        bestSubMatch = candidate;
      }
    }
  }

  // 3. Fuzzy Levenshtein match
  let bestFuzzyMatch: string | undefined;
  let minDistance = Infinity;

  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    const dist = levenshtein(q, c);
    const maxThreshold = Math.max(3, Math.floor(candidate.length / 2));
    if (dist < minDistance && dist <= maxThreshold) {
      minDistance = dist;
      bestFuzzyMatch = candidate;
    }
  }

  // A substring hit is not automatically the better answer. "claude-opus-4-9"
  // contains "opus", so returning on the substring pass suggested the alias and
  // never even looked at "claude-opus-4-8", one character away. Both passes are
  // kept because each catches what the other misses: the substring pass reaches
  // matches the distance threshold rejects as too long, such as "Sonnet" for
  // "claude-sonnet-5".
  if (bestSubMatch === undefined) return bestFuzzyMatch;
  if (bestFuzzyMatch === undefined) return bestSubMatch;
  return minDistance < levenshtein(q, bestSubMatch.toLowerCase()) ? bestFuzzyMatch : bestSubMatch;
}
