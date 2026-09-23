import type { UsageMetricBucket, UsageQueryResult } from "../daemon/protocol.js";

export type UsageBreakdown = "day" | "repo" | "model" | "agent" | "run" | "origin";

export interface UsagePageFilters {
  period: string;
  repo: string;
  model: string;
  agent: string;
  since: string;
  until: string;
}

export interface UsagePageData extends Omit<UsageQueryResult, "byOrigin"> {
  byOrigin: UsageMetricBucket[];
}

export interface UsagePageState {
  filters: UsagePageFilters;
  result: UsagePageData | null;
  error?: string;
  loading: boolean;
  selectedBreakdown: UsageBreakdown;
  breakdowns: UsageBreakdown[];
  intervalSeconds: number;
}

export interface UsagePageFetchResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

export interface UsagePageControllerOptions {
  initialFilters?: Partial<UsagePageFilters>;
  initialBy?: UsageBreakdown;
  interval?: unknown;
  fetch: (url: string) => Promise<UsagePageFetchResponse>;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  render: (state: UsagePageState) => void;
}

export interface UsagePageController {
  getState(): UsagePageState;
  refresh(): Promise<UsagePageState>;
  setFilter(name: keyof UsagePageFilters, value: string): Promise<UsagePageState>;
  setBreakdown(name: UsageBreakdown): void;
  start(): Promise<void>;
  stop(): void;
}

export interface UsagePageOptions {
  by?: UsageBreakdown;
  interval?: unknown;
  filters?: Partial<UsagePageFilters>;
}

export interface UsagePageEnvironment {
  fetch: (url: string) => Promise<UsagePageFetchResponse>;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  document: UsagePageDocument;
}

interface UsagePageElement {
  hidden: boolean;
  textContent: string | null;
  className: string;
  value: string;
  dataset: Record<string, string | undefined>;
  querySelector<T extends UsagePageElement = UsagePageElement>(selector: string): T | null;
  querySelectorAll<T extends UsagePageElement = UsagePageElement>(selector: string): T[];
  setAttribute(name: string, value: string): void;
  replaceChildren(...nodes: UsagePageElement[]): void;
  append(...nodes: UsagePageElement[]): void;
  addEventListener(type: string, listener: (event: UsagePageEvent) => void): void;
  closest<T extends UsagePageElement = UsagePageElement>(selector: string): T | null;
}

interface UsagePageDocument {
  getElementById(id: string): UsagePageElement | null;
  createElement(tagName: string): UsagePageElement;
}

interface UsagePageEvent {
  target?: UsagePageElement | null;
}

export function normalizeUsageInterval(value: unknown): number {
  return Math.max(1, Number(value) || 2);
}

export function buildUsageApiUrl(filters: UsagePageFilters): string {
  const params: string[] = [];
  for (const name of ["period", "repo", "model", "agent", "since", "until"] as const) {
    const value = filters[name];
    if (value) params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  const query = params.join("&");
  return query ? `/api/usage?${query}` : "/api/usage";
}

export function toUsagePageData(result: UsageQueryResult): UsagePageData {
  return {
    range: { ...result.range },
    totals: {
      sessionCount: result.totals.sessionCount,
      activeSessionCount: result.totals.activeSessionCount,
      completedSessionCount: result.totals.completedSessionCount,
      failedSessionCount: result.totals.failedSessionCount,
      inputTokens: result.totals.inputTokens,
      outputTokens: result.totals.outputTokens,
      cachedTokens: result.totals.cachedTokens,
      totalTokens: result.totals.totalTokens,
      costUsd: result.totals.costUsd,
      costComplete: result.totals.costComplete,
      sessionsWithoutCost: result.totals.sessionsWithoutCost,
    },
    byDay: [...result.byDay],
    byRepository: [...result.byRepository],
    byModel: [...result.byModel],
    byAgent: [...result.byAgent],
    byRun: [...result.byRun],
    byOrigin: [...(result.byOrigin ?? [])],
  };
}

export function createUsagePageController(options: UsagePageControllerOptions): UsagePageController {
  const breakdowns: UsageBreakdown[] = ["day", "repo", "model", "agent", "run", "origin"];
  const state: UsagePageState = {
    filters: {
      period: options.initialFilters?.period ?? (options.initialFilters?.since ? "" : "today"),
      repo: options.initialFilters?.repo ?? "",
      model: options.initialFilters?.model ?? "",
      agent: options.initialFilters?.agent ?? "",
      since: options.initialFilters?.since ?? "",
      until: options.initialFilters?.until ?? "",
    },
    result: null,
    error: undefined,
    loading: false,
    selectedBreakdown: breakdowns.includes(options.initialBy as UsageBreakdown)
      ? options.initialBy as UsageBreakdown
      : "day",
    breakdowns,
    intervalSeconds: normalizeUsageInterval(options.interval),
  };
  let timer: unknown;
  let started = false;

  function getState(): UsagePageState {
    return {
      ...state,
      filters: { ...state.filters },
      breakdowns: [...state.breakdowns],
    };
  }

  function publish(): void {
    options.render(getState());
  }

  async function refresh(): Promise<UsagePageState> {
    state.loading = true;
    publish();
    try {
      const response = await options.fetch(buildUsageApiUrl(state.filters));
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Usage query failed with HTTP ${response.status ?? 500}`;
        throw new Error(message);
      }
      state.result = toUsagePageData(payload as UsageQueryResult);
      state.error = undefined;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      publish();
    }
    return getState();
  }

  async function setFilter(name: keyof UsagePageFilters, value: string): Promise<UsagePageState> {
    if (!(name in state.filters)) return getState();
    const nextValue = String(value);
    if (state.filters[name] === nextValue) return getState();
    state.filters[name] = nextValue;
    return refresh();
  }

  function setBreakdown(name: UsageBreakdown): void {
    if (!state.breakdowns.includes(name)) return;
    state.selectedBreakdown = name;
    publish();
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
    timer = options.setInterval(() => {
      void refresh();
    }, state.intervalSeconds * 1000);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    options.clearInterval(timer);
    timer = undefined;
  }

  return { getState, refresh, setFilter, setBreakdown, start, stop };
}

export function renderUsagePageState(root: UsagePageElement, state: UsagePageState, document: UsagePageDocument): void {
  const error = root.querySelector("[data-error]");
  if (error) {
    error.hidden = !state.error;
    error.textContent = state.error ?? "";
  }

  const loading = root.querySelector("[data-loading]");
  if (loading) loading.textContent = state.loading ? "Updating usage..." : "";

  for (const button of root.querySelectorAll("[data-breakdown]")) {
    button.setAttribute("aria-pressed", String(button.dataset.breakdown === state.selectedBreakdown));
  }

  const totalsRoot = root.querySelector("[data-totals]");
  const breakdownRoot = root.querySelector("[data-breakdowns]");
  totalsRoot?.replaceChildren();
  breakdownRoot?.replaceChildren();
  if (!state.result) return;

  const totalLabels: Record<keyof UsageQueryResult["totals"], string> = {
    sessionCount: "Sessions",
    activeSessionCount: "Active sessions",
    completedSessionCount: "Completed sessions",
    failedSessionCount: "Failed sessions",
    inputTokens: "Input tokens",
    outputTokens: "Output tokens",
    cachedTokens: "Cached tokens",
    totalTokens: "Total tokens",
    costUsd: "Cost (USD)",
    costComplete: "Cost complete",
    sessionsWithoutCost: "Sessions without cost",
  };
  for (const [name, label] of Object.entries(totalLabels) as [keyof UsageQueryResult["totals"], string][]) {
    const card = document.createElement("article");
    card.className = "usage-total";
    const heading = document.createElement("h3");
    heading.textContent = label;
    const value = document.createElement("p");
    const rawValue = state.result.totals[name];
    value.textContent = name === "costUsd"
      ? `$${Number(rawValue).toFixed(2)}${state.result.totals.costComplete ? "" : "?"}`
      : name === "costComplete"
        ? rawValue ? "Complete" : "Incomplete"
        : String(rawValue);
    card.append(heading, value);
    totalsRoot?.append(card);
  }

  const groups: [UsageBreakdown, string, UsageMetricBucket[]][] = [
    ["day", "By day", state.result.byDay],
    ["repo", "By repository", state.result.byRepository],
    ["model", "By model", state.result.byModel],
    ["agent", "By agent", state.result.byAgent],
    ["run", "By run", state.result.byRun],
    ["origin", "By origin", state.result.byOrigin],
  ];
  for (const [name, title, buckets] of groups) {
    const section = document.createElement("section");
    section.className = name === state.selectedBreakdown ? "usage-breakdown selected" : "usage-breakdown";
    section.dataset.breakdownSection = name;
    const heading = document.createElement("h2");
    heading.textContent = title;
    section.append(heading);
    if (buckets.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No usage recorded.";
      section.append(empty);
    }
    for (const bucket of buckets) {
      const row = document.createElement("article");
      row.className = "usage-bucket";
      const label = document.createElement("strong");
      label.textContent = bucket.label ?? bucket.key;
      const metrics = document.createElement("span");
      const cost = `$${bucket.costUsd.toFixed(2)}${bucket.costComplete ? "" : "?"}`;
      metrics.textContent = `${bucket.sessionCount} sessions · ${bucket.inputTokens} input · ${bucket.outputTokens} output · ${bucket.cachedTokens} cached · ${cost}`;
      row.append(label, metrics);
      section.append(row);
    }
    breakdownRoot?.append(section);
  }
}

export function startUsagePage(options: UsagePageOptions, environment: UsagePageEnvironment): UsagePageController | undefined {
  const root = environment.document.getElementById("usage-root");
  if (!root) return undefined;

  for (const control of root.querySelectorAll("[data-filter]")) {
    const name = control.dataset.filter as keyof UsagePageFilters | undefined;
    if (name && options.filters?.[name] !== undefined) control.value = options.filters[name] ?? "";
  }

  const controller = createUsagePageController({
    initialFilters: options.filters,
    initialBy: options.by,
    interval: options.interval,
    fetch: environment.fetch,
    setInterval: environment.setInterval,
    clearInterval: environment.clearInterval,
    render: (state) => renderUsagePageState(root, state, environment.document),
  });

  root.addEventListener("change", (event) => {
    const target = event.target ?? null;
    const name = target?.dataset.filter as keyof UsagePageFilters | undefined;
    if (target && name) void controller.setFilter(name, target.value);
  });
  root.addEventListener("click", (event) => {
    const target = event.target ?? null;
    const button = target?.closest("[data-breakdown]");
    const name = button?.dataset.breakdown as UsageBreakdown | undefined;
    if (name) controller.setBreakdown(name);
  });
  void controller.start();
  return controller;
}

export function renderUsagePage(options: UsagePageOptions = {}): string {
  const pageOptions = {
    by: options.by ?? "day",
    interval: options.interval ?? 2,
    filters: options.filters ?? {},
  };
  const serializedOptions = JSON.stringify(pageOptions).replaceAll("<", "\\u003c");
  const behaviorSource = [
    normalizeUsageInterval,
    buildUsageApiUrl,
    toUsagePageData,
    createUsagePageController,
    renderUsagePageState,
    startUsagePage,
  ].map((behavior) => Function.prototype.toString.call(behavior)).join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeDeck usage</title>
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b0d12; color: #edf0f5; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  header { padding: 24px clamp(18px, 4vw, 48px); border-bottom: 1px solid #252a34; background: #11151d; }
  header h1 { margin: 0 0 5px; font-size: 24px; }
  header p { margin: 0; color: #9ba5b4; font-size: 13px; }
  main { max-width: 1440px; margin: 0 auto; padding: 24px clamp(18px, 4vw, 48px) 56px; }
  .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  label { display: grid; gap: 6px; color: #aeb7c5; font-size: 12px; }
  input, select { min-width: 0; width: 100%; border: 1px solid #333b49; border-radius: 7px; padding: 9px 10px; background: #151a23; color: #edf0f5; font: inherit; }
  [data-loading] { min-height: 18px; color: #9ba5b4; font-size: 12px; }
  [data-error] { margin: 12px 0; padding: 12px; border: 1px solid #713d46; border-radius: 8px; background: #301a21; color: #ffb8c0; }
  [data-error][hidden] { display: none; }
  h2 { margin: 25px 0 12px; font-size: 16px; }
  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .usage-total, .usage-breakdown { border: 1px solid #252c38; border-radius: 9px; background: #11151d; }
  .usage-total { padding: 13px; }
  .usage-total h3 { margin: 0 0 8px; color: #9ba5b4; font-size: 11px; font-weight: 500; }
  .usage-total p { margin: 0; font-size: 20px; font-variant-numeric: tabular-nums; }
  .breakdown-tabs { display: flex; flex-wrap: wrap; gap: 7px; padding: 0; border: 0; }
  .breakdown-tabs button { border: 1px solid #333b49; border-radius: 99px; padding: 7px 12px; background: #151a23; color: #bac3d0; cursor: pointer; font: inherit; font-size: 12px; }
  .breakdown-tabs button[aria-pressed="true"] { border-color: #7399ff; background: #20315a; color: #fff; }
  .usage-breakdown { margin: 10px 0; padding: 14px; }
  .usage-breakdown.selected { border-color: #526eaa; }
  .usage-breakdown h2 { margin: 0 0 10px; }
  .usage-bucket { display: flex; justify-content: space-between; gap: 18px; border-top: 1px solid #252c38; padding: 10px 0; font-size: 12px; }
  .usage-bucket span, .empty { color: #9ba5b4; text-align: right; }
  @media (max-width: 680px) { .usage-bucket { display: grid; gap: 5px; } .usage-bucket span { text-align: left; } }
</style>
</head>
<body>
<header><h1>Usage</h1><p>Token totals, costs, and session breakdowns</p></header>
<main id="usage-root">
  <div class="filters" role="group" aria-label="Usage filters">
    <label>Period<select data-filter="period" name="period">
      <option value="today">Today</option><option value="3d">Last 3 days</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option><option value="">Custom range</option>
    </select></label>
    <label>Repository<input data-filter="repo" name="repo" type="text" autocomplete="off"></label>
    <label>Model<input data-filter="model" name="model" type="text" autocomplete="off"></label>
    <label>Agent<input data-filter="agent" name="agent" type="text" autocomplete="off"></label>
    <label>Since<input data-filter="since" name="since" type="date"></label>
    <label>Until<input data-filter="until" name="until" type="date"></label>
  </div>
  <div data-loading role="status" aria-live="polite"></div>
  <div data-error role="alert" hidden></div>
  <section aria-labelledby="totals-heading"><h2 id="totals-heading">Totals</h2><div class="totals" data-totals></div></section>
  <section aria-labelledby="breakdowns-heading"><h2 id="breakdowns-heading">Breakdowns</h2>
    <nav class="breakdown-tabs" aria-label="Usage breakdowns">
      <button type="button" data-breakdown="day">Day</button><button type="button" data-breakdown="repo">Repository</button>
      <button type="button" data-breakdown="model">Model</button><button type="button" data-breakdown="agent">Agent</button>
      <button type="button" data-breakdown="run">Run</button><button type="button" data-breakdown="origin">Origin</button>
    </nav>
    <div data-breakdowns></div>
  </section>
</main>
<script>
${behaviorSource}
startUsagePage(${serializedOptions}, { fetch, setInterval, clearInterval, document });
</script>
</body>
</html>`;
}

export const USAGE_PAGE = renderUsagePage();
