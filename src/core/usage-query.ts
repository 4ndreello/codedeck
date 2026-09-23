import type { AgentId } from "./session.js";
import type { UsagePeriod, UsageQueryParams } from "../daemon/protocol.js";

export interface UsageQueryOptions {
  today?: boolean;
  days?: string;
  since?: string;
  until?: string;
  all?: boolean;
  repo?: string;
  current?: boolean;
  model?: string;
  agent?: string;
}

export function buildUsageQueryParams(
  opts: UsageQueryOptions,
  cwd: string,
  now: Date,
): UsageQueryParams {
  let period: UsagePeriod | undefined;
  let since = opts.since;
  const until = opts.until;

  if (opts.all) {
    period = "all";
  } else if (opts.today) {
    period = "today";
  } else if (opts.days) {
    const days = parseInt(opts.days, 10);
    if (days === 3) period = "3d";
    else if (days === 7) period = "7d";
    else if (days === 30) period = "30d";
    else if (!isNaN(days) && days > 0) {
      const sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
      since = sinceDate.toISOString();
    }
  } else if (!since) {
    // Default to today if no temporal flags provided
    period = "today";
  }

  let repository = opts.repo;
  if (opts.current) {
    repository = cwd;
  }

  return {
    period,
    since,
    until,
    repository,
    model: opts.model,
    agent: opts.agent as AgentId | undefined,
  };
}
