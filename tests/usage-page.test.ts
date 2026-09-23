import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { UsageMetricBucket, UsageQueryResult } from "../src/daemon/protocol.js";
import {
  createUsagePageController,
  normalizeUsageInterval,
  renderUsagePage,
  toUsagePageData,
  USAGE_PAGE,
  type UsagePageControllerOptions,
  type UsagePageFetchResponse,
  type UsagePageState,
} from "../src/web/usage-page.js";

const totals = {
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
};

const bucket: UsageMetricBucket = {
  key: "codex",
  label: "Codex",
  sessionCount: 2,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 5,
  totalTokens: 125,
  costUsd: 0.25,
  costComplete: true,
  trend: [0.1, 0.15],
};

const usageResult: UsageQueryResult = {
  range: { period: "7d", since: "2026-09-16T00:00:00.000Z", until: "2026-09-22T23:59:59.999Z" },
  totals,
  byDay: [bucket],
  byRepository: [{ ...bucket, key: "/workspace" }],
  byModel: [{ ...bucket, key: "gpt-5.6-luna" }],
  byAgent: [bucket],
  byRun: [{ ...bucket, key: "run-1" }],
  byOrigin: [{ ...bucket, key: "orchestrator" }],
};

function response(value: unknown, ok = true): UsagePageFetchResponse {
  return { ok, json: async () => value };
}

function controllerOptions(overrides: Partial<UsagePageControllerOptions> = {}) {
  const fetch = vi.fn(async () => response(usageResult));
  const setInterval = vi.fn((_callback: () => void, _milliseconds: number) => 1);
  const clearInterval = vi.fn();
  const render = vi.fn((_state: UsagePageState) => {});
  return {
    fetch,
    setInterval,
    clearInterval,
    render,
    ...overrides,
  };
}

describe("usage page data", () => {
  it("exposes every total and all available breakdown buckets", () => {
    const data = toUsagePageData(usageResult);

    expect(data.totals).toEqual(totals);
    expect(data.byDay).toEqual([bucket]);
    expect(data.byRepository).toEqual([{ ...bucket, key: "/workspace" }]);
    expect(data.byModel).toEqual([{ ...bucket, key: "gpt-5.6-luna" }]);
    expect(data.byAgent).toEqual([bucket]);
    expect(data.byRun).toEqual([{ ...bucket, key: "run-1" }]);
    expect(data.byOrigin).toEqual([{ ...bucket, key: "orchestrator" }]);
  });

  it("uses an empty origin breakdown for a result from an older daemon", () => {
    const olderResult = { ...usageResult } as UsageQueryResult & { byOrigin?: UsageMetricBucket[] };
    delete olderResult.byOrigin;

    const data = toUsagePageData(olderResult);

    expect(data.byOrigin).toEqual([]);
    expect(data.byDay).toEqual([bucket]);
    expect(data.totals).toEqual(totals);
  });
});

describe("usage page behavior", () => {
  it("re-queries when period, repo, model, agent, since, and until change", async () => {
    const options = controllerOptions({
      initialFilters: { period: "3d", repo: "/old", model: "", agent: "", since: "", until: "" },
    });
    const controller = createUsagePageController(options);

    for (const [field, value] of [
      ["period", "all"],
      ["repo", "/new"],
      ["model", "gpt-5.6-luna"],
      ["agent", "codex"],
      ["since", "2026-09-01"],
      ["until", "2026-09-22"],
    ] as const) {
      await controller.setFilter(field, value);
      const requested = new URL(String(options.fetch.mock.lastCall?.[0]), "http://localhost");
      expect(requested.searchParams.get(field)).toBe(value);
      expect(controller.getState().filters[field]).toBe(value);
    }

    expect(options.fetch).toHaveBeenCalledTimes(6);
  });

  it("keeps an explicit since filter out of the default today period", async () => {
    const options = controllerOptions({ initialFilters: { since: "2026-09-01" } });
    const controller = createUsagePageController(options);

    await controller.refresh();

    expect(controller.getState().filters.period).toBe("");
    expect(options.fetch).toHaveBeenCalledWith("/api/usage?since=2026-09-01");
  });

  it("polls using the normalized interval and the active filter set", async () => {
    let poll: (() => void) | undefined;
    const options = controllerOptions({
      initialFilters: { period: "7d", repo: "", model: "", agent: "", since: "", until: "" },
      interval: "2",
      setInterval: vi.fn((callback: () => void, milliseconds: number) => {
        poll = callback;
        expect(milliseconds).toBe(2000);
        return 24;
      }),
    });
    const controller = createUsagePageController(options);

    await controller.start();
    await controller.setFilter("model", "gpt-5.6-luna");
    poll?.();

    const lastUrl = new URL(String(options.fetch.mock.lastCall?.[0]), "http://localhost");
    expect(options.fetch).toHaveBeenCalledTimes(3);
    expect(lastUrl.searchParams.get("period")).toBe("7d");
    expect(lastUrl.searchParams.get("model")).toBe("gpt-5.6-luna");
    controller.stop();
    expect(options.clearInterval).toHaveBeenCalledWith(24);
  });

  it.each([
    ["0", 2],
    ["not-a-number", 2],
    ["-1", 1],
    ["0.5", 1],
    ["2", 2],
  ])("normalizes interval %s to %s seconds", (value, seconds) => {
    expect(normalizeUsageInterval(value)).toBe(seconds);
  });

  it("selects origin initially and keeps every breakdown available", () => {
    const controller = createUsagePageController(controllerOptions({ initialBy: "origin" }));

    expect(controller.getState().selectedBreakdown).toBe("origin");
    expect(controller.getState().breakdowns).toEqual(["day", "repo", "model", "agent", "run", "origin"]);

    controller.setBreakdown("run");
    expect(controller.getState().selectedBreakdown).toBe("run");
  });

  it("keeps the last good result visible and stores an error after a failed query", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(usageResult))
      .mockResolvedValueOnce(response({ error: "daemon unavailable" }, false));
    const render = vi.fn((_state: UsagePageState) => {});
    const controller = createUsagePageController(controllerOptions({ fetch, render }));

    await controller.refresh();
    const successfulResult = controller.getState().result;
    await controller.refresh();

    expect(controller.getState().result).toEqual(successfulResult);
    expect(controller.getState().error).toBe("daemon unavailable");
    expect(render.mock.lastCall?.[0].result).toEqual(successfulResult);
    expect(render.mock.lastCall?.[0].error).toBe("daemon unavailable");
  });

  it("injects executable behavior functions into the standalone page", async () => {
    const script = USAGE_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("usage page inline script is missing");

    const document = { getElementById: () => null };
    const context = vm.createContext({
      fetch: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      document,
    });
    vm.runInContext(script, context);

    const pageFunctions = context as unknown as {
      createUsagePageController: typeof createUsagePageController;
      fetch: UsagePageControllerOptions["fetch"];
      setInterval: UsagePageControllerOptions["setInterval"];
      clearInterval: UsagePageControllerOptions["clearInterval"];
    };
    const fetch = vi.fn(async () => response({ ...usageResult, byOrigin: undefined }));
    const render = vi.fn((_state: UsagePageState) => {});
    const controller = pageFunctions.createUsagePageController({
      initialBy: "origin",
      fetch,
      setInterval: pageFunctions.setInterval,
      clearInterval: pageFunctions.clearInterval,
      render,
    });

    await controller.refresh();

    const state = JSON.parse(JSON.stringify(controller.getState())) as UsagePageState;
    expect(state.selectedBreakdown).toBe("origin");
    expect(state.error).toBeUndefined();
    expect(state.result).not.toBeNull();
    expect(state.result?.byOrigin).toEqual([]);
    expect(state.result?.byDay).toEqual([bucket]);
    expect(state.result?.totals).toEqual(totals);
  });

  it("renders the filter controls and every breakdown section", () => {
    const html = renderUsagePage({ by: "origin" });

    expect(html).toContain('data-filter="period"');
    expect(html).toContain('data-filter="repo"');
    expect(html).toContain('data-filter="model"');
    expect(html).toContain('data-filter="agent"');
    expect(html).toContain('data-filter="since"');
    expect(html).toContain('data-filter="until"');
    for (const breakdown of ["day", "repo", "model", "agent", "run", "origin"]) {
      expect(html).toContain(`data-breakdown="${breakdown}"`);
    }
    expect(html).toContain('"by":"origin"');
    expect(html).toContain("sessionsWithoutCost");
  });
});
