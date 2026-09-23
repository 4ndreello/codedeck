import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { UsageMetricBucket, UsageQueryResult } from "../src/daemon/protocol.js";
import {
  createUsagePageController,
  buildUsagePageSearch,
  computeDelta,
  captureUsageSearchFocus,
  csvQuote,
  createUsageChartView,
  donutSlices,
  donutCenterFontSize,
  formatChartTooltip,
  formatCompact,
  formatCost,
  formatShare,
  formatUsd,
  filterAndSortUsageRows,
  normalizeUsageInterval,
  previousWindow,
  renderDonutSvg,
  renderLineChartSvg,
  renderModelLegend,
  renderSparklineSvg,
  renderUsageFilterOptions,
  renderUsageTableRows,
  restoreUsageSearchFocus,
  renderUsagePage,
  startUsagePage,
  USAGE_CSS,
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

function createUsageDashboardDom() {
  let activeElement: Record<string, unknown> | null = null;
  let currentSearch: ReturnType<typeof makeElement> | null = null;
  let dashboardHtml = "";
  function makeElement() {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const element = {
      hidden: false,
      textContent: "",
      className: "",
      value: "",
      dataset: {} as Record<string, string | undefined>,
      style: { left: "", top: "" },
      selectionStart: 0,
      selectionEnd: 0,
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) { listeners.set(type, listener); },
      dispatch(type: string) { listeners.get(type)?.({ target: element }); },
      focus() { activeElement = element; },
      setSelectionRange(start: number, end: number) { element.selectionStart = start; element.selectionEnd = end; },
      setAttribute() {},
      getAttribute() { return null; },
      replaceChildren() {},
      append() {},
      click() {},
      closest() { return element; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 880, height: 248 }; },
      querySelector(selector: string) { return selector === "[data-search]" ? currentSearch : null; },
      querySelectorAll() { return []; },
    };
    return element;
  }
  const dashboard = makeElement() as ReturnType<typeof makeElement> & { innerHTML: string };
  Object.defineProperty(dashboard, "innerHTML", {
    get: () => dashboardHtml,
    set: (html: string) => {
      dashboardHtml = html;
      currentSearch = makeElement();
      currentSearch.value = html.match(/<input data-search[^>]* value="([^"]*)"/)?.[1] ?? "";
    },
  });
  currentSearch = makeElement();
  const root = makeElement();
  root.querySelector = (selector: string) => selector === "[data-dashboard]" ? dashboard : null;
  const document = {
    get activeElement() { return activeElement; },
    getElementById: (id: string) => id === "usage-root" ? root : null,
    createElement: () => makeElement(),
    addEventListener() {},
  };
  return {
    document,
    get html() { return dashboardHtml; },
    get search() { return currentSearch; },
    focusSearch() { currentSearch?.focus(); },
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
  it("ignores a stale response when overlapping refreshes resolve out of order", async () => {
    let resolveFirst!: (value: UsagePageFetchResponse) => void;
    const first = new Promise<UsagePageFetchResponse>((resolve) => { resolveFirst = resolve; });
    const secondResult = { ...usageResult, totals: { ...totals, sessionCount: 22 } };
    const fetch = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(response(secondResult));
    const controller = createUsagePageController(controllerOptions({ fetch }));
    const staleRefresh = controller.refresh();
    await controller.refresh();
    resolveFirst(response(usageResult));
    await staleRefresh;
    expect(controller.getState().result?.totals.sessionCount).toBe(22);
  });

  it("ignores an older previous-window response after a newer refresh", async () => {
    let resolveOldPrevious!: (value: UsagePageFetchResponse) => void;
    const oldPrevious = new Promise<UsagePageFetchResponse>((resolve) => { resolveOldPrevious = resolve; });
    const currentNew = { ...usageResult, totals: { ...totals, sessionCount: 22 } };
    const previousNew = { ...usageResult, totals: { ...totals, sessionCount: 11 } };
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return response(usageResult);
      if (calls === 2) return oldPrevious;
      if (calls === 3) return response(currentNew);
      return response(previousNew);
    });
    const controller = createUsagePageController(controllerOptions({ fetch, initialFilters: { period: "3d" } }));
    const older = controller.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const newer = controller.refresh();
    await newer;
    resolveOldPrevious(response(usageResult));
    await older;
    expect(controller.getState().result?.totals.sessionCount).toBe(22);
    expect(controller.getState().previous?.totals.sessionCount).toBe(11);
  });

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
    await vi.waitFor(() => expect(options.fetch).toHaveBeenCalledTimes(6));

    const lastUrl = new URL(String(options.fetch.mock.lastCall?.[0]), "http://localhost");
    expect(options.fetch).toHaveBeenCalledTimes(6);
    expect(lastUrl.searchParams.get("period")).toBeNull();
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

  it("writes the active filters and breakdown to the shareable URL", async () => {
    const replaceUrl = vi.fn();
    const options = controllerOptions({ replaceUrl });
    const controller = createUsagePageController(options);
    await controller.setFilter("period", "7d");
    await controller.setFilter("repo", "/workspace");
    controller.setBreakdown("repo");
    expect(replaceUrl).toHaveBeenLastCalledWith("?period=7d&repo=%2Fworkspace&by=repo");
  });

  it("does not show loading for a background poll and clears its timer when stopped", async () => {
    let poll: (() => void) | undefined;
    const render = vi.fn((_state: UsagePageState) => {});
    const clearInterval = vi.fn();
    const options = controllerOptions({
      render,
      clearInterval,
      setInterval: vi.fn((callback: () => void) => { poll = callback; return 42; }),
    });
    const controller = createUsagePageController(options);
    await controller.start();
    render.mockClear();
    poll?.();
    await vi.waitFor(() => expect(options.fetch).toHaveBeenCalledTimes(2));
    expect(render.mock.calls.every(([state]) => !state.loading)).toBe(true);
    controller.stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
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

    expect(html.match(/data-range(?=\s)/g)).toHaveLength(1);
    expect(html.match(/data-live(?=\s)/g)).toHaveLength(1);
    expect(html).not.toContain('data-action="refresh"');
    expect(html).toContain('aria-current="page" class="active">Usage</a>');
    expect(html).toContain('<h1>Usage</h1>');
    expect(html).toContain('class="usage-actions"');
    expect(html).toContain('data-copy>Copy link</button>');
    expect(html).toContain('data-export>Export CSV</button>');
    expect(html.indexOf('class="usage-header"')).toBeLessThan(html.indexOf('class="filterbar"'));
    expect(html).toContain('href="/"');
    expect(html).toContain('data-filter="period"');
    expect(html).toContain('data-filter-kind="repo"');
    expect(html).toContain('data-filter-kind="model"');
    expect(html).toContain('data-filter-kind="agent"');
    expect(html).toContain('data-filter="since"');
    expect(html).toContain('data-filter="until"');
    expect(html).toContain('data-breakdown="${name}"');
    for (const breakdown of ["day", "repo", "model", "agent", "run", "origin"]) expect(html).toContain(`"${breakdown}"`);
    expect(html).toContain('"by":"origin"');
    expect(html).toContain("sessionsWithoutCost");
  });

  it("binds native browser functions to the global receiver", async () => {
    const context = vm.createContext({
      fetchCalls: 0,
      document: { getElementById: () => null },
    });
    vm.runInContext(`
      fetch = function() { if (this !== globalThis) throw new TypeError("Illegal invocation"); fetchCalls += 1; return Promise.resolve({}); };
      setInterval = function() { if (this !== globalThis) throw new TypeError("Illegal invocation"); return 19; };
      clearInterval = function(handle) { if (this !== globalThis || handle !== 19) throw new TypeError("Illegal invocation"); };
    `, context);
    const script = USAGE_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("usage page inline script is missing");
    vm.runInContext(script, context);
    await vm.runInContext("usageEnvironment.fetch('/api/usage').then(() => { const timer=usageEnvironment.setInterval(() => {},20); usageEnvironment.clearInterval(timer); })", context);
    expect((context as unknown as { fetchCalls: number }).fetchCalls).toBe(1);
  });
});

describe("usage page formatting and chart helpers", () => {
  it("escapes hostile labels in SVG titles, the model legend and table rows", () => {
    const hostile = { ...bucket, key: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>' };
    const donut = renderDonutSvg([hostile]);
    const line = renderLineChartSvg([hostile]);
    const legend = renderModelLegend([hostile]);
    const table = renderUsageTableRows([hostile], hostile.costUsd, false);
    for (const html of [donut, line, legend, table]) expect(html).not.toMatch(/<img\b/i);
    expect(donut).toContain("&lt;img");
    expect(line).toContain("&lt;img");
  });

  it("filters rows before applying the top ten limit", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...bucket, key: `row-${index + 1}`, label: `row-${index + 1}` }));
    const filtered = filterAndSortUsageRows(rows, "row-15", "costUsd", -1);
    const html = renderUsageTableRows(filtered, filtered[0].costUsd, false);
    expect(filtered).toHaveLength(1);
    expect(html).toContain(">row-15</td>");
    expect(html).not.toContain("hidden");
  });

  it("restores search focus and its selection after a render", () => {
    const selection = vi.fn();
    const focus = vi.fn();
    const input = { value: "row-15", selectionStart: 3, selectionEnd: 5, focus, setSelectionRange: selection };
    const state = captureUsageSearchFocus({ activeElement: input } as never, input as never);
    const replacement = { value: "", focus, setSelectionRange: selection };
    restoreUsageSearchFocus(replacement as never, state);
    expect(state.focused).toBe(true);
    expect(replacement.value).toBe("row-15");
    expect(focus).toHaveBeenCalledOnce();
    expect(selection).toHaveBeenCalledWith(3, 5);
  });

  it("keeps search focus and selection through a dashboard render", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...bucket, key: `run-${index + 1}`, label: `row-${index + 1}` }));
    const result = { ...usageResult, byRun: rows };
    const dom = createUsageDashboardDom();
    startUsagePage({ by: "run" }, {
      fetch: async () => response(result), setInterval: () => 1, clearInterval: () => {}, document: dom.document as never,
    });
    await vi.waitFor(() => expect(dom.html).toContain('data-search'));
    const search = dom.search!;
    search.value = "row-15";
    search.selectionStart = 3;
    search.selectionEnd = 5;
    dom.focusSearch();
    search.dispatch("input");
    expect(dom.document.activeElement).toBe(dom.search);
    expect(dom.search?.selectionStart).toBe(3);
    expect(dom.search?.selectionEnd).toBe(5);
  });

  it("filters dashboard rows before applying the top ten limit", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...bucket, key: `run-${index + 1}`, label: `row-${index + 1}` }));
    const result = { ...usageResult, byRun: rows };
    const dom = createUsageDashboardDom();
    startUsagePage({ by: "run" }, {
      fetch: async () => response(result), setInterval: () => 1, clearInterval: () => {}, document: dom.document as never,
    });
    await vi.waitFor(() => expect(dom.html).toContain("row-10"));
    const search = dom.search!;
    search.value = "row-15";
    search.dispatch("input");
    expect(dom.html).toContain('<tr><td title="row-15">row-15</td>');
    expect(dom.html).not.toContain(">row-1</td>");
    expect(dom.html.match(/<tbody><tr/g)).toHaveLength(1);
  });

  it("quotes CSV fields by doubling embedded quotes", () => {
    expect(csvQuote('model "fast", v2')).toBe('"model ""fast"", v2"');
  });

  it("uses a stable key for filter option values and the label for display", () => {
    const options = renderUsageFilterOptions([{ ...bucket, key: "model-id", label: "Friendly model" }], "model");
    expect(options).toContain('<option value="model-id">Friendly model</option>');
  });

  it.each([[999, "999"], [10_000, "10K"], [842_310, "842K"], [16_756_717, "16.8M"], [1_193_095_059, "1.19B"]])(
    "formats %s as %s", (value, expected) => expect(formatCompact(value)).toBe(expected),
  );
  it("formats currency, shares, incomplete cost and deltas", () => {
    expect(formatUsd(1865.421706)).toBe("$1,865.42");
    expect(formatShare(47.84, "spend")).toBe("47.8% of spend");
    expect(formatCost(1865.421706, false, 104)).toContain("≥ $1,865.42");
    expect(formatCost(1865.421706, false, 104)).toContain("104 unpriced");
    expect(formatCost(1865.421706, false, 104)).not.toContain("?");
    expect(computeDelta(10, 0, "7d")).toBeUndefined();
    expect(computeDelta(10, 5, "today")).toBeUndefined();
    expect(computeDelta(10, 5, "7d")).toEqual({ direction: "up", percent: 100 });
  });
  it("uses calendar days for a 30d previous window across the New York DST change", () => {
    const priorTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const window = previousWindow("30d", new Date("2026-04-01T12:00:00.000Z"))!;
      expect(window.until).toBe("2026-03-02T12:59:59.999Z");
      expect(window.since).toBe("2026-01-31T12:59:59.999Z");
      const crossing = previousWindow("30d", new Date("2026-04-10T12:00:00.000Z"))!;
      expect(crossing.until).toBe("2026-03-11T11:59:59.999Z");
      expect(crossing.since).toBe("2026-02-09T12:59:59.999Z");
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
    }
  });
  it("groups model slices into the top six plus Other and formats the donut center as spend", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ ...bucket, key: `model-${index}`, label: `model-${index}`, costUsd: 8 - index }));
    const slices = donutSlices(rows);
    expect(slices).toHaveLength(7);
    expect(slices.at(-1)?.label).toBe("Other");
    expect(slices.reduce((sum, row) => sum + row.costUsd, 0)).toBe(rows.reduce((sum, row) => sum + row.costUsd, 0));
    expect(renderDonutSvg(rows)).toContain("$36.00");
    const legend = renderModelLegend(rows);
    expect((legend.match(/class="legend-row"/g) ?? [])).toHaveLength(7);
    expect(legend).toContain("model-5");
    expect(legend).toContain("Other");
    expect(donutCenterFontSize("$1,890.76")).toBe(10);
    expect(renderDonutSvg([{ ...bucket, costUsd: 1890.76 }])).toContain('font-size:10px');
    expect(formatChartTooltip({ ...bucket, totalTokens: 16_756_717 }, "totalTokens")).toEqual({ text: "Codex · 16.8M", title: "16756717" });
  });
  it("renders measured-width charts with stable axis text and a crosshair", () => {
    const rows = [bucket, { ...bucket, key: "2026-09-23", costUsd: 0.3 }];
    const narrow = renderLineChartSvg(rows, "costUsd", 360);
    const wide = renderLineChartSvg(rows, "costUsd", 1200);
    expect(narrow).toContain('width="360" height="248" viewBox="0 0 360 248"');
    expect(wide).toContain('width="1200" height="248" viewBox="0 0 1200 248"');
    expect(USAGE_CSS.match(/\.axis\{font:(\d+)px/)?.[1]).toBe("11");
    expect(narrow).toContain('class="chart-crosshair" data-crosshair');
    expect(narrow).not.toContain('preserveAspectRatio="none"');
    expect(renderLineChartSvg([])).toContain("No usage in this range");
    expect(renderDonutSvg([])).toContain("No usage in this range");
  });
  it("renders a one-point sparkline as a flat line without an area path", () => {
    const svg = renderSparklineSvg([0.25], "Spend");

    expect(svg).toContain('<path class="spark-line" d="M0 24.0 L280 24.0"/>');
    expect(svg).not.toContain('class="spark-area"');
  });
  it("renders one day as a masked point with a trend caption", () => {
    const svg = renderLineChartSvg([{ ...bucket, key: "2026-04-01", label: "Apr 1", costUsd: 12.5 }]);

    expect(svg).toContain('<circle class="chart-point" cx="440" cy="124" r="4">');
    expect(svg).toContain('title="12.5">$12.50</text>');
    expect(svg).toContain("Single day. Pick a longer range for a trend.");
    expect(svg).not.toContain('class="chart-area"');
  });
  it("reserves enough chart space for the longest y-axis tick", () => {
    const svg = renderLineChartSvg([{ ...bucket, costUsd: 565.47 }, { ...bucket, key: "2026-09-23", costUsd: 500 }], "costUsd", 360);
    const ticks = [...svg.matchAll(/<text class="axis" x="([\d.]+)" y="[\d.]+" text-anchor="end" title="[\d.]+">(.*?)<\/text>/g)];

    expect(ticks).toHaveLength(5);
    for (const [, x, label] of ticks) expect(Number(x)).toBeGreaterThanOrEqual(label.length * 6.7);
  });
  it("keeps the last x-axis label inside the chart width", () => {
    const rows = [
      { ...bucket, key: "2026-09-22", costUsd: 10 },
      { ...bucket, key: "2026-09-23", costUsd: 20 },
    ];
    const width = 360;
    const svg = renderLineChartSvg(rows, "costUsd", width);
    const labels = [...svg.matchAll(/<text class="axis" x="([\d.]+)" y="[\d.]+" text-anchor="(start|middle|end)"[^>]*>(.*?)<\/text>/g)];
    const [, x, anchor, label] = labels.at(-1)!;

    expect(label).toBe("09-23");
    expect(anchor).toBe("end");
    expect(Number(x)).toBeLessThanOrEqual(width);
  });
  it("keeps the selected chart series when a resize renders at a new width", () => {
    const chart = createUsageChartView();
    chart.select("totalTokens");
    const before = chart.render([bucket], 360);
    const after = chart.render([bucket], 1200);
    expect(before).toContain('aria-label="totalTokens over time"');
    expect(after).toContain('aria-label="totalTokens over time"');
    expect(chart.getSeries()).toBe("totalTokens");
  });
  it("builds stable shareable query strings", () => {
    expect(buildUsagePageSearch({ filters: { period: "7d", repo: "a/b", model: "", agent: "codex", since: "", until: "" }, by: "repo" }))
      .toBe("?period=7d&repo=a%2Fb&agent=codex&by=repo");
  });
});
