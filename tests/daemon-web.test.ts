import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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
    ensure: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4100", port: 4100, token: "tok" })),
    close: vi.fn(),
    ...overrides,
  };
}

describe("daemon web.ensure", () => {
  it("returns the supervisor result for the request params", async () => {
    const host = fakeHost();
    daemon = new Daemon({ webSupervisor: host });

    const response = await ensure({ port: 4100, build: "b1", entry: "/opt/codedeck/dist/web/child.js" });

    expect(response.result).toEqual({ baseUrl: "http://127.0.0.1:4100", port: 4100, token: "tok" });
    expect(host.ensure).toHaveBeenCalledWith({ port: 4100, build: "b1", entry: "/opt/codedeck/dist/web/child.js" });
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
