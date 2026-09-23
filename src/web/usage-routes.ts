import type { ServerResponse } from "node:http";
import { buildUsageQueryParams, type UsageQueryOptions } from "../core/usage-query.js";
import type { UsageQueryParams, UsageQueryResult } from "../daemon/protocol.js";
import type { WebRoute } from "./server.js";
import { renderUsagePage, type UsagePageOptions } from "./usage-page.js";

export interface UsageRoutesOptions {
  fetchUsageQuery: (params: UsageQueryParams) => Promise<UsageQueryResult>;
  cwd?: string;
  now?: () => Date;
  page?: UsagePageOptions;
}

export function parseUsageWebQuery(
  searchParams: URLSearchParams,
  cwd: string,
  now: Date = new Date(),
): UsageQueryParams {
  const period = searchParams.get("period");
  const periodDays = period && /^\d+d$/.test(period) ? period.slice(0, -1) : undefined;
  const opts: UsageQueryOptions = {
    all: readBoolean(searchParams, "all") || period === "all",
    today: readBoolean(searchParams, "today") || period === "today",
    days: readValue(searchParams, "days") ?? periodDays,
    since: readValue(searchParams, "since"),
    until: readValue(searchParams, "until"),
    repo: readValue(searchParams, "repo"),
    current: readBoolean(searchParams, "current"),
    model: readValue(searchParams, "model"),
    agent: readValue(searchParams, "agent"),
  };
  return buildUsageQueryParams(opts, cwd, now);
}

export function createUsageRoutes(options: UsageRoutesOptions): WebRoute[] {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());

  return [
    {
      path: "/usage",
      kind: "page",
      handler: (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderUsagePage(options.page));
      },
    },
    {
      path: "/api/usage",
      kind: "api",
      handler: async (request, response) => {
        if (request.method !== "GET") {
          writeJson(response, 405, { error: "method not allowed" });
          return;
        }

        let searchParams: URLSearchParams;
        try {
          searchParams = new URL(request.url ?? "/api/usage", "http://127.0.0.1").searchParams;
        } catch {
          writeJson(response, 400, { error: "bad request" });
          return;
        }

        try {
          const params = parseUsageWebQuery(searchParams, cwd, now());
          const result = await options.fetchUsageQuery(params);
          writeJson(response, 200, result);
        } catch (error) {
          writeJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  ];
}

function readValue(searchParams: URLSearchParams, name: string): string | undefined {
  const value = searchParams.get(name);
  return value ? value : undefined;
}

function readBoolean(searchParams: URLSearchParams, name: string): boolean {
  const value = searchParams.get(name);
  return value !== null && (value === "" || value === "1" || value.toLowerCase() === "true");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
