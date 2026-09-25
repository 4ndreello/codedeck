import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFetch } from "./helpers/web-session.js";
import {
  DEFAULT_WEB_PORT,
  parseWebPort,
  startWebServer,
  type WebRoute,
  type WebServerHandle,
} from "../src/web/server.js";

const handles: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function testRoutes(seen: string[]): WebRoute[] {
  return [
    {
      path: "/",
      kind: "page",
      handler: (_req, res) => {
        seen.push("/");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("home page");
      },
    },
    {
      path: "/api/test",
      kind: "api",
      handler: (_req, res) => {
        seen.push("/api/test");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
  ];
}

describe("parseWebPort", () => {
  it("defaults to 3100 and accepts integer ports in range", () => {
    expect(DEFAULT_WEB_PORT).toBe(3100);
    expect(parseWebPort(undefined)).toBe(3100);
    expect(parseWebPort("8080")).toBe(8080);
    expect(parseWebPort("65535")).toBe(65535);
  });

  it("rejects values outside the user-facing port range", () => {
    for (const value of ["abc", "0", "-1", "65536", "3.5", ""]) {
      expect(() => parseWebPort(value)).toThrow("--port must be a positive integer");
    }
  });
});

describe("startWebServer", () => {
  it("binds loopback, dispatches registered routes, and returns the ephemeral port", async () => {
    const seen: string[] = [];
    const handle = await startWebServer({
      routes: testRoutes(seen),
      port: 0,
      initialPath: "/",
      open: false,
      log: vi.fn(),
      signalTarget: new EventEmitter(),
      exit: vi.fn(),
    });
    handles.push(handle);

    expect(handle.address.address).toBe("127.0.0.1");
    expect(handle.port).toBe(handle.address.port);
    expect(handle.baseUrl).toBe(`http://127.0.0.1:${handle.address.port}`);
    expect(handle.initialUrl).toBe(`${handle.baseUrl}/?t=${handle.security.token}`);

    const home = await sessionFetch(handle)(`${handle.baseUrl}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(await home.text()).toBe("home page");

    const api = await sessionFetch(handle)(`${handle.baseUrl}/api/test`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ok: true });

    const missing = await sessionFetch(handle)(`${handle.baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(seen).toEqual(["/", "/api/test"]);
  });

  it("opens or prints the same token URL and prints nothing if listen fails", async () => {
    const seen: string[] = [];
    const opened: string[] = [];
    const log = vi.fn();
    const handle = await startWebServer({
      routes: testRoutes(seen),
      port: 0,
      initialPath: "/",
      openBrowser: async (url) => {
        opened.push(url);
        return false;
      },
      log,
      signalTarget: new EventEmitter(),
      exit: vi.fn(),
    });
    handles.push(handle);

    expect(opened).toEqual([handle.initialUrl]);
    expect(log.mock.calls.flat().join(" ")).toContain(handle.initialUrl);

    const occupied = http.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const failedLog = vi.fn();
    await expect(
      startWebServer({
        routes: testRoutes(seen),
        port: address.port,
        initialPath: "/",
        open: false,
        log: failedLog,
        signalTarget: new EventEmitter(),
        exit: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(failedLog).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it.each(["SIGINT", "SIGTERM"] as const)("closes before exit on %s", async (signal) => {
    const signals = new EventEmitter();
    const calls: string[] = [];
    const handle = await startWebServer({
      routes: testRoutes([]),
      port: 0,
      initialPath: "/",
      open: false,
      log: vi.fn(),
      signalTarget: signals,
      closeServer: () => {
        calls.push("close");
      },
      exit: (code) => calls.push(`exit:${code}`),
    });
    handles.push(handle);

    signals.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual(["close", "exit:0"]);
  });
});

describe("route failure isolation", () => {
  async function startFailingServer(): Promise<WebServerHandle> {
    const routes: WebRoute[] = [
      { path: "/api/throw", kind: "api", handler: () => { throw new Error("sync boom"); } },
      { path: "/api/reject", kind: "api", handler: async () => { throw new Error("async boom"); } },
      {
        path: "/api/late",
        kind: "api",
        handler: async (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.write("partial");
          throw new Error("late boom");
        },
      },
      {
        path: "/api/ok",
        kind: "api",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        },
      },
    ];
    const handle = await startWebServer({
      routes,
      port: 0,
      initialPath: "/",
      open: false,
      log: vi.fn(),
      signalTarget: new EventEmitter(),
      exit: vi.fn(),
    });
    handles.push(handle);
    return handle;
  }

  it("answers 500 with the message when a handler throws synchronously", async () => {
    const handle = await startFailingServer();
    const response = await sessionFetch(handle)(`${handle.baseUrl}/api/throw`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "sync boom" });
  });

  it("answers 500 with the message when a handler rejects", async () => {
    const handle = await startFailingServer();
    const response = await sessionFetch(handle)(`${handle.baseUrl}/api/reject`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "async boom" });
  });

  it("ends a response whose headers were sent and keeps serving", async () => {
    const handle = await startFailingServer();
    const late = await sessionFetch(handle)(`${handle.baseUrl}/api/late`);
    expect(late.status).toBe(200);
    expect(await late.text()).toBe("partial");

    const next = await sessionFetch(handle)(`${handle.baseUrl}/api/ok`);
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ ok: true });
  });
});
