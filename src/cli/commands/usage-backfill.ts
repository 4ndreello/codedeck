import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { findTranscript, readTranscriptUsage } from "../../core/claude-transcript.js";
import { openSourceKey } from "../../core/usage-source.js";
import { getPaths } from "../../config/paths.js";
import { SESSION_ID_PATTERN } from "../../open/runtime.js";
import { Database } from "../../store/database.js";
import { UsageLedger } from "../../store/usage-ledger.js";

export interface UsageBackfillSummary {
  imported: number;
  skipped: number;
}

interface NativeSessionRow {
  native_session_id: string;
}

function addId(ids: Set<string>, value: string): void {
  const nativeId = value.trim();
  if (SESSION_ID_PATTERN.test(nativeId)) ids.add(nativeId);
}

function collectNativeIds(
  db: DatabaseSync,
  sessionsDir: string,
): { ids: Set<string>; workerIds: Set<string> } {
  const ids = new Set<string>();
  const openRows = db.prepare(`
    SELECT native_session_id FROM sessions
    WHERE origin = 'open' AND native_session_id IS NOT NULL
  `).all() as unknown as NativeSessionRow[];
  for (const row of openRows) addId(ids, row.native_session_id);

  const workerRows = db.prepare(`
    SELECT native_session_id FROM sessions
    WHERE native_session_id IS NOT NULL AND (origin IS NULL OR origin <> 'open')
  `).all() as unknown as NativeSessionRow[];
  const workerIds = new Set(workerRows.map((row) => row.native_session_id));

  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return { ids, workerIds };
  }

  for (const file of files) {
    const nameSidecar = file.match(/^codedeck-session-\d+\.([^.]+)\.name$/);
    if (nameSidecar?.[1]) addId(ids, nameSidecar[1]);

    if (!/^codedeck-session-\d+$/.test(file)) continue;
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(sessionsDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) addId(ids, line);
  }

  return { ids, workerIds };
}

function repositoryRoot(cwd: string | undefined): string | null {
  if (cwd === undefined) return null;
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function importLegacyUsage(
  db: DatabaseSync,
  ledger: UsageLedger,
  nativeId: string,
  usage: Awaited<ReturnType<typeof readTranscriptUsage>>,
): boolean {
  const sourceKey = openSourceKey(nativeId);
  const endedAt = usage.endedAt;
  if (endedAt === undefined) return false;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (ledger.hasSource(sourceKey)) {
      db.exec("ROLLBACK");
      return false;
    }

    const cost = usage.cost ?? null;
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    const cachedTokens = usage.cachedTokens;
    const updatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO usage_legacy (
        native_id, ended_at, cwd, repository, model, cost,
        input_tokens, output_tokens, cached_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nativeId,
      endedAt,
      usage.cwd ?? null,
      repositoryRoot(usage.cwd ?? undefined),
      usage.model ?? null,
      cost,
      inputTokens,
      outputTokens,
      cachedTokens,
    );
    db.prepare(`
      INSERT INTO usage_sources (
        source_key, cost, input_tokens, output_tokens, cached_tokens, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(sourceKey, cost, inputTokens, outputTokens, cachedTokens, updatedAt);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export async function backfillUsage(): Promise<UsageBackfillSummary> {
  const paths = getPaths();
  const db = new Database(paths.db);
  try {
    const handle = db.getHandle();
    const ledger = new UsageLedger(handle);
    const { ids, workerIds } = collectNativeIds(handle, paths.sessionsDir);
    const summary: UsageBackfillSummary = { imported: 0, skipped: 0 };

    for (const nativeId of ids) {
      if (workerIds.has(nativeId)) {
        summary.skipped++;
        continue;
      }

      const sourceKey = openSourceKey(nativeId);
      if (ledger.hasSource(sourceKey)) {
        summary.skipped++;
        continue;
      }

      const transcript = findTranscript(nativeId);
      if (!transcript) {
        summary.skipped++;
        continue;
      }

      let usage: Awaited<ReturnType<typeof readTranscriptUsage>>;
      try {
        usage = await readTranscriptUsage(transcript);
      } catch {
        summary.skipped++;
        continue;
      }
      if (usage.state !== "cost-state" || usage.endedAt === undefined) {
        summary.skipped++;
        continue;
      }

      if (importLegacyUsage(handle, ledger, nativeId, usage)) summary.imported++;
      else summary.skipped++;
    }

    return summary;
  } finally {
    db.close();
  }
}
