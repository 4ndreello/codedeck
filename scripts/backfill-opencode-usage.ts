#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeSessionCost } from "../src/core/pricing.js";

const isApply = process.argv.includes("--apply");
const isForce = process.argv.includes("--force");

const runAgentDir = process.env.RUN_AGENT_DIR || path.join(process.env.HOME || "", ".run-agent");
const dbPath = path.join(runAgentDir, "run-agent.db");
const logsDir = path.join(runAgentDir, "logs");

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

const query = isForce
  ? `SELECT id, model, usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_cost FROM sessions WHERE agent = 'opencode'`
  : `SELECT id, model, usage_input_tokens, usage_output_tokens, usage_cached_tokens, usage_cost FROM sessions WHERE agent = 'opencode' AND usage_input_tokens IS NULL`;

const sessions = db.prepare(query).all() as Array<{
  id: string;
  model: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cached_tokens: number | null;
  usage_cost: number | null;
}>;

console.log(`Found ${sessions.length} OpenCode sessions to inspect.`);
console.log(`Mode: ${isApply ? "APPLY (writing to database)" : "DRY-RUN (pass --apply to execute)"}\n`);

let updatedCount = 0;
let totalRecoveredTokens = 0;
let totalRecoveredCost = 0;

const updateStmt = db.prepare(`
  UPDATE sessions
  SET usage_input_tokens = ?,
      usage_output_tokens = ?,
      usage_cached_tokens = ?,
      usage_cost = ?
  WHERE id = ?
`);

for (const session of sessions) {
  const logFile = path.join(logsDir, `${session.id}.ndjson`);
  if (!fs.existsSync(logFile)) {
    continue;
  }

  const content = fs.readFileSync(logFile, "utf8");
  const lines = content.split("\n");

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let reportedCost = 0;
  let stepFinishCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "step_finish") {
        stepFinishCount++;
        const part = obj.part ?? {};
        const tokens = part.tokens ?? obj.tokens;
        if (tokens) {
          inputTokens += tokens.input ?? 0;
          outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
          cachedTokens += tokens.cache?.read ?? 0;
        }
        if (typeof part.cost === "number" && part.cost > 0) {
          reportedCost += part.cost;
        }
      }
    } catch {}
  }

  if (stepFinishCount === 0 && inputTokens === 0 && outputTokens === 0) {
    continue;
  }

  const cost =
    reportedCost > 0
      ? reportedCost
      : computeSessionCost({
          model: session.model,
          usage: { inputTokens, outputTokens, cachedTokens },
        });

  const totalTokens = inputTokens + outputTokens + cachedTokens;
  totalRecoveredTokens += totalTokens;
  if (cost != null) {
    totalRecoveredCost += cost;
  }

  console.log(
    `[${session.id}] Model: ${session.model || "unknown"} | Steps: ${stepFinishCount} | Tokens: ${totalTokens.toLocaleString()} (in: ${inputTokens.toLocaleString()}, out: ${outputTokens.toLocaleString()}, cache: ${cachedTokens.toLocaleString()}) | Cost: $${cost != null ? cost.toFixed(4) : "unpriced"}`
  );

  if (isApply) {
    updateStmt.run(inputTokens, outputTokens, cachedTokens, cost, session.id);
  }
  updatedCount++;
}

console.log("\n================ SUMMARY ================");
console.log(`Sessions processed: ${updatedCount} / ${sessions.length}`);
console.log(`Total tokens recovered: ${totalRecoveredTokens.toLocaleString()}`);
console.log(`Total cost calculated: $${totalRecoveredCost.toFixed(4)}`);

if (!isApply && updatedCount > 0) {
  console.log("\nTo apply these updates, run with --apply:\n  pnpm tsx scripts/backfill-opencode-usage.ts --apply\n");
}
