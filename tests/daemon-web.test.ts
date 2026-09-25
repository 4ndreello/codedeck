import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon, type WebHost } from "../src/daemon/daemon.js";
import { getPaths } from "../src/config/paths.js";
import { WebEnsureError, WebSupervisor, type WebChildProcess } from "../src/daemon/web-supervisor.js";
import { fakeSocket, makeDaemonTestContext, registerDaemonTestHooks, seam, seed } from "./helpers/daemon-seam.js";

let daemon: Daemon | undefined;
const testContext = makeDaemonTestContext("daemon-web-");
registerDaemonTestHooks(testContext, () => daemon, () => { daemon = undefined; });

async function ensure(params: unknown): Promise<Record<string, any>> {
  const { writes, socket } = fakeSocket();
  await seam(daemon!).handleRequest({ id: testContext.nextRequestId("web"), method: "web.ensure", params }, socket);
  return JSON.parse(writes[0]);
}

function fakeHost(overrides: Partial<WebHost> = {}): WebHost {
  return {
    ensure: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4100", host: "127.0.0.1", port: 4100, token: "tok" })),
    close: vi.fn(),
    ...overrides,
  };
}

describe("daemon web.ensure", () => {
  it("returns the supervisor result for the request params", async () => {
    const host = fakeHost();
    daemon = new Daemon({ webSupervisor: host });

    const response = await ensure({ host: "100.64.0.5", port: 4100, build: "b1", entry: "/opt/codedeck/dist/web/child.js" });

    expect(response.result).toEqual({ baseUrl: "http://127.0.0.1:4100", host: "127.0.0.1", port: 4100, token: "tok" });
    expect(host.ensure).toHaveBeenCalledWith({ host: "100.64.0.5", port: 4100, build: "b1", entry: "/opt/codedeck/dist/web/child.js" });
  });

  it("maps a supervisor error to an IPC error with the same code, message and details", async () => {
    daemon = new Daemon({
      webSupervisor: fakeHost({
        ensure: async () => { throw new WebEnsureError("WEB_LISTEN_FAILED", "listen EADDRINUSE", { port: 4567 }); },
      }),
    });

    const response = await ensure({ port: 4567 });

    expect(response.error).toEqual({ code: "WEB_LISTEN_FAILED", message: "listen EADDRINUSE", details: { port: 4567 } });
  });

  it("returns WEB_BAD_HOST for an invalid web.ensure host before spawning a child", async () => {
    const spawnChild = vi.fn(() => { throw new Error("unexpected child spawn"); });
    daemon = new Daemon({
      webSupervisor: new WebSupervisor({
        log: () => {},
        defaultEntry: "/opt/codedeck/dist/web/child.js",
        entryExists: () => true,
        spawnChild,
      }),
    });

    const response = await ensure({ preferredHost: "deck.local" });

    expect(response.error).toMatchObject({ code: "WEB_BAD_HOST" });
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("stops the web child before marking sessions during shutdown", async () => {
    let statusAtClose: string | undefined;
    const host = fakeHost({
      close: vi.fn(() => { statusAtClose = seam(daemon!).sessions.get("s1")?.status; }),
    });
    daemon = new Daemon({ webSupervisor: host });
    seed(daemon, "s1", "working");

    await seam(daemon).handleShutdown("SIGTERM");

    expect(host.close).toHaveBeenCalledTimes(1);
    expect(statusAtClose).toBe("working");
  });

  it("writes the listening and exit lines to daemon.log without the token and respawns after an exit", async () => {
    const children: EventEmitter[] = [];
    daemon = new Daemon({
      spawnWebChild: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          kill: () => true,
        });
        children.push(child);
        const port = 4100 + children.length;
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ port, token: `secret-${port}`, build: "b1" })}\n`));
        return child as unknown as WebChildProcess;
      },
    });

    expect((await ensure({})).result.port).toBe(4101);
    children[0].emit("exit", 3, null);
    expect((await ensure({})).result.port).toBe(4102);

    const log = fs.readFileSync(getPaths().daemonLog, "utf8");
    expect(log).toMatch(/\] web listening port=4101\n/);
    expect(log).toMatch(/\] web child exited code=3\n/);
    expect(log).toMatch(/\] web listening port=4102\n/);
    expect(log).not.toContain("secret-");
    expect(children).toHaveLength(2);
  });

  it("leaves session rows untouched while restarting the web child", async () => {
    const children: EventEmitter[] = [];
    const supervisor = new WebSupervisor({
      log: () => {},
      defaultEntry: "/opt/codedeck/dist/web/child.js",
      entryExists: () => true,
      spawnChild: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          kill: (signal?: string) => { queueMicrotask(() => child.emit("exit", null, signal)); return true; },
        });
        children.push(child);
        const port = 4100 + children.length;
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ port, token: `tok-${port}`, build: `b${children.length}` })}\n`));
        return child as unknown as WebChildProcess;
      },
    });
    daemon = new Daemon({ webSupervisor: supervisor });
    seed(daemon, "s1", "working", { pid: 999_999 });
    const before = seam(daemon).sessions.get("s1");

    expect((await ensure({ build: "b1" })).result.port).toBe(4101);
    expect((await ensure({ build: "b2" })).result.port).toBe(4102);

    expect(children).toHaveLength(2);
    expect(seam(daemon).sessions.get("s1")).toEqual(before);
  });
});

describe("daemon web autostart", () => {
  const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;
  const configDirs: string[] = [];
  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
    else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
    for (const dir of configDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function useConfig(config: unknown): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-web-autostart-"));
    configDirs.push(dir);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
    process.env.RUN_AGENT_CONFIG_DIR = dir;
  }

  const daemonLog = () => fs.readFileSync(getPaths().daemonLog, "utf8");

  it("asks the supervisor once for the preferred port from config, with no port, entry or build", async () => {
    useConfig({ web: { port: 7788, host: "100.64.0.5" } });
    const host = fakeHost();
    daemon = new Daemon({ webSupervisor: host });

    daemon.autostartWeb();

    expect(host.ensure).toHaveBeenCalledTimes(1);
    expect(host.ensure).toHaveBeenCalledWith({ preferredPort: 7788, preferredHost: "100.64.0.5" });
  });

  it("logs a failed autostart and keeps serving web.ensure", async () => {
    useConfig({});
    const hostEnsure = vi.fn()
      .mockRejectedValueOnce(new WebEnsureError("WEB_START_FAILED", "web child exited before its handshake (code=1)"))
      .mockResolvedValue({ baseUrl: "http://127.0.0.1:7777", host: "127.0.0.1", port: 7777, token: "tok" });
    daemon = new Daemon({ webSupervisor: fakeHost({ ensure: hostEnsure }) });

    daemon.autostartWeb();

    await vi.waitFor(() => expect(daemonLog()).toMatch(/\] web autostart failed: web child exited before its handshake \(code=1\)\n/));
    expect(hostEnsure).toHaveBeenNthCalledWith(1, { preferredPort: 7777, preferredHost: "127.0.0.1" });
    expect((await ensure({})).result).toEqual({ baseUrl: "http://127.0.0.1:7777", host: "127.0.0.1", port: 7777, token: "tok" });
  });

  it("logs an invalid web.port and falls back to 7777", async () => {
    useConfig({ web: { port: "7788" } });
    const host = fakeHost();
    daemon = new Daemon({ webSupervisor: host });

    daemon.autostartWeb();

    expect(daemonLog()).toMatch(/\] Ignoring invalid web.port in config: "7788"\n/);
    expect(host.ensure).toHaveBeenCalledWith({ preferredPort: 7777, preferredHost: "127.0.0.1" });
  });

  it("logs an invalid web.host and autostarts on loopback", async () => {
    useConfig({ web: { host: "deck.local" } });
    const logPath = getPaths().daemonLog;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "");
    const host = fakeHost();
    daemon = new Daemon({ webSupervisor: host });

    daemon.autostartWeb();

    expect(daemonLog()).toMatch(/\] Ignoring invalid web\.host in config: "deck\.local"\n/);
    expect(host.ensure).toHaveBeenCalledWith({ preferredPort: 7777, preferredHost: "127.0.0.1" });
  });

  it("does not start the web child from start()", async () => {
    const host = fakeHost();
    daemon = new Daemon({ webSupervisor: host });
    (daemon as unknown as { maybeSpawnInhibit: () => void }).maybeSpawnInhibit = () => {};

    await daemon.start();

    expect(host.ensure).not.toHaveBeenCalled();
  });

  it("autostarts the web console from the --daemon entry after start() resolves", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "daemon", "daemon.ts"), "utf8");
    const entry = source.slice(source.indexOf('if (process.argv.includes("--daemon"))'));

    expect(entry).toMatch(/d\.start\(\)\.then\(\s*\(\) => d\.autostartWeb\(\),/);
  });
});
