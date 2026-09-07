import { computeSessionCost } from "./pricing.js";
import type { Session } from "./session.js";

export interface RunUsageSummary {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  sessionCount: number;
  costComplete: boolean;
  sessionsWithoutCost: number;
}

/**
 * Aggregates the last persisted usage value for each session in a run.
 * An empty run is complete because it has no session without a known cost.
 */
export function aggregateRunUsage(
  runId: string,
  sessions: readonly Session[],
): RunUsageSummary {
  const uniqueSessions = new Map<string, Session>();
  for (const session of sessions) uniqueSessions.set(session.id, session);

  const summary: RunUsageSummary = {
    runId,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    sessionCount: uniqueSessions.size,
    costComplete: true,
    sessionsWithoutCost: 0,
  };

  for (const session of uniqueSessions.values()) {
    const usage = session.usage;
    summary.inputTokens += usage?.inputTokens ?? 0;
    summary.outputTokens += usage?.outputTokens ?? 0;
    summary.cachedTokens += usage?.cachedTokens ?? 0;

    const costUsd = computeSessionCost({
      model: session.model,
      reportedCost: usage?.cost,
      usage: {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedTokens: usage?.cachedTokens,
      },
    });
    if (costUsd === null) {
      summary.costComplete = false;
      summary.sessionsWithoutCost += 1;
    } else {
      summary.costUsd += costUsd;
    }
  }

  return summary;
}
