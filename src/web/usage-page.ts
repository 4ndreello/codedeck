import type { UsageMetricBucket, UsageQueryResult } from "../daemon/protocol.js";
import { BRAND_CSS, LOGO_FAVICON_HREF, renderTopBar, type WebPageLink } from "./brand.js";

export type UsageBreakdown = "day" | "repo" | "model" | "agent" | "run" | "origin";
export interface UsagePageFilters { period: string; repo: string; model: string; agent: string; since: string; until: string; }
export interface UsagePageData extends Omit<UsageQueryResult, "byOrigin"> { byOrigin: UsageMetricBucket[]; }
export interface UsagePageState {
  filters: UsagePageFilters;
  result: UsagePageData | null;
  previous: UsagePageData | null;
  error?: string;
  loading: boolean;
  selectedBreakdown: UsageBreakdown;
  breakdowns: UsageBreakdown[];
  intervalSeconds: number;
}
export interface UsagePageFetchResponse { ok: boolean; status?: number; json(): Promise<unknown>; }
export interface UsagePageControllerOptions {
  initialFilters?: Partial<UsagePageFilters>;
  initialBy?: UsageBreakdown;
  interval?: unknown;
  fetch: (url: string) => Promise<UsagePageFetchResponse>;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  replaceUrl?: (search: string) => void;
  render: (state: UsagePageState) => void;
}
export interface UsagePageController {
  getState(): UsagePageState;
  refresh(userInitiated?: boolean): Promise<UsagePageState>;
  setFilter(name: keyof UsagePageFilters, value: string): Promise<UsagePageState>;
  setFilters(values: Partial<UsagePageFilters>): Promise<UsagePageState>;
  setBreakdown(name: UsageBreakdown): void;
  stop(): void;
  start(): Promise<void>;
}
export interface UsagePageOptions { by?: UsageBreakdown; interval?: unknown; filters?: Partial<UsagePageFilters>; pages?: WebPageLink[]; }
export interface UsagePageEnvironment {
  fetch: (url: string) => Promise<UsagePageFetchResponse>;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  document: UsagePageDocument;
  location?: { search: string; href?: string };
  replaceUrl?: (search: string) => void;
  copyToClipboard?: (text: string) => void;
  window?: { addEventListener(type: string, listener: () => void): void };
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}
interface UsagePageElement {
  hidden: boolean; textContent: string | null; innerHTML: string; className: string; value: string;
  dataset: Record<string, string | undefined>;
  querySelector<T extends UsagePageElement = UsagePageElement>(selector: string): T | null;
  querySelectorAll<T extends UsagePageElement = UsagePageElement>(selector: string): T[];
  setAttribute(name: string, value: string): void;
  replaceChildren(...nodes: UsagePageElement[]): void;
  append(...nodes: UsagePageElement[]): void;
  addEventListener(type: string, listener: (event: UsagePageEvent) => void): void;
  closest<T extends UsagePageElement = UsagePageElement>(selector: string): T | null;
  focus(): void;
  click(): void;
  clientWidth: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  style: { left: string; top: string };
  selectionStart?: number | null;
  selectionEnd?: number | null;
  setSelectionRange?(start: number, end: number): void;
}
interface UsagePageDocument {
  getElementById(id: string): UsagePageElement | null;
  createElement(tagName: string): UsagePageElement;
  addEventListener(type: string, listener: (event: UsagePageEvent) => void): void;
  activeElement?: { tagName?: string } | null;
}
interface UsagePageEvent { target?: UsagePageElement | null; key?: string; clientX?: number; clientY?: number; preventDefault?(): void; }

export function normalizeUsageInterval(value: unknown): number { return Math.max(1, Number(value) || 2); }

export function buildUsageApiUrl(filters: UsagePageFilters): string {
  const params: string[] = [];
  for (const name of ["period", "repo", "model", "agent", "since", "until"] as const) {
    if (filters[name]) params.push(`${encodeURIComponent(name)}=${encodeURIComponent(filters[name])}`);
  }
  const query = params.join("&");
  return query ? `/api/usage?${query}` : "/api/usage";
}

export interface UsageUrlState { filters: UsagePageFilters; by: UsageBreakdown; }
export function buildUsagePageSearch(state: UsageUrlState): string {
  const params: string[] = [];
  for (const name of ["period", "repo", "model", "agent", "since", "until"] as const) {
    if (state.filters[name]) params.push(`${encodeURIComponent(name)}=${encodeURIComponent(state.filters[name])}`);
  }
  if (state.by !== "day") params.push(`by=${encodeURIComponent(state.by)}`);
  const query = params.join("&");
  return query ? `?${query}` : "";
}

export function formatCompact(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
export function formatUsd(value: number): string {
  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}
export function formatAxisTick(value: number, currency = false): string {
  return currency
    ? `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`
    : formatCompact(value);
}
export function formatShare(value: number, base: "spend" | "sessions"): string {
  return `${value.toFixed(1)}% of ${base}`;
}
export function formatCost(value: number, complete: boolean, sessionsWithoutCost: number): string {
  return `${complete ? "" : "≥ "}${formatUsd(value)}${complete ? "" : ` <span class="pill" title="${sessionsWithoutCost}">${formatCompact(sessionsWithoutCost)} unpriced</span>`}`;
}
export function previousWindow(period: string, now: Date): { since: string; until: string } | undefined {
  const days = Number(period.replace(/d$/, ""));
  if (![3, 7, 30].includes(days) || !/^[0-9]+d$/.test(period)) return undefined;
  const currentStart = new Date(now);
  currentStart.setDate(currentStart.getDate() - days);
  const until = new Date(currentStart.getTime() - 1);
  const since = new Date(until);
  since.setDate(since.getDate() - days);
  return { since: since.toISOString(), until: until.toISOString() };
}
export function computeDelta(current: number, previous: number, period: string): { direction: "up" | "down"; percent: number } | undefined {
  if (!["3d", "7d", "30d"].includes(period) || previous === 0) return undefined;
  const difference = ((current - previous) / Math.abs(previous)) * 100;
  return { direction: difference >= 0 ? "up" : "down", percent: Math.abs(difference) };
}
export function donutSlices(rows: UsageMetricBucket[], limit = 6): UsageMetricBucket[] {
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd);
  const top = sorted.slice(0, limit);
  const remaining = sorted.slice(limit);
  if (!remaining.length) return top;
  const other: UsageMetricBucket = remaining.reduce((sum, row) => ({
    key: "other", label: "Other", sessionCount: sum.sessionCount + row.sessionCount,
    inputTokens: sum.inputTokens + row.inputTokens, outputTokens: sum.outputTokens + row.outputTokens,
    cachedTokens: sum.cachedTokens + row.cachedTokens, totalTokens: sum.totalTokens + row.totalTokens,
    costUsd: sum.costUsd + row.costUsd, costComplete: sum.costComplete && row.costComplete, trend: [],
  }), { key: "other", label: "Other", sessionCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0, costComplete: true, trend: [] });
  return [...top, other];
}
export function renderDonutSvg(rows: UsageMetricBucket[]): string {
  const slices = donutSlices(rows);
  const total = slices.reduce((sum, row) => sum + row.costUsd, 0);
  if (!slices.length || total === 0) return '<p class="empty">No usage in this range</p>';
  const palette = ["#3b82f6", "#93c5fd", "#1d4ed8", "#60a5fa", "#bfdbfe", "#1e3a8a", "#737373"];
  const circumference = 2 * Math.PI * 54;
  let offset = 0;
  const segments = slices.map((row, index) => {
    const length = circumference * row.costUsd / total;
    const segment = `<circle class="donut-seg" cx="85" cy="85" r="54" stroke="${palette[index]}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" tabindex="0"><title>${escapeHtml(row.label ?? row.key)}: ${formatUsd(row.costUsd)}, ${formatShare(row.costUsd / total * 100, "spend")} (${row.costUsd / total * 100})</title></circle>`;
    offset += length;
    return segment;
  }).join("");
  const center = formatUsd(total);
  return `<svg class="donut-svg" viewBox="0 0 170 170" role="img" aria-label="Spend by model"> <g transform="rotate(-90 85 85)">${segments}</g><text class="donut-center" x="85" y="82" style="font-size:${donutCenterFontSize(center)}px" title="${total}">${center}</text><text class="donut-sub" x="85" y="103">total spend</text></svg>`;
}
export function donutCenterFontSize(value: string): number { return value.length >= 9 ? 10 : value.length >= 8 ? 11 : 13; }
export function renderModelLegend(rows: UsageMetricBucket[]): string {
  const models = donutSlices(rows);
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  return models.map((row) => `<div class="legend-row" title="${escapeHtml(row.label ?? row.key)}, ${row.costUsd}"><span class="model-name">${escapeHtml(row.label ?? row.key)}</span><strong>${formatUsd(row.costUsd)}</strong><small title="${total ? row.costUsd / total * 100 : 0}">${formatShare(total ? row.costUsd / total * 100 : 0, "spend")}</small></div>`).join("") || '<p class="empty">No usage in this range</p>';
}
export function renderSparklineSvg(values: number[], label: string): string {
  if (!values.length) return '<p class="empty">No usage in this range</p>';
  const width = 280, height = 48, max = Math.max(...values, 1), min = Math.min(...values, 0), span = max - min || 1;
  const safeLabel = escapeHtml(label);
  if (values.length < 2) {
    const y = (height / 2).toFixed(1);
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${safeLabel} trend"><path class="spark-line" d="M0 ${y} L${width} ${y}"/></svg>`;
  }
  const points = values.map((value, index) => `${index ? "L" : "M"}${(index * width / Math.max(values.length - 1, 1)).toFixed(1)} ${(height - 3 - (value - min) / span * 38).toFixed(1)}`);
  const line = points.join(" ");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${safeLabel} trend"><path class="spark-area" d="${line} L ${width} ${height} L 0 ${height} Z"/><path class="spark-line" d="${line}"/>${values.map((value, index) => `<circle cx="${(index * width / Math.max(values.length - 1, 1)).toFixed(1)}" cy="${(height - 3 - (value - min) / span * 38).toFixed(1)}" r="2.5"><title>${safeLabel}: ${value}</title></circle>`).join("")}</svg>`;
}
export function renderLineChartSvg(rows: UsageMetricBucket[], metric: "costUsd" | "totalTokens" | "sessionCount" = "costUsd", width = 880): string {
  if (!rows.length) return '<p class="empty">No usage in this range</p>';
  if (rows.length === 1) {
    const row = rows[0];
    const raw = row[metric] ?? 0;
    const masked = metric === "costUsd" ? formatUsd(raw) : formatCompact(raw);
    const center = width / 2;
    return `<div class="single-day-chart"><svg class="line-chart" width="${width}" height="248" viewBox="0 0 ${width} 248" role="img" aria-label="${metric} over time"><circle class="chart-point" cx="${center}" cy="124" r="4"><title>${escapeHtml(row.label ?? row.key)}: ${masked}</title></circle><text class="axis" x="${center}" y="110" text-anchor="middle" title="${raw}">${masked}</text></svg><p class="single-day-caption">Single day. Pick a longer range for a trend.</p></div>`;
  }
  const height = 248, right = 14, top = 12, bottom = 30;
  const values = rows.map((row) => row[metric] ?? 0), max = Math.max(...values, 1);
  const longestTick = Math.max(...[0, .25, .5, .75, 1].map((part) => formatAxisTick(max * part, metric === "costUsd").length));
  const left = Math.max(width < 500 ? 52 : 66, Math.ceil(longestTick * 6.7 + 8));
  const x = (index: number) => left + index * (width - left - right) / Math.max(values.length - 1, 1);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index)} ${y(value)}`).join(" ");
  const area = `${path} L ${x(values.length - 1)} ${height - bottom} L ${left} ${height - bottom} Z`;
  const grid = [0, .25, .5, .75, 1].map((part) => {
    const yy = y(max * part);
    return `<line class="gridline" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text class="axis" x="${left - 8}" y="${yy + 3}" text-anchor="end" title="${max * part}">${formatAxisTick(max * part, metric === "costUsd")}</text>`;
  }).join("");
  const points = rows.map((row, index) => `<circle class="chart-point" data-index="${index}" cx="${x(index)}" cy="${y(values[index])}" r="4" tabindex="0"><title>${escapeHtml(row.label ?? row.key)}: ${values[index]}</title></circle>`).join("");
  const labels = rows.filter((_, index) => index % Math.max(1, Math.ceil(rows.length / 7)) === 0 || index === rows.length - 1).map((row) => {
    const index = rows.indexOf(row);
    const anchor = index === 0 && index !== rows.length - 1 ? "start" : index === rows.length - 1 && index !== 0 ? "end" : "middle";
    return `<text class="axis" x="${x(index)}" y="${height - 7}" text-anchor="${anchor}" title="${escapeHtml(row.label ?? row.key)}">${escapeHtml(row.key.slice(5))}</text>`;
  }).join("");
  return `<svg class="line-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${metric} over time"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".2"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>${grid}${labels}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/><line class="chart-crosshair" data-crosshair x1="0" y1="${top}" x2="0" y2="${height - bottom}" visibility="hidden"/>${points}</svg>`;
}

export function createUsageChartView(initialSeries: "costUsd" | "totalTokens" | "sessionCount" = "costUsd") {
  let series = initialSeries;
  return {
    getSeries: () => series,
    select: (next: "costUsd" | "totalTokens" | "sessionCount") => { series = next; },
    render: (rows: UsageMetricBucket[], width: number) => renderLineChartSvg(rows, series, width),
  };
}

export function formatChartTooltip(row: UsageMetricBucket, series: "costUsd" | "totalTokens" | "sessionCount"): { text: string; title: string } {
  const value = row[series] ?? 0;
  return {
    text: `${row.label ?? row.key} · ${series === "costUsd" ? formatUsd(value) : formatCompact(value)}`,
    title: String(value),
  };
}

export function attachChartInteractions(wrapper: UsagePageElement, rows: UsageMetricBucket[], series: "costUsd" | "totalTokens" | "sessionCount"): void {
  const points = wrapper.querySelectorAll(".chart-point");
  const crosshair = wrapper.querySelector("[data-crosshair]");
  const tooltip = wrapper.querySelector("[data-chart-tooltip]");
  if (!points.length || !crosshair || !tooltip) return;
  const show = (event: UsagePageEvent) => {
    const bounds = wrapper.getBoundingClientRect();
    const x = Math.min(bounds.width, Math.max(0, (event.clientX ?? bounds.left) - bounds.left));
    const nearest = points.reduce((best, point) => {
      const pointX = Number(point.getAttribute("cx") ?? 0);
      return Math.abs(pointX - x) < Math.abs(Number(best.getAttribute("cx") ?? 0) - x) ? point : best;
    }, points[0]);
    const index = Number(nearest.getAttribute("data-index") ?? 0);
    const pointX = Number(nearest.getAttribute("cx") ?? 0);
    const row = rows[index];
    if (!row) return;
    const formatted = formatChartTooltip(row, series);
    crosshair.setAttribute("x1", String(pointX));
    crosshair.setAttribute("x2", String(pointX));
    crosshair.setAttribute("visibility", "visible");
    tooltip.textContent = formatted.text;
    tooltip.setAttribute("title", formatted.title);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(bounds.width - 170, Math.max(0, pointX))}px`;
    tooltip.style.top = `${Math.max(0, (event.clientY ?? bounds.top) - bounds.top - 38)}px`;
  };
  wrapper.addEventListener("pointermove", show);
  wrapper.addEventListener("pointerdown", show);
  wrapper.addEventListener("pointerleave", () => { crosshair.setAttribute("visibility", "hidden"); tooltip.hidden = true; });
}

export function toUsagePageData(result: UsageQueryResult): UsagePageData {
  return {
    range: { ...result.range }, totals: { ...result.totals }, byDay: [...result.byDay],
    byRepository: [...result.byRepository], byModel: [...result.byModel], byAgent: [...result.byAgent],
    byRun: [...result.byRun], byOrigin: [...(result.byOrigin ?? [])],
  };
}

export function createUsagePageController(options: UsagePageControllerOptions): UsagePageController {
  const breakdowns: UsageBreakdown[] = ["day", "repo", "model", "agent", "run", "origin"];
  const state: UsagePageState = {
    filters: {
      period: options.initialFilters?.period ?? (options.initialFilters?.since ? "" : "today"),
      repo: options.initialFilters?.repo ?? "", model: options.initialFilters?.model ?? "", agent: options.initialFilters?.agent ?? "",
      since: options.initialFilters?.since ?? "", until: options.initialFilters?.until ?? "",
    }, result: null, previous: null, error: undefined, loading: false,
    selectedBreakdown: breakdowns.includes(options.initialBy as UsageBreakdown) ? options.initialBy as UsageBreakdown : "day",
    breakdowns, intervalSeconds: normalizeUsageInterval(options.interval),
  };
  let timer: unknown;
  let started = false;
  let hasLoaded = false;
  let requestSequence = 0;
  const snapshot = (): UsagePageState => ({ ...state, filters: { ...state.filters }, breakdowns: [...state.breakdowns] });
  const publish = () => options.render(snapshot());
  const query = async (url: string): Promise<UsagePageData> => {
    const response = await options.fetch(url);
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error : `Usage query failed with HTTP ${response.status ?? 500}`;
      throw new Error(message);
    }
    return toUsagePageData(payload as UsageQueryResult);
  };
  const updateUrl = () => options.replaceUrl?.(buildUsagePageSearch({ filters: state.filters, by: state.selectedBreakdown }));
  async function refresh(userInitiated = true): Promise<UsagePageState> {
    const sequence = ++requestSequence;
    state.loading = userInitiated;
    publish();
    try {
      const result = await query(buildUsageApiUrl(state.filters));
      if (sequence !== requestSequence) return snapshot();
      state.result = result;
      state.error = undefined;
      hasLoaded = true;
      const previous = previousWindow(state.filters.period, new Date(result.range.until));
      const previousResult = previous ? await query(buildUsageApiUrl({ ...state.filters, period: "", ...previous })) : null;
      if (sequence !== requestSequence) return snapshot();
      state.previous = previousResult;
    } catch (error) {
      if (sequence !== requestSequence) return snapshot();
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === requestSequence) {
        state.loading = false;
        publish();
      }
    }
    return snapshot();
  }
  async function setFilter(name: keyof UsagePageFilters, value: string): Promise<UsagePageState> {
    return setFilters({ [name]: String(value) });
  }
  async function setFilters(values: Partial<UsagePageFilters>): Promise<UsagePageState> {
    let changed = false;
    for (const name of Object.keys(values) as (keyof UsagePageFilters)[]) {
      if (!(name in state.filters) || state.filters[name] === String(values[name] ?? "")) continue;
      state.filters[name] = String(values[name] ?? "");
      changed = true;
    }
    if (!changed) return snapshot();
    updateUrl();
    return refresh(true);
  }
  function setBreakdown(name: UsageBreakdown): void {
    if (!breakdowns.includes(name)) return;
    state.selectedBreakdown = name;
    updateUrl();
    publish();
  }
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh(true);
    timer = options.setInterval(() => { void refresh(false); }, state.intervalSeconds * 1000);
  }
  function stop(): void {
    if (!started) return;
    started = false;
    options.clearInterval(timer);
    timer = undefined;
  }
  return { getState: snapshot, refresh, setFilter, setFilters, setBreakdown, start, stop };
}

export function startUsagePage(options: UsagePageOptions, environment: UsagePageEnvironment): UsagePageController | undefined {
  const root = environment.document.getElementById("usage-root");
  if (!root) return;
  const params = new URLSearchParams(environment.location?.search ?? "");
  const filters = { ...options.filters };
  for (const key of ["period", "repo", "model", "agent", "since", "until"] as const) {
    if (params.has(key)) filters[key] = params.get(key) ?? "";
  }
  const requestedBy = params.get("by") as UsageBreakdown | null;
  const initialBy = requestedBy ?? options.by;
  const tableView = { sortKey: "costUsd", direction: -1, expanded: false, search: "" };
  const chartView = createUsageChartView();
  let resizeTimer: unknown;
  const controller = createUsagePageController({
    initialFilters: filters, initialBy, interval: options.interval,
    fetch: environment.fetch, setInterval: environment.setInterval, clearInterval: environment.clearInterval,
    replaceUrl: environment.replaceUrl,
    render: (state) => renderUsageDashboard(root, state, environment.document, controller, tableView, chartView),
  });
  environment.window?.addEventListener("resize", () => {
    if (resizeTimer !== undefined) environment.clearTimeout?.(resizeTimer);
    resizeTimer = environment.setTimeout?.(() => {
      renderActiveUsageChart(root, controller.getState(), chartView);
      resizeTimer = undefined;
    }, 150);
  });
  const range = root.querySelector("[data-range]");
  if (range) range.value = controller.getState().filters.period;
  for (const name of ["since", "until"] as const) {
    const input = root.querySelector(`[data-filter="${name}"]`);
    if (input) input.value = controller.getState().filters[name];
  }
  const dateFields = root.querySelectorAll("[data-date-field]");
  for (const field of dateFields) field.hidden = Boolean(controller.getState().filters.period);
  range?.addEventListener("change", (event) => {
    const value = event.target?.value ?? "";
    for (const field of dateFields) field.hidden = Boolean(value);
    void controller.setFilters(value ? { period: value, since: "", until: "" } : { period: value });
  });
  root.addEventListener("change", (event) => {
    const target = event.target ?? null;
    const name = target?.dataset.filter as keyof UsagePageFilters | undefined;
    if (name) void controller.setFilter(name, target?.value ?? "");
  });
  root.querySelector("[data-add-filter]")?.addEventListener("click", () => {
    const menu = root.querySelector("[data-filter-menu]");
    if (menu) menu.hidden = !menu.hidden;
  });
  for (const button of root.querySelectorAll("[data-filter-kind]")) button.addEventListener("click", () => {
    const kind = button.dataset.filterKind as "repo" | "model" | "agent" | undefined;
    const menu = root.querySelector("[data-filter-menu]");
    const result = controller.getState().result;
    if (!kind || !menu || !result) return;
    const groups = { repo: result.byRepository, model: result.byModel, agent: result.byAgent };
    const field = environment.document.createElement("select");
    field.dataset.filterChoice = kind;
    field.innerHTML = renderUsageFilterOptions(groups[kind], kind);
    menu.replaceChildren(field);
    field.addEventListener("change", (event) => {
      const value = event.target?.value ?? "";
      if (value) void controller.setFilter(kind, value);
      menu.hidden = true;
    });
  });
  root.querySelector("[data-live]")?.addEventListener("click", (event) => {
    const target = event.target?.closest("[data-live]");
    if (!target) return;
    target.className = target.className.includes(" on") ? "live" : "live on";
    if (target.className.includes(" on")) void controller.start();
    else controller.stop();
  });
  root.querySelector("[data-dismiss-error]")?.addEventListener("click", () => {
    const banner = root.querySelector("[data-error]");
    if (banner) banner.hidden = true;
  });
  root.querySelector("[data-copy]")?.addEventListener("click", () => {
    environment.copyToClipboard?.(environment.location?.href ?? "");
  });
  root.querySelector("[data-export]")?.addEventListener("click", () => {
    const result = controller.getState().result;
    if (!result) return;
    const rows = selectedRows(result, controller.getState().selectedBreakdown);
    const csv = ["name,sessions,spend,tokens", ...rows.map((row) => [csvQuote(row.label ?? row.key), row.sessionCount, row.costUsd, row.totalTokens].join(","))].join("\n");
    const anchor = environment.document.createElement("a");
    anchor.setAttribute("href", `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`);
    anchor.setAttribute("download", `usage-${controller.getState().filters.period}.csv`);
    anchor.click();
  });
  environment.document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(environment.document.activeElement?.tagName ?? "")) {
      event.preventDefault?.();
      root.querySelector("[data-search]")?.focus();
    }
  });
  void controller.start();
  return controller;
}

export function filterAndSortUsageRows(rows: UsageMetricBucket[], search: string, sortKey: string, direction: number): UsageMetricBucket[] {
  const matches = rows.filter((row) => (row.label ?? row.key).toLowerCase().includes(search.toLowerCase()));
  const key = sortKey === "share" ? "costUsd" : sortKey;
  return matches.sort((left, right) => {
    const first = key === "key" ? left.label ?? left.key : left[key as keyof UsageMetricBucket];
    const second = key === "key" ? right.label ?? right.key : right[key as keyof UsageMetricBucket];
    return (typeof first === "number" && typeof second === "number" ? first - second : String(first).localeCompare(String(second))) * direction;
  });
}

export interface UsageSearchFocus { focused: boolean; value?: string; selectionStart?: number | null; selectionEnd?: number | null; }
export function captureUsageSearchFocus(document: UsagePageDocument, input: UsagePageElement | null): UsageSearchFocus {
  if (!input || document.activeElement !== input) return { focused: false };
  return { focused: true, value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd };
}
export function restoreUsageSearchFocus(input: UsagePageElement | null, focus: UsageSearchFocus): void {
  if (!input || !focus.focused) return;
  if (focus.value !== undefined) input.value = focus.value;
  input.focus();
  if (focus.selectionStart != null && focus.selectionEnd != null) input.setSelectionRange?.(focus.selectionStart, focus.selectionEnd);
}

export function csvQuote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
export function renderUsageFilterOptions(rows: UsageMetricBucket[], kind: "repo" | "model" | "agent"): string {
  return `<option value="">Select ${kind}</option>${rows.map((row) => `<option value="${escapeHtml(row.key)}">${escapeHtml(row.label ?? row.key)}</option>`).join("")}`;
}
export function renderUsageTableRows(rows: UsageMetricBucket[], tableSpend: number, expanded: boolean): string {
  return rows.map((row, index) => {
    const label = row.label ?? row.key;
    const share = tableSpend ? row.costUsd / tableSpend * 100 : 0;
    return `<tr${index >= 10 && !expanded ? " hidden" : ""}><td title="${escapeHtml(label)}">${escapeHtml(label)}</td><td title="${row.sessionCount}">${formatCompact(row.sessionCount)}</td><td title="${row.costUsd}">${row.costComplete ? "" : "≥ "}${formatUsd(row.costUsd)}</td><td title="${row.totalTokens}">${formatCompact(row.totalTokens)}</td><td title="${share}"><span class="share"><i style="width:${share}%"></i></span>${formatShare(share, "spend")}</td></tr>`;
  }).join("");
}

function renderUsageDashboard(
  root: UsagePageElement,
  state: UsagePageState,
  document: UsagePageDocument,
  controller: UsagePageController,
  tableView: { sortKey: string; direction: number; expanded: boolean; search: string },
  chartView: ReturnType<typeof createUsageChartView>,
): void {
  const loading = root.querySelector("[data-loading]");
  if (loading) { loading.textContent = state.loading ? "Loading usage…" : ""; loading.hidden = !state.loading; }
  const error = root.querySelector("[data-error]");
  if (error) {
    error.hidden = !state.error;
    const message = error.querySelector("span");
    if (message) message.textContent = state.error ?? "";
  }
  const content = root.querySelector("[data-dashboard]");
  if (!content) return;
  const priorSearch = content.querySelector("[data-search]");
  const focus = captureUsageSearchFocus(document, priorSearch);
  for (const button of root.querySelectorAll("[data-breakdown]")) button.setAttribute("aria-pressed", String(button.dataset.breakdown === state.selectedBreakdown));
  if (!state.result) return;
  const data = state.result;
  const rows = data.byDay;
  const totals = data.totals;
  const chips = root.querySelector("[data-chips]");
  if (chips) {
    const activeFilters = (["repo", "model", "agent"] as const).filter((name) => state.filters[name]);
    chips.innerHTML = activeFilters.map((name) => `<span class="filter-chip">${name}: ${escapeHtml(state.filters[name])}<button data-remove-filter="${name}" aria-label="Remove ${name} filter">×</button></span>`).join("");
    chips.querySelectorAll("[data-remove-filter]").forEach((button) => button.addEventListener("click", () => {
      void controller.setFilter(button.dataset.removeFilter as "repo" | "model" | "agent", "");
    }));
  }
  const cache = totals.cachedTokens / (totals.inputTokens + totals.cachedTokens || 1) * 100;
  const kpis = [
    ["Spend", formatCost(totals.costUsd, totals.costComplete, totals.sessionsWithoutCost), totals.costUsd, "spend"],
    ["Sessions", escapeHtml(formatCompact(totals.sessionCount)), totals.sessionCount, "sessions"],
    ["Total tokens", escapeHtml(formatCompact(totals.totalTokens)), totals.totalTokens, "tokens"],
    ["Cache hit rate", `${cache.toFixed(1)}%`, cache, "cache"],
  ] as const;
  const previous = state.previous?.totals;
  const periodLabel = state.filters.period;
  const kpiHtml = kpis.map(([label, value, current, key], index) => {
    const previousValue = key === "spend" ? previous?.costUsd : key === "sessions" ? previous?.sessionCount : key === "tokens" ? previous?.totalTokens : previous ? previous.cachedTokens / (previous.inputTokens + previous.cachedTokens || 1) * 100 : undefined;
    const delta = previousValue === undefined ? undefined : computeDelta(current, previousValue, periodLabel);
    const deltaHtml = delta ? `<p class="delta">${delta.direction === "up" ? "↗" : "↘"} ${delta.percent.toFixed(1)}% <span>vs previous ${periodLabel}</span></p>` : "";
    const raw = key === "spend" ? formatUsd(current) : key === "cache" ? `${current.toFixed(2)}%` : new Intl.NumberFormat("en-US").format(current);
    return `<article class="card kpi"><div class="kpi-heading">${label}<span class="range-tag">${escapeHtml(periodLabel || "custom")}</span></div><strong class="kpi-value" title="${raw}">${value}</strong>${deltaHtml}${key === "cache" ? '<span class="kpi-note">Share of input + cached tokens</span>' : ""}${renderSparklineSvg(rows.map((row) => key === "spend" ? row.costUsd : key === "sessions" ? row.sessionCount : key === "tokens" ? row.totalTokens : row.cachedTokens / (row.inputTokens + row.cachedTokens || 1) * 100), label)}</article>`;
  }).join("");
  const modelLegend = renderModelLegend(data.byModel);
  const repoMax = Math.max(...data.byRepository.map((row) => row.costUsd), 1);
  const repoRows = [...data.byRepository].sort((a, b) => b.costUsd - a.costUsd).map((row) => `<div class="rank-row" title="${escapeHtml(row.label ?? row.key)}: ${formatUsd(row.costUsd)}"><span>${escapeHtml(row.label ?? row.key)}</span><i><b style="width:${row.costUsd / repoMax * 100}%"></b></i><strong>${formatUsd(row.costUsd)}</strong></div>`).join("") || '<p class="empty">No usage in this range</p>';
  const outcomes = [["Completed", totals.completedSessionCount, "#3b82f6"], ["Failed", totals.failedSessionCount, "#e5484d"], ["Active", totals.activeSessionCount, "#93c5fd"], ["Other", Math.max(0, totals.sessionCount - totals.completedSessionCount - totals.failedSessionCount - totals.activeSessionCount), "#404040"]] as const;
  const outcomeBar = outcomes.map(([name, count, color]) => `<i style="width:${totals.sessionCount ? count / totals.sessionCount * 100 : 0}%;background:${color}" title="${name}: ${formatCompact(count)}, ${formatShare(totals.sessionCount ? count / totals.sessionCount * 100 : 0, "sessions")}"></i>`).join("");
  const outcomeLegend = outcomes.map(([name, count]) => { const share = totals.sessionCount ? count / totals.sessionCount * 100 : 0; return `<div><span>${name}</span><strong title="${count}">${formatCompact(count)}</strong><small title="${share}">${formatShare(share, "sessions")}</small></div>`; }).join("");
  const harness = data.byAgent.map((row) => { const spendShare = totals.costUsd ? row.costUsd / totals.costUsd * 100 : 0; const sessionShare = totals.sessionCount ? row.sessionCount / totals.sessionCount * 100 : 0; return `<div class="harness-row"><strong>${escapeHtml(row.label ?? row.key)}</strong><span class="track"><i style="width:${spendShare}%"></i></span><small title="${spendShare}">${formatShare(spendShare, "spend")}</small><span class="track"><i style="width:${sessionShare}%"></i></span><small title="${sessionShare}">${formatShare(sessionShare, "sessions")}</small></div>`; }).join("") || '<p class="empty">No usage in this range</p>';
  const origins = data.byOrigin.map((row) => { const sessionShare = totals.sessionCount ? row.sessionCount / totals.sessionCount * 100 : 0; const spendShare = totals.costUsd ? row.costUsd / totals.costUsd * 100 : 0; return `<div class="origin-row"><strong>${escapeHtml(row.label ?? row.key)}</strong><span title="${sessionShare}">${formatShare(sessionShare, "sessions")}</span><span title="${spendShare}">${formatShare(spendShare, "spend")}</span></div>`; }).join("") || '<p class="empty">No usage in this range</p>';
  const sourceRows = selectedRows(data, state.selectedBreakdown);
  const tableSpend = sourceRows.reduce((sum, row) => sum + row.costUsd, 0);
  const allRows = filterAndSortUsageRows(sourceRows, tableView.search, tableView.sortKey, tableView.direction);
  const table = allRows.length ? `<div class="table-scroll"><table><thead><tr><th><button data-sort="key">Name${tableView.sortKey === "key" ? (tableView.direction < 0 ? " ↓" : " ↑") : ""}</button></th><th><button data-sort="sessionCount">Sessions${tableView.sortKey === "sessionCount" ? (tableView.direction < 0 ? " ↓" : " ↑") : ""}</button></th><th><button data-sort="costUsd">Spend${tableView.sortKey === "costUsd" ? (tableView.direction < 0 ? " ↓" : " ↑") : ""}</button></th><th><button data-sort="totalTokens">Tokens${tableView.sortKey === "totalTokens" ? (tableView.direction < 0 ? " ↓" : " ↑") : ""}</button></th><th><button data-sort="share">Share of spend${tableView.sortKey === "share" ? (tableView.direction < 0 ? " ↓" : " ↑") : ""}</button></th></tr></thead><tbody>${renderUsageTableRows(allRows, tableSpend, tableView.expanded)}</tbody></table></div>` : '<p class="empty">No usage in this range</p>';
  content.innerHTML = `<section class="kpis">${kpiHtml}</section><section class="card chart-card"><div class="card-heading"><h2>Spend over time</h2><div class="series-switch">${(["costUsd", "totalTokens", "sessionCount"] as const).map((series) => `<button data-series="${series}" aria-pressed="${chartView.getSeries() === series}">${series === "costUsd" ? "Spend" : series === "totalTokens" ? "Tokens" : "Sessions"}</button>`).join("")}</div></div><div class="chart-wrap"><div data-chart-svg>${renderLineChartSvg(rows, chartView.getSeries(), 880)}</div><div class="chart-tooltip" data-chart-tooltip hidden></div></div></section><section class="two-col"><article class="card"><div class="card-heading"><h2>Spend by model</h2><span>${escapeHtml(periodLabel || "custom")}</span></div><div class="donut-layout">${renderDonutSvg(data.byModel)}<div class="model-legend">${modelLegend}</div></div></article><article class="card"><div class="card-heading"><h2>Spend by repository</h2><span>${escapeHtml(periodLabel || "custom")}</span></div><div class="rank-list">${repoRows}</div></article></section><section class="three-col"><article class="card"><div class="card-heading"><h2>Sessions by outcome</h2></div><div class="outcome-bar">${outcomeBar}</div><div class="outcome-legend">${outcomeLegend}</div></article><article class="card"><div class="card-heading"><h2>Harness</h2><span>Spend and sessions</span></div><div class="harness-list">${harness}</div></article><article class="card"><div class="card-heading"><h2>Origin</h2><span>Worker and orchestrator</span></div><div class="origin-list">${origins}</div></article></section><section class="card table-card"><div class="card-heading"><h2>Breakdown</h2><input data-search type="search" placeholder="Search rows" aria-label="Search rows" value="${escapeHtml(tableView.search)}"></div><nav class="tabs" aria-label="Usage breakdowns">${state.breakdowns.map((name) => `<button data-breakdown="${name}" aria-pressed="${name === state.selectedBreakdown}">${name === "repo" ? "Repository" : name[0].toUpperCase() + name.slice(1)}</button>`).join("")}</nav>${allRows.length > 10 ? `<button class="show-all" data-show-all>${tableView.expanded ? "Show top 10" : `Show all ${allRows.length}`}</button>` : ""}${table}</section>`;
  restoreUsageSearchFocus(content.querySelector("[data-search]"), focus);
  renderActiveUsageChart(root, state, chartView);
  content.querySelectorAll("[data-breakdown]").forEach((button) => button.addEventListener("click", () => controller.setBreakdown(button.dataset.breakdown as UsageBreakdown)));
  content.querySelectorAll("[data-series]").forEach((button) => button.addEventListener("click", () => {
    chartView.select(button.dataset.series as "costUsd" | "totalTokens" | "sessionCount");
    renderActiveUsageChart(root, state, chartView);
    content.querySelectorAll("[data-series]").forEach((seriesButton) => seriesButton.setAttribute("aria-pressed", String(seriesButton.dataset.series === chartView.getSeries())));
  }));
  const search = content.querySelector("[data-search]");
  search?.addEventListener("input", () => {
    tableView.search = search.value ?? "";
    renderUsageDashboard(root, state, document, controller, tableView, chartView);
  });
  content.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.sort ?? "costUsd";
    tableView.direction = tableView.sortKey === key ? tableView.direction * -1 : -1;
    tableView.sortKey = key;
    renderUsageDashboard(root, state, document, controller, tableView, chartView);
  }));
  content.querySelector("[data-show-all]")?.addEventListener("click", () => {
    tableView.expanded = !tableView.expanded;
    renderUsageDashboard(root, state, document, controller, tableView, chartView);
  });
}

function renderActiveUsageChart(root: UsagePageElement, state: UsagePageState, chartView: ReturnType<typeof createUsageChartView>): void {
  const wrapper = root.querySelector(".chart-wrap");
  const target = wrapper?.querySelector("[data-chart-svg]");
  if (!wrapper || !target || !state.result) return;
  const width = wrapper.clientWidth || 880;
  target.innerHTML = chartView.render(state.result.byDay, width);
  attachChartInteractions(wrapper, state.result.byDay, chartView.getSeries());
}

function selectedRows(data: UsagePageData, by: UsageBreakdown): UsageMetricBucket[] {
  const groups: Record<UsageBreakdown, UsageMetricBucket[]> = { day: data.byDay, repo: data.byRepository, model: data.byModel, agent: data.byAgent, run: data.byRun, origin: data.byOrigin };
  return [...groups[by]].sort((a, b) => b.costUsd - a.costUsd);
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }

export function renderUsagePage(options: UsagePageOptions = {}): string {
  const pageOptions = { by: options.by ?? "day", interval: options.interval ?? 2, filters: options.filters ?? {} };
  const serializedOptions = JSON.stringify(pageOptions).replaceAll("<", "\\u003c");
  const behaviorSource = [normalizeUsageInterval, buildUsageApiUrl, buildUsagePageSearch, formatCompact, formatUsd, formatAxisTick, formatShare, formatCost, previousWindow, computeDelta, donutSlices, donutCenterFontSize, renderModelLegend, renderDonutSvg, renderSparklineSvg, renderLineChartSvg, createUsageChartView, formatChartTooltip, attachChartInteractions, toUsagePageData, createUsagePageController, startUsagePage, filterAndSortUsageRows, captureUsageSearchFocus, restoreUsageSearchFocus, csvQuote, renderUsageFilterOptions, renderUsageTableRows, renderUsageDashboard, renderActiveUsageChart, selectedRows, escapeHtml]
    .map((behavior) => Function.prototype.toString.call(behavior)).join("\n\n");
  const topbar = renderTopBar({ pages: options.pages ?? [{ label: "Home", path: "/" }, { label: "Review", path: "/review" }, { label: "Setup", path: "/setup" }, { label: "Usage", path: "/usage" }], activePath: "/usage", title: "Usage" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CodeDeck usage</title><link rel="icon" href="${LOGO_FAVICON_HREF}"><style>${BRAND_CSS}
${USAGE_CSS}
</style></head><body>${topbar}<main id="usage-root"><header class="usage-header"><h1>Usage</h1><div class="usage-actions"><label class="range-picker" aria-label="Range"><select data-range data-filter="period"><option value="today">Today</option><option value="3d">Last 3 days</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option><option value="">Custom</option></select><span aria-hidden="true">⌄</span></label><label class="date-picker" data-date-field>Since<input data-filter="since" type="date"></label><label class="date-picker" data-date-field>Until<input data-filter="until" type="date"></label><button class="button ghost-button" data-copy>Copy link</button><button class="button ghost-button" data-export>Export CSV</button></div></header><section class="filterbar"><div class="filter-tools"><button class="button" data-add-filter>Add filter</button><div data-filter-menu hidden><button data-filter-kind="repo" data-filter="repo">Repository</button><button data-filter-kind="model" data-filter="model">Model</button><button data-filter-kind="agent" data-filter="agent">Agent</button></div><div data-chips></div><button data-live class="live on">● Live refresh</button></div></section><div data-loading role="status" hidden></div><div data-error class="error" role="alert" hidden><span></span><button data-dismiss-error>Dismiss</button></div><div data-dashboard class="dashboard"></div></main><script>
${behaviorSource}
const usageScript=document.currentScript;
const usageEnvironment={fetch:(...args)=>globalThis.fetch(...args),setInterval:(...args)=>globalThis.setInterval(...args),clearInterval:(...args)=>globalThis.clearInterval(...args),setTimeout:(...args)=>globalThis.setTimeout(...args),clearTimeout:(...args)=>globalThis.clearTimeout(...args),document:globalThis.document,location:globalThis.location,window:globalThis,replaceUrl:(search)=>globalThis.history.replaceState(null,"",globalThis.location.pathname+search),copyToClipboard:(text)=>globalThis.navigator.clipboard.writeText(text)};
startUsagePage(${serializedOptions},usageEnvironment);
</script></body></html>`;
}

export const USAGE_CSS = `
.topbar{height:52px;display:flex;align-items:center;gap:24px;padding:0 28px;border-bottom:1px solid var(--border);background:var(--bg)}.brand{display:flex;align-items:center;gap:8px;color:var(--text);text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-.3px}.brand svg{display:block}.topbar-title{font-size:13px;color:var(--text-muted);border-left:1px solid var(--border-strong);padding-left:18px}.topbar nav{display:flex;gap:20px;margin-left:auto}.topbar nav a{color:var(--text-faint);font-size:12px;text-decoration:none}.topbar nav a.active{color:var(--text);font-weight:550}
main{max-width:1440px;margin:0 auto;padding:24px 30px 60px}.usage-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.usage-header h1{margin:0;font-size:21px;font-weight:600;letter-spacing:-.3px}.usage-actions{display:flex;align-items:center;gap:8px}.range-picker{position:relative;display:flex;align-items:center}.range-picker select{appearance:none;padding-right:28px!important;min-width:122px!important}.range-picker span{position:absolute;right:10px;color:var(--text-faint);pointer-events:none}.date-picker{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:11px}.date-picker input{height:34px;padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px}.ghost-button{background:transparent}.filterbar{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}.filterbar label{display:grid;gap:6px;color:var(--text-muted);font-size:11px}.filterbar select,.filterbar input,.table-card input,.range-picker select{height:34px;min-width:130px;padding:0 10px;border:1px solid var(--border-strong);border-radius:6px;background:#0a0a0a;color:var(--text);font-size:12px}.filter-tools{display:flex;gap:7px;align-items:center;width:100%;position:relative}.filter-tools [data-live]{margin-left:auto}.button,.filter-tools button,.show-all{border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-muted);padding:8px 10px;font-size:11px;cursor:pointer}.filter-tools button:hover,.show-all:hover{background:var(--surface-hover);color:var(--text)}[data-filter-menu]{position:absolute;z-index:4;top:38px;left:0;padding:6px;background:var(--surface-raised);border:1px solid var(--border-strong);border-radius:7px}[data-filter-menu] button{display:block;width:100%;text-align:left}.live{color:var(--success)!important}.live:not(.on){color:var(--text-faint)!important}.pill{display:inline-block;border:1px solid var(--border-strong);border-radius:99px;background:var(--surface-raised);color:var(--text-muted);font-size:10px;padding:3px 7px;white-space:nowrap}
.filter-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-strong);border-radius:99px;background:var(--surface-raised);color:var(--text-muted);font-size:10px;padding:4px 7px}.filter-chip button{border:0!important;padding:0!important;background:transparent!important;color:var(--text-faint)!important}
.error{display:flex;justify-content:space-between;align-items:center;margin:0 0 14px;padding:10px 12px;border:1px solid #65363a;border-radius:6px;background:#1c0d0e;color:#f2a5a7;font-size:12px}[hidden]{display:none!important}[data-loading]{color:var(--text-muted);font-size:12px;margin:8px 0}.dashboard{display:grid;gap:14px}.card{min-width:0;border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:16px}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.kpi{position:relative;min-height:142px;padding-bottom:34px;overflow:hidden}.kpi-heading{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:11px}.range-tag{margin-left:auto;font:10px var(--font-mono);color:var(--text-faint)}.kpi-value{display:block;margin-top:14px;font-size:25px;letter-spacing:-.7px;font-weight:550;font-variant-numeric:tabular-nums}.delta{margin:4px 0 0;color:var(--blue-2);font-size:10px}.delta span,.kpi-note{color:var(--text-faint)}.kpi-note{font-size:10px}.spark{position:absolute;left:0;right:0;bottom:0;width:100%;height:38px;overflow:visible}.spark-area{fill:url(#chart-fill)}.spark-line{fill:none;stroke:var(--blue-chart);stroke-width:1.6}.spark circle{fill:var(--blue-chart)}
th button{border:0;background:transparent;color:var(--text-faint);padding:0;font:inherit;cursor:pointer}
.card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.card-heading h2{margin:0;font-size:13px;font-weight:550}.card-heading>span{font-size:10px;color:var(--text-faint);font-family:var(--font-mono)}.series-switch,.tabs{display:flex;gap:4px}.series-switch button,.tabs button{border:1px solid transparent;border-radius:5px;background:transparent;color:var(--text-faint);padding:5px 8px;font-size:10px;cursor:pointer}.series-switch button:focus,.series-switch button:hover,.tabs button[aria-pressed="true"]{border-color:var(--border-strong);background:var(--surface-raised);color:var(--text)}.chart-wrap{width:100%;overflow:hidden;position:relative}.line-chart{display:block;width:100%;height:auto}.single-day-caption{margin:0;color:var(--text-faint);font-size:11px;text-align:center}.chart-crosshair{stroke:#bfdbfe;stroke-width:1;stroke-dasharray:3 3;pointer-events:none}.chart-tooltip{position:absolute;z-index:2;max-width:170px;padding:7px 9px;border:1px solid var(--border-strong);border-radius:6px;background:#111;color:var(--text);font:11px var(--font-mono);pointer-events:none;white-space:nowrap}.gridline{stroke:var(--grid);stroke-dasharray:3 4}.axis{font:11px var(--font-mono);fill:var(--text-faint)}.chart-area{fill:url(#chart-fill)}.chart-line{fill:none;stroke:var(--blue-chart);stroke-width:2}.chart-point{fill:var(--blue-chart);stroke:var(--bg);stroke-width:2}.two-col,.three-col{display:grid;gap:12px;align-items:stretch}.two-col{grid-template-columns:1fr 1fr}.three-col{grid-template-columns:1fr 1.1fr 1fr}.donut-layout{display:grid;grid-template-columns:minmax(130px, .85fr) 1.15fr;align-items:center;gap:12px}.donut-svg{width:100%;max-height:210px;overflow:visible}.donut-seg{fill:none;stroke-width:22;cursor:pointer}.donut-center{text-anchor:middle;font:600 13px var(--font-mono);fill:var(--text)}.donut-sub{text-anchor:middle;font:10px var(--font-sans);fill:var(--text-faint)}.model-legend{display:grid;align-content:start;gap:4px;min-width:0}.legend-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:10px}.legend-row .model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10px var(--font-mono);color:var(--text-muted)}.legend-row strong{font:11px var(--font-mono)}.legend-row small{grid-column:1/-1;color:var(--text-faint);font-size:10px}.rank-list{max-height:246px;overflow:auto}.rank-row{display:grid;grid-template-columns:minmax(80px,1.1fr) minmax(50px,1fr) auto;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--border);font-size:10px}.rank-row>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted)}.rank-row>strong{font:10px var(--font-mono)}.rank-row>i,.track{height:4px;background:var(--surface-raised);border-radius:5px;overflow:hidden}.rank-row>i>b,.track>i{display:block;height:100%;background:var(--blue-chart);border-radius:5px}
.outcome-bar{display:flex;height:9px;border-radius:8px;overflow:hidden;background:var(--surface-raised)}.outcome-bar i{min-width:0}.outcome-legend{display:grid;gap:8px;margin-top:14px}.outcome-legend>div{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-size:10px;color:var(--text-muted)}.outcome-legend strong{font:11px var(--font-mono);color:var(--text)}.outcome-legend small{grid-column:1/-1;color:var(--text-faint);font-size:10px}.harness-list,.origin-list{display:grid;gap:12px}.harness-row{display:grid;grid-template-columns:minmax(56px,.7fr) minmax(38px,1fr) auto minmax(38px,1fr) auto;gap:8px;align-items:center;font-size:10px}.harness-row strong,.origin-row strong{font:10px var(--font-mono);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.harness-row small{font-size:10px;color:var(--text-faint);white-space:nowrap}.origin-row{display:grid;grid-template-columns:1fr auto auto;gap:12px;border-bottom:1px solid var(--border);padding:8px 0;font-size:10px}.origin-row span{color:var(--text-muted);white-space:nowrap}.empty{margin:20px 0;color:var(--text-faint);font-size:11px;text-align:center}.table-card{padding-bottom:10px}.table-card .card-heading{margin-bottom:8px}.table-card input{height:29px;min-width:160px}.tabs{border-bottom:1px solid var(--border);margin-bottom:5px}.tabs button{padding:8px 10px;border-radius:0}.tabs button[aria-pressed="true"]{border:0;border-bottom:2px solid var(--blue);background:transparent}.table-scroll{width:100%;overflow:auto}table{width:100%;border-collapse:collapse;font-size:11px}th{text-align:left;color:var(--text-faint);font-weight:450;border-bottom:1px solid var(--border)}th,td{padding:10px 9px;white-space:nowrap}td{border-bottom:1px solid var(--border);color:var(--text-muted)}td:first-child{max-width:280px;overflow:hidden;text-overflow:ellipsis;color:var(--text)}td:nth-child(2),td:nth-child(3),td:nth-child(4){font-family:var(--font-mono);font-variant-numeric:tabular-nums}.share{display:inline-block;width:65px;height:4px;margin-right:8px;background:var(--surface-raised);vertical-align:middle}.share i{display:block;height:100%;background:var(--blue-chart)}.show-all{margin:6px 0}
@media(max-width:900px){main{padding:18px 18px 40px}.three-col{grid-template-columns:repeat(2,minmax(0,1fr))}.three-col>.card:last-child{grid-column:1/-1}}
@media(max-width:600px){.usage-header{align-items:flex-start;flex-direction:column}.usage-actions{width:100%;flex-wrap:wrap}.range-picker{flex:1}.range-picker select{width:100%}.usage-actions .ghost-button{flex:1}.topbar{padding:0 14px;gap:12px}.topbar-title{padding-left:10px}.topbar nav{gap:10px}.topbar nav a{font-size:10px}main{padding:14px 12px 36px}.filterbar{align-items:center;display:flex;gap:8px}.filter-tools{margin:0;display:flex;flex-wrap:wrap}.filter-tools button{padding:8px}.kpis{grid-template-columns:1fr;gap:8px}.kpi{min-height:128px;padding:12px 10px 32px}.kpi-value{font-size:20px}.two-col,.three-col{grid-template-columns:1fr}.three-col>.card:last-child{grid-column:auto}.card{padding:13px}.donut-layout{grid-template-columns:1fr;gap:6px}.donut-svg{width:180px;height:180px;max-height:none;justify-self:center}.donut-center{font-size:13px}.rank-list{max-height:230px}.harness-row{grid-template-columns:minmax(55px,.7fr) minmax(30px,1fr) auto minmax(30px,1fr) auto;gap:5px}.harness-row small{font-size:10px}.axis{font-size:11px}table{font-size:10px}th,td{padding:9px 6px}td:first-child{max-width:110px}.table-card input{min-width:120px}.series-switch button{padding:5px 4px;font-size:10px}}
`;

export const USAGE_PAGE = renderUsagePage();
