import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeBuildId } from "../src/daemon/build-id.js";
import { launchWebPage, type LaunchWebPageDependencies, type LaunchWebPageOptions } from "../src/cli/web-launch.js";
import type { WebServerHandle } from "../src/web/server.js";

// Keep the real implementation but record calls; the default-build test stubs one call
// so it does not walk the whole repository.
vi.mock("../src/daemon/build-id.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/daemon/build-id.js")>();
  return { ...actual, computeBuildId: vi.fn(actual.computeBuildId) };
});

const REPO_ROOT = path.join(import.meta.dirname, "..");

const BASE = { baseUrl: "http://127.0.0.1:3100", port: 3100, token: "tok" };

function ipcError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, details });
}

function setup(overrides: {
  ensure?: () => Promise<unknown>;
  start?: () => Promise<void>;
  opener?: boolean;
} = {}) {
  const request = vi.fn(async (_method: string, _params: unknown) => (overrides.ensure ?? (async () => BASE))());
  const ensureDaemonStarted = vi.fn(overrides.start ?? (async () => {}));
  const openBrowser = vi.fn(async (_url: string) => overrides.opener ?? true);
  const startServer = vi.fn(async () => ({}) as WebServerHandle);
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: LaunchWebPageDependencies = {
    client: { ensureDaemonStarted, request } as unknown as LaunchWebPageDependencies["client"],
    openBrowser,
    startServer,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    build: "build-1",
  };
  const launch = (options: Partial<LaunchWebPageOptions> = {}) =>
    launchWebPage({ path: "/review", query: { repo: "/work/app" }, title: "CodeDeck review", open: true, ...options }, deps);
  return { launch, deps, request, ensureDaemonStarted, openBrowser, startServer, logs, errors };
}

describe("launchWebPage", () => {
  it("opens the daemon page with the query and token, prints the URL line, and returns 0", async () => {
    const t = setup();

    const code = await t.launch();

    const url = "http://127.0.0.1:3100/review?repo=%2Fwork%2Fapp&t=tok";
    expect(code).toBe(0);
    expect(t.openBrowser).toHaveBeenCalledWith(url);
    expect(t.logs).toEqual([`CodeDeck review on ${url}`]);
    const [method, params] = t.request.mock.calls[0] as [string, { build: string; entry: string; port?: number }];
    expect(method).toBe("web.ensure");
    expect(params.build).toBe("build-1");
    expect(params.entry).toBe(path.join(REPO_ROOT, "src", "web", "child.js"));
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it("sends the build id of its own dist root when none is injected", async () => {
    const t = setup();
    vi.mocked(computeBuildId).mockReturnValueOnce("tree-build");

    await launchWebPage({ path: "/", title: "CodeDeck UI", open: false }, { ...t.deps, build: undefined });

    expect(computeBuildId).toHaveBeenLastCalledWith(path.join(REPO_ROOT, "src"));
    expect(t.request.mock.calls[0][1]).toMatchObject({ build: "tree-build" });
  });

  it("prints the URL without opening a browser when open is false", async () => {
    const t = setup();

    expect(await t.launch({ open: false })).toBe(0);

    expect(t.openBrowser).not.toHaveBeenCalled();
    expect(t.logs).toEqual(["CodeDeck review on http://127.0.0.1:3100/review?repo=%2Fwork%2Fapp&t=tok"]);
  });

  it("prints the manual-visit line when the browser cannot open", async () => {
    const t = setup({ opener: false });

    expect(await t.launch()).toBe(0);

    expect(t.logs).toEqual(["Could not open a browser, visit http://127.0.0.1:3100/review?repo=%2Fwork%2Fapp&t=tok manually."]);
  });

  it("sends an explicit port, omits a missing one, and notices a different running port", async () => {
    const t = setup();

    await t.launch({ port: 4200, open: false });
    await t.launch({ open: false });

    expect(t.request.mock.calls[0][1]).toMatchObject({ port: 4200 });
    expect(t.request.mock.calls[1][1]).not.toHaveProperty("port");
    expect(t.logs[0]).toBe("CodeDeck web is already running on port 3100");
    expect(t.logs.filter((line) => line.startsWith("CodeDeck web is already running"))).toHaveLength(1);
  });

  it("reports WEB_LISTEN_FAILED, returns 1 and does not fall back", async () => {
    const t = setup({ ensure: async () => { throw ipcError("WEB_LISTEN_FAILED", "listen EADDRINUSE", { port: 4200 }); } });

    expect(await t.launch({ port: 4200 })).toBe(1);

    expect(t.errors).toEqual(["Failed to listen on 127.0.0.1:4200: listen EADDRINUSE"]);
    expect(t.startServer).not.toHaveBeenCalled();
  });

  it.each(["UNKNOWN_METHOD", "SERVICE_UNAVAILABLE", "WEB_START_FAILED", "WEB_BAD_ENTRY"])("serves in-process with the full route table after %s", async (code) => {
    const t = setup({ ensure: async () => { throw ipcError(code, "nope"); } });

    expect(await t.launch({ query: { repo: "/work/my app&co" } })).toBe(0);

    expect(t.errors).toEqual([`CodeDeck daemon cannot host the web console (${code}); serving from this process.`]);
    const options = (t.startServer.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(options.routes.map((route: { path: string }) => route.path)).toEqual(expect.arrayContaining([
      "/", "/review", "/api/review", "/setup", "/usage", "/api/usage",
    ]));
    expect(options.routes.some((route: { path: string }) => route.path.startsWith("/api/setup/"))).toBe(true);
    const initial = new URL(options.initialPath, "http://127.0.0.1");
    expect(initial.pathname).toBe("/review");
    expect(initial.searchParams.get("repo")).toBe("/work/my app&co");
    expect(options.fallbackToEphemeral).toBe(true);
    expect(options.port).toBe(3100);
  });

  it("keeps an explicit port in the fallback and adds no ? for an empty query", async () => {
    const t = setup({ ensure: async () => { throw ipcError("UNKNOWN_METHOD", "nope"); } });

    await t.launch({ path: "/setup", query: {}, port: 4200 });

    const options = (t.startServer.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(options.initialPath).toBe("/setup");
    expect(options.port).toBe(4200);
    expect(options.fallbackToEphemeral).toBe(false);
  });

  it("serves in-process when the daemon cannot start", async () => {
    const t = setup({ start: async () => { throw new Error("Failed to start daemon"); } });

    expect(await t.launch()).toBe(0);

    expect(t.errors).toEqual(["CodeDeck daemon is unavailable; serving from this process."]);
    expect(t.request).not.toHaveBeenCalled();
    expect(t.startServer).toHaveBeenCalledTimes(1);
  });
});
