import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createCliProgram } from "../src/cli/index.js";
import { registerUiCommand } from "../src/cli/commands/ui.js";
import { registerSetupCommand } from "../src/cli/commands/setup.js";
import { registerUsageCommand, type UsageCommandDependencies } from "../src/cli/commands/usage.js";
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
  it("appears in root help and serves its registered home, review, setup, and usage pages", async () => {
    const root = createCliProgram();
    expect(root.helpInformation()).toContain("ui");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let started: WebServerHandle | undefined;
    const program = new Command();
    registerUiCommand(program, {
      startServer: async (options) => {
        started = await startWebServer({
          ...options,
          port: 0,
          signalTarget: new EventEmitter(),
          exit: vi.fn(),
        });
        handles.push(started);
        return started;
      },
    });
    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    expect(started).toBeDefined();
    expect(started?.initialUrl).toContain("?t=");
    expect(log.mock.calls.flat().join(" ")).toContain(started?.initialUrl);
    const rootResponse = await fetch(`${started?.baseUrl}/`);
    const rootHtml = await rootResponse.text();
    expect(rootResponse.status).toBe(200);
    expect(rootHtml).toContain('href="/review"');
    expect(rootHtml).toContain('href="/setup"');
    expect(rootHtml).toContain('href="/usage"');

    const reviewResponse = await fetch(`${started?.baseUrl}/review`);
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(await reviewResponse.text()).toContain("Review local");

    const setupResponse = await fetch(`${started?.baseUrl}/setup`);
    const usageResponse = await fetch(`${started?.baseUrl}/usage`);
    expect(setupResponse.status).toBe(200);
    expect(usageResponse.status).toBe(200);
  });

  it("rejects an invalid port without starting a server", async () => {
    const startServer = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerUiCommand(program, { startServer });

    await program.parseAsync(["node", "codedeck", "ui", "--port", "0"], { from: "node" });

    expect(startServer).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("--port must be a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("reports a listen failure without printing a started URL", async () => {
    const startServer = vi.fn(async () => {
      throw new Error("EADDRINUSE");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUiCommand(program, { startServer });

    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    expect(startServer).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Failed to listen on 127.0.0.1:3100: EADDRINUSE");
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("ui setup and usage routes", () => {
  it("serves setup state, catalog, actions, and usage query routes", async () => {
    const getBatchModels = vi.fn(async (_options: BatchModelsOptions) => emptyCatalog);
    const fetchUsageQuery = vi.fn(async () => emptyUsage);
    let started: WebServerHandle | undefined;
    const program = new Command();
    registerUiCommand(program, {
      setup: { readConfig: () => setupRead, getBatchModels },
      usage: { fetchUsageQuery, cwd: "/repo" },
      startServer: async (options) => {
        started = await startEphemeralServer(options);
        return started;
      },
    });
    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    const baseUrl = started!.baseUrl;
    const home = await fetch(`${baseUrl}/`);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('href="/setup"');
    expect(homeHtml).toContain('href="/usage"');
    expect((await fetch(`${baseUrl}/api/setup/state`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/setup/catalog`)).status).toBe(200);

    const headers = {
      cookie: `codedeck_ui_token_${started!.port}=${started!.security.token}`,
      origin: baseUrl,
      "content-type": "application/json",
    };
    const emptySelection = JSON.stringify({ agents: {} });
    const refresh = await fetch(`${baseUrl}/api/setup/catalog/refresh`, { method: "POST", headers });
    const dryRun = await fetch(`${baseUrl}/api/setup/dry-run`, {
      method: "POST",
      headers,
      body: emptySelection,
    });
    const apply = await fetch(`${baseUrl}/api/setup/apply`, {
      method: "POST",
      headers,
      body: emptySelection,
    });
    expect(refresh.status).toBe(200);
    expect(dryRun.status).toBe(200);
    expect(apply.status).toBe(200);

    const usage = await fetch(`${baseUrl}/api/usage`);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual(emptyUsage);
    expect(fetchUsageQuery).toHaveBeenCalledOnce();
    expect(getBatchModels).toHaveBeenCalledWith({ allowNetwork: false });
    expect(getBatchModels).toHaveBeenCalledWith({ refresh: true, allowNetwork: true, timeoutMs: 12_000 });
  });
});

describe("setup and usage web commands", () => {
  it("starts setup on its selected port without opening a browser", async () => {
    let requested: WebServerOptions | undefined;
    let started: WebServerHandle | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSetupCommand(program, {
      isTTY: true,
      startServer: async (options) => {
        requested = options;
        started = await startEphemeralServer(options);
        return started;
      },
    });

    await program.parseAsync(["node", "codedeck", "setup", "--port", "32123", "--no-open"], { from: "node" });

    expect(requested).toMatchObject({ initialPath: "/setup", port: 32123, open: false });
    expect(started?.initialUrl).toContain("?t=");
    expect(log.mock.calls.flat().join(" ")).toContain(started?.initialUrl);
    expect((await fetch(`${started?.baseUrl}/setup`)).status).toBe(200);
  });

  it("prints the token URL and keeps serving when the browser opener fails", async () => {
    let started: WebServerHandle | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUiCommand(program, {
      startServer: async (options) => {
        started = await startWebServer({
          ...options,
          port: 0,
          openBrowser: () => false,
          signalTarget: new EventEmitter(),
          exit: vi.fn(),
        });
        handles.push(started);
        return started;
      },
    });

    await program.parseAsync(["node", "codedeck", "ui"], { from: "node" });

    expect(log.mock.calls.flat().join(" ")).toContain(started?.initialUrl);
    expect((await fetch(`${started?.baseUrl}/`)).status).toBe(200);
  });

  it("opens aggregate usage with the selected filters, breakdown, interval, and token URL", async () => {
    const cwd = "/web-current/repo";
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const fetchUsageQuery = vi.fn(async () => emptyUsage);
    let requested: WebServerOptions | undefined;
    let started: WebServerHandle | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const startServer: NonNullable<UsageCommandDependencies["startServer"]> = async (options) => {
      requested = options;
      started = await startEphemeralServer(options);
      return started;
    };
    const program = new Command();
    registerUsageCommand(program, { startServer, fetchUsageQuery });

    await program.parseAsync([
      "node", "codedeck", "usage", "--web", "--json", "--port", "32124", "--no-open",
      "--since", "2026-09-01", "--until", "2026-09-20", "--repo", "/selected/repo",
      "--current", "--model", "gpt-5", "--agent", "codex", "--by", "origin", "--interval", "0",
    ], { from: "node" });

    expect(requested).toMatchObject({ initialPath: "/usage", port: 32124, open: false });
    expect(started?.initialUrl).toContain("?t=");
    expect(log.mock.calls.flat().join(" ")).toContain(started?.initialUrl);
    const page = await (await fetch(`${started?.baseUrl}/usage`)).text();
    expect(page).toContain(JSON.stringify({
      by: "origin",
      interval: "0",
      filters: {
        period: "",
        repo: cwd,
        model: "gpt-5",
        agent: "codex",
        since: "2026-09-01",
        until: "2026-09-20",
      },
    }));

    const query = await fetch(`${started?.baseUrl}/api/usage?since=2026-09-01&until=2026-09-20&repo=${encodeURIComponent(cwd)}&model=gpt-5&agent=codex`);
    expect(query.status).toBe(200);
    expect(fetchUsageQuery).toHaveBeenCalledWith({
      period: undefined,
      since: "2026-09-01",
      until: "2026-09-20",
      repository: cwd,
      model: "gpt-5",
      agent: "codex",
    });
  });

  it("rejects usage --web --tui without starting a server", async () => {
    const startServer = vi.fn(async (_options: WebServerOptions) => ({} as WebServerHandle));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerUsageCommand(program, { startServer });

    await program.parseAsync(["node", "codedeck", "usage", "--web", "--tui"], { from: "node" });

    expect(startServer).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Options --web and --tui cannot be used together.");
    expect(process.exitCode).toBe(2);
  });

  it("keeps usage <run-id> --web --json on usage.get without a server", async () => {
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
    const startServer = vi.fn(async (_options: WebServerOptions) => ({} as WebServerHandle));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUsageCommand(program, { startServer });

    await program.parseAsync(["node", "codedeck", "usage", "run-web", "--web", "--json"], { from: "node" });

    expect(usageIpc.request).toHaveBeenCalledWith("usage.get", { runId: "run-web" });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(summary);
    expect(startServer).not.toHaveBeenCalled();
  });
});
