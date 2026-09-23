import { cachedInInputFor, computeSessionCost, totalTokensFor } from "./pricing.js";
import { isActiveStatus, type Session } from "./session.js";

export interface RunAttribution {
  sessionId: string;
  sourceKey: string;
  cost: number | null;
}

export interface RunLinkState {
  sessionId: string;
  state: string | null;
}

export interface RunUsageSummary {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
  activeSessionCount: number;
  costComplete: boolean;
  sessionsWithoutCost: number;
  orchestrator: {
    costUsd: number;
    costComplete: boolean;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    sources: Array<{ nativeId: string; costUsd: number }>;
  };
  total: { costUsd: number };
}

/**
 * Aggregates the last persisted usage value for each session in a run.
 * An empty run is complete because it has no session without a known cost.
 */
export function aggregateRunUsage(
  runId: string,
  sessions: readonly Session[],
  attributions: readonly RunAttribution[] = [],
  linkStates: readonly RunLinkState[] = [],
): RunUsageSummary {
  const uniqueSessions = new Map<string, Session>();
  for (const session of sessions) uniqueSessions.set(session.id, session);

  const orchestratorSessions = new Set(
    [...uniqueSessions.values()]
      .filter((session) => session.origin === "open")
      .map((session) => session.id),
  );
  const summary: RunUsageSummary = {
    runId,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    costComplete: true,
    sessionsWithoutCost: 0,
    orchestrator: {
      costUsd: 0,
      costComplete: true,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      sources: [],
    },
    total: { costUsd: 0 },
  };

  for (const session of uniqueSessions.values()) {
    const isOrchestrator = session.origin === "open";
    const usage = session.usage;
    const target = isOrchestrator ? summary.orchestrator : summary;
    target.inputTokens += usage?.inputTokens ?? 0;
    target.outputTokens += usage?.outputTokens ?? 0;
    target.cachedTokens += usage?.cachedTokens ?? 0;
    target.totalTokens += totalTokensFor(session.agent, usage);

    const costUsd = computeSessionCost({
      model: session.model,
      cachedInInput: cachedInInputFor(session.agent),
      reportedCost: usage?.cost,
      usage: {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedTokens: usage?.cachedTokens,
      },
    });
    if (costUsd === null) {
      if (isOrchestrator) {
        summary.orchestrator.costComplete = false;
      } else {
        summary.costComplete = false;
        summary.sessionsWithoutCost += 1;
      }
    } else {
      target.costUsd += costUsd;
    }

    if (!isOrchestrator) {
      summary.sessionCount++;
      if (isActiveStatus(session.status)) summary.activeSessionCount++;
    }
  }

  for (const linkState of linkStates) {
    if (
      orchestratorSessions.has(linkState.sessionId) &&
      (linkState.state === "missing" || linkState.state === "no-price")
    ) {
      summary.orchestrator.costComplete = false;
    }
  }

  const sourceCosts = new Map<string, number>();
  for (const attribution of attributions) {
    if (!orchestratorSessions.has(attribution.sessionId)) continue;
    const cost = attribution.cost ?? 0;
    sourceCosts.set(attribution.sourceKey, (sourceCosts.get(attribution.sourceKey) ?? 0) + cost);
  }

  summary.orchestrator.sources = [...sourceCosts].map(([sourceKey, costUsd]) => ({
    nativeId: sourceKey.replace(/^claude-open:/, ""),
    costUsd,
  }));
  summary.total.costUsd = summary.costUsd + summary.orchestrator.costUsd;

  return summary;
}
