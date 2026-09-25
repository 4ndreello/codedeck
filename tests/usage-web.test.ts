import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFetch } from "./helpers/web-session.js";
import { buildUsageQueryParams } from "../src/core/usage-query.js";
import type { UsageQueryParams, UsageQueryResult } from "../src/daemon/protocol.js";
import { createUsageRoutes } from "../src/web/usage-routes.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";

const usageResult: UsageQueryResult = {
  range: { period: "all", since: "2026-09-01T00:00:00.000Z", until: "2026-09-30T23:59:59.999Z" },
  totals: {
    sessionCount: 2,
    activeSessionCount: 1,
    completedSessionCount: 1,
    failedSessionCount: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 5,
    totalTokens: 125,
    costUsd: 0.25,
    costComplete: true,
    sessionsWithoutCost: 0,
  },
  byDay: [{ key: "2026-09-22", sessionCount: 2, inputTokens: 100, outputTokens: 20, cachedTokens: 5, totalTokens: 125, costUsd: 0.25, costComplete: true }],
  byRepository: [],
  byModel: [],
  byAgent: [],
  byRun: [],
  byOrigin: [],
};

const cwd = "/workspace/current";
const now = new Date(2026, 8, 22, 12, 0, 0, 0);
const handles: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function startUsageServer(fetchUsageQuery: (params: UsageQueryParams) => Promise<UsageQueryResult>) {
  const handle = await startWebServer({
    routes: createUsageRoutes({ fetchUsageQuery, cwd, now: () => now }),
    port: 0,
    initialPath: "/usage",
    open: false,
    log: vi.fn(),
    signalTarget: new EventEmitter(),
    exit: vi.fn(),
  });
  handles.push(handle);
  return handle;
}

describe("usage web routes", () => {
  it("serves the self-contained usage page", async () => {
    const handle = await startUsageServer(vi.fn(async () => usageResult));

    const response = await sessionFetch(handle)(`${handle.baseUrl}/usage`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("/api/usage");
  });

  it("passes the accepted page filters and breakdown from the URL into the page", async () => {
    const handle = await startWebServer({
      routes: createUsageRoutes({ fetchUsageQuery: vi.fn(async () => usageResult), cwd, now: () => now,
        pages: [{ label: "Home", path: "/" }, { label: "Usage", path: "/usage" }] }),
      port: 0, initialPath: "/usage", open: false, log: vi.fn(), signalTarget: new EventEmitter(), exit: vi.fn(),
    });
    handles.push(handle);
    const response = await sessionFetch(handle)(`${handle.baseUrl}/usage?period=7d&repo=work&model=m1&agent=codex&since=2026-09-01&until=2026-09-22&by=repo`);
    const html = await response.text();
    expect(html).toContain('"period":"7d"');
    expect(html).toContain('"repo":"work"');
    expect(html).toContain('"model":"m1"');
    expect(html).toContain('"agent":"codex"');
    expect(html).toContain('"since":"2026-09-01"');
    expect(html).toContain('"until":"2026-09-22"');
    expect(html).toContain('"by":"repo"');
    expect(html).toContain('aria-current="page" class="active">Usage</a>');
  });

  it.each([
    ["default today", "", { period: "today" }],
    ["all period", "?period=all", { period: "all" }],
    ["today period", "?period=today", { period: "today" }],
    ["3 day period", "?period=3d", { period: "3d" }],
    ["7 day period", "?period=7d", { period: "7d" }],
    ["30 day period", "?period=30d", { period: "30d" }],
    ["custom day count", "?days=5", { since: new Date(2026, 8, 18, 0, 0, 0, 0).toISOString() }],
    ["all flag", "?all=true", { period: "all" }],
    ["today flag", "?today=true", { period: "today" }],
  ])("maps the %s filter through the shared query builder", async (_label, query, expected) => {
    const fetchUsageQuery = vi.fn(async () => usageResult);
    const handle = await startUsageServer(fetchUsageQuery);

    const response = await sessionFetch(handle)(`${handle.baseUrl}/api/usage${query}`);

    expect(response.status).toBe(200);
    expect(fetchUsageQuery).toHaveBeenCalledWith({
      period: undefined,
      since: undefined,
      until: undefined,
      repository: undefined,
      model: undefined,
      agent: undefined,
      ...expected,
    });
  });

  it("passes scalar filters and lets current override repo", async () => {
    const fetchUsageQuery = vi.fn(async () => usageResult);
    const handle = await startUsageServer(fetchUsageQuery);
    const since = "2026-09-01T00:00:00.000Z";
    const until = "2026-09-20T23:59:59.999Z";

    const response = await sessionFetch(handle)(
      `${handle.baseUrl}/api/usage?repo=%2Fselected%2Frepo&current=true&model=gpt-5.6-luna&agent=codex&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    );

    expect(response.status).toBe(200);
    expect(fetchUsageQuery).toHaveBeenCalledWith({
      period: undefined,
      since,
      until,
      repository: cwd,
      model: "gpt-5.6-luna",
      agent: "codex",
    });
  });

  it("passes the same parameters as the CLI for identical options, cwd, and clock", async () => {
    const fetchUsageQuery = vi.fn(async () => usageResult);
    const handle = await startUsageServer(fetchUsageQuery);
    const cliOptions = {
      all: false,
      today: false,
      days: "5",
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-20T23:59:59.999Z",
      repo: "/selected/repo",
      current: true,
      model: "gpt-5.6-luna",
      agent: "codex",
    };

    const expected = buildUsageQueryParams(cliOptions, cwd, now);
    const response = await sessionFetch(handle)(
      `${handle.baseUrl}/api/usage?days=5&since=${encodeURIComponent(cliOptions.since)}&until=${encodeURIComponent(cliOptions.until)}&repo=%2Fselected%2Frepo&current=true&model=gpt-5.6-luna&agent=codex`,
    );

    expect(response.status).toBe(200);
    expect(fetchUsageQuery).toHaveBeenCalledWith(expected);
  });

  it("returns the injected query result without changing its shape", async () => {
    const fetchUsageQuery = vi.fn(async () => usageResult);
    const handle = await startUsageServer(fetchUsageQuery);

    const response = await sessionFetch(handle)(`${handle.baseUrl}/api/usage?period=all`);

    expect(await response.json()).toEqual(usageResult);
  });

  it("returns a JSON 500 response when the usage query fails", async () => {
    const fetchUsageQuery = vi.fn(async () => {
      throw new Error("fixture query failed");
    });
    const handle = await startUsageServer(fetchUsageQuery);

    const response = await sessionFetch(handle)(`${handle.baseUrl}/api/usage`);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "fixture query failed" });
  });
});
