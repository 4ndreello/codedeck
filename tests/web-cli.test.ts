import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFetch } from "./helpers/web-session.js";
import { Command } from "commander";
import { createCliProgram } from "../src/cli/index.js";
import { createUiRoutes, registerUiCommand } from "../src/cli/commands/ui.js";
import { registerSetupCommand } from "../src/cli/commands/setup.js";
import { registerUsageCommand } from "../src/cli/commands/usage.js";
import { DEFAULT_CONFIG, serializeConfig, type SetupConfigRead } from "../src/config/config.js";
import type { BatchModelsOptions, BatchModelsResult } from "../src/core/models.js";
import type { UsageQueryResult } from "../src/daemon/protocol.js";
import { startWebServer, type WebServerHandle, type WebServerOptions } from "../src/web/server.js";

const usageIpc = vi.hoisted(() => ({ ensureDaemonStarted: vi.fn(), request: vi.fn() }));
vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = usageIpc.ensureDaemonStarted;
    request = usageIpc.request;
  },
}));

const handles: WebServerHandle[] = [];
const originalExitCode = process.exitCode;

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  process.exitCode = originalExitCode;
  usageIpc.ensureDaemonStarted.mockReset();
  usageIpc.request.mockReset();
  vi.restoreAllMocks();
});

async function startEphemeralServer(options: WebServerOptions): Promise<WebServerHandle> {
  const handle = await startWebServer({
    ...options,
    port: 0,
    signalTarget: new EventEmitter(),
    exit: vi.fn(),
  });
  handles.push(handle);
  return handle;
}

const setupRead: SetupConfigRead = {
  status: "ok",
  source: "canonical",
  path: "/tmp/codedeck-config.json",
  config: { ...DEFAULT_CONFIG, agents: {} },
  raw: serializeConfig({ ...DEFAULT_CONFIG, agents: {} }),
  message: null,
};

const emptyCatalog: BatchModelsResult = {
  models: [],
  status: "fresh",
  source: "cache",
  ageMs: 0,
  cacheWriteFailed: false,
};

const emptyUsage: UsageQueryResult = {
  range: { period: "today", since: "2026-09-22T00:00:00.000Z", until: "2026-09-22T23:59:59.999Z" },
  totals: {
    sessionCount: 0,
    activeSessionCount: 0,
    completedSessionCount: 0,
    failedSessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costComplete: true,
    sessionsWithoutCost: 0,
  },
  byDay: [],
  byRepository: [],
  byModel: [],
  byAgent: [],
  byRun: [],
  byOrigin: [],
};

describe("ui CLI command", () => {
  it("appears in root help and opens the home page through the launcher", async () => {
    const root = createCliProgram();
    expect(root.helpInformation()).toContain("ui");

    const launch = vi.fn(async () => 0);
    const program = new Command();
    registerUiCommand(program, { launch });
    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    expect(launch).toHaveBeenCalledWith({ path: "/", title: "CodeDeck UI", port: undefined, open: false });
    expect(process.exitCode).toBe(originalExitCode);
  });

  it("sends an explicit port to the launcher", async () => {
    const launch = vi.fn(async () => 0);
    const program = new Command();
    registerUiCommand(program, { launch });

    await program.parseAsync(["node", "codedeck", "ui", "--port", "4200"], { from: "node" });

    expect(launch).toHaveBeenCalledWith({ path: "/", title: "CodeDeck UI", port: 4200, open: true });
  });

  it("rejects an invalid port without launching", async () => {
    const launch = vi.fn(async () => 0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerUiCommand(program, { launch });

    await program.parseAsync(["node", "codedeck", "ui", "--port", "0"], { from: "node" });

    expect(launch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("--port must be a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("exits with the launcher's failure code", async () => {
    const program = new Command();
    registerUiCommand(program, { launch: vi.fn(async () => 1) });

    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    expect(process.exitCode).toBe(1);
  });
});

describe("ui route table", () => {
  it("serves its registered home, review, setup, and usage pages", async () => {
    const started = await startEphemeralServer({ routes: createUiRoutes(), initialPath: "/", open: false, log: vi.fn() });

    const rootResponse = await sessionFetch(started)(`${started.baseUrl}/`);
    const rootHtml = await rootResponse.text();
    expect(rootResponse.status).toBe(200);
    expect(rootHtml).not.toContain('href="/"');
    expect(rootHtml).toContain('href="/review"');
    expect(rootHtml).toContain('href="/setup"');
    expect(rootHtml).toContain('href="/usage"');

    const reviewResponse = await sessionFetch(started)(`${started.baseUrl}/review`);
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(await reviewResponse.text()).toContain("Review local");

    const setupResponse = await sessionFetch(started)(`${started.baseUrl}/setup`);
    const setupHtml = await setupResponse.text();
    const usageResponse = await sessionFetch(started)(`${started.baseUrl}/usage`);
    const setupNav = setupHtml.split('<nav aria-label="Main navigation">')[1]?.split("</nav>")[0] ?? "";
    expect(setupResponse.status).toBe(200);
    expect(setupNav).toContain('href="/">Home</a>');
    expect(setupNav).toContain('href="/review">Review</a>');
    expect(setupNav).toContain('href="/setup" aria-current="page" class="active">Setup</a>');
    expect(setupNav).toContain('href="/usage">Usage</a>');
    expect(usageResponse.status).toBe(200);
  });

  it("serves setup state, catalog, actions, and usage query routes", async () => {
    const getBatchModels = vi.fn(async (_options: BatchModelsOptions) => emptyCatalog);
    const fetchUsageQuery = vi.fn(async () => emptyUsage);
    const started = await startEphemeralServer({
      routes: createUiRoutes({
        setup: { readConfig: () => setupRead, getBatchModels },
        usage: { fetchUsageQuery, cwd: "/repo" },
      }),
      initialPath: "/",
      open: false,
      log: vi.fn(),
    });

    const baseUrl = started.baseUrl;
    const home = await sessionFetch(started)(`${baseUrl}/`);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('href="/setup"');
    expect(homeHtml).toContain('href="/usage"');
    expect((await sessionFetch(started)(`${baseUrl}/api/setup/state`)).status).toBe(200);
    expect((await sessionFetch(started)(`${baseUrl}/api/setup/catalog`)).status).toBe(200);

    const headers = {
      cookie: `codedeck_ui_token_${started.port}=${started.security.token}`,
      origin: baseUrl,
      "content-type": "application/json",
    };
    const emptySelection = JSON.stringify({ agents: {} });
    const refresh = await sessionFetch(started)(`${baseUrl}/api/setup/catalog/refresh`, { method: "POST", headers });
    const dryRun = await sessionFetch(started)(`${baseUrl}/api/setup/dry-run`, {
      method: "POST",
      headers,
      body: emptySelection,
    });
    const apply = await sessionFetch(started)(`${baseUrl}/api/setup/apply`, {
      method: "POST",
      headers,
      body: emptySelection,
    });
    expect(refresh.status).toBe(200);
    expect(dryRun.status).toBe(200);
    expect(apply.status).toBe(200);

    const usage = await sessionFetch(started)(`${baseUrl}/api/usage`);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual(emptyUsage);
    expect(fetchUsageQuery).toHaveBeenCalledOnce();
    expect(getBatchModels).toHaveBeenCalledWith({ allowNetwork: false });
    expect(getBatchModels).toHaveBeenCalledWith({ refresh: true, allowNetwork: true, timeoutMs: 12_000 });
  });
});

describe("setup and usage web commands", () => {
  it("opens setup on its selected port without opening a browser", async () => {
    const launch = vi.fn(async () => 0);
    const program = new Command();
    registerSetupCommand(program, { launch });

    await program.parseAsync(["node", "codedeck", "setup", "--port", "32123", "--no-open"], { from: "node" });

    expect(launch).toHaveBeenCalledWith(
      { path: "/setup", query: {}, title: "CodeDeck setup", port: 32123, open: false },
      expect.anything(),
    );
    expect(process.exitCode).toBe(0);
  });

  it("opens aggregate usage with the resolved filters, breakdown, and interval", async () => {
    const cwd = "/web-current/repo";
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const launch = vi.fn(async () => 0);
    const program = new Command();
    registerUsageCommand(program, { launch });

    await program.parseAsync([
      "node", "codedeck", "usage", "--web", "--json", "--port", "32124", "--no-open",
      "--since", "2026-09-01", "--until", "2026-09-20", "--repo", "/selected/repo",
      "--current", "--model", "gpt-5", "--agent", "codex", "--by", "origin", "--interval", "0",
    ], { from: "node" });

    expect(launch).toHaveBeenCalledWith({
      path: "/usage",
      query: {
        repo: cwd,
        model: "gpt-5",
        agent: "codex",
        since: "2026-09-01",
        until: "2026-09-20",
        by: "origin",
        interval: "0",
      },
      title: "CodeDeck usage",
      port: 32124,
      open: false,
    });
  });

  it("rejects usage --web --tui without launching", async () => {
    const launch = vi.fn(async () => 0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerUsageCommand(program, { launch });

    await program.parseAsync(["node", "codedeck", "usage", "--web", "--tui"], { from: "node" });

    expect(launch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Options --web and --tui cannot be used together.");
    expect(process.exitCode).toBe(2);
  });

  it("keeps usage <run-id> --web --json on usage.get without launching", async () => {
    const summary = {
      runId: "run-web",
      inputTokens: 12,
      outputTokens: 3,
      cachedTokens: 1,
      costUsd: 0.1,
      sessionCount: 1,
      activeSessionCount: 0,
      costComplete: true,
      sessionsWithoutCost: 0,
      orchestrator: { costUsd: 0, costComplete: true, inputTokens: 0, outputTokens: 0, cachedTokens: 0, sources: [] },
      total: { costUsd: 0.1 },
    };
    usageIpc.ensureDaemonStarted.mockResolvedValue(undefined);
    usageIpc.request.mockResolvedValue(summary);
    const launch = vi.fn(async () => 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUsageCommand(program, { launch });

    await program.parseAsync(["node", "codedeck", "usage", "run-web", "--web", "--json"], { from: "node" });

    expect(usageIpc.request).toHaveBeenCalledWith("usage.get", { runId: "run-web" });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(summary);
    expect(launch).not.toHaveBeenCalled();
  });
});
