import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type WebRoute, type WebServerHandle } from "../src/web/server.js";

interface ResponseValue {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const handles: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function request(
  handle: WebServerHandle,
  options: { method?: string; path: string; host?: string; origin?: string; cookie?: string },
): Promise<ResponseValue> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers.host = options.host;
    if (options.origin !== undefined) headers.origin = options.origin;
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: handle.port,
        path: options.path,
        method: options.method ?? "GET",
        setHost: false,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function makeServer(): Promise<{ handle: WebServerHandle; calls: string[] }> {
  const calls: string[] = [];
  const routes: WebRoute[] = [
    {
      path: "/page",
      kind: "page",
      handler: (_req, res) => {
        calls.push("page");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("page");
      },
    },
    {
      path: "/action",
      kind: "api",
      handler: (_req, res) => {
        calls.push("action");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ saved: true }));
      },
    },
  ];
  const handle = await startWebServer({
    routes,
    port: 0,
    initialPath: "/page",
    open: false,
    log: vi.fn(),
    signalTarget: new EventEmitter(),
    exit: vi.fn(),
  });
  handles.push(handle);
  return { handle, calls };
}

describe("web request security", () => {
  it("creates one 32-byte token and permits only the two bound loopback hosts", async () => {
    const { handle } = await makeServer();
    expect(handle.security.token).toMatch(/^[0-9a-f]{64}$/);

    const accepted = await request(handle, { path: "/page", host: `LOCALHOST:${handle.port}` });
    expect(accepted.status).toBe(200);

    const acceptedIp = await request(handle, { path: "/page", host: `127.0.0.1:${handle.port}` });
    expect(acceptedIp.status).toBe(200);
  });

  it("rejects a missing or unapproved Host before route dispatch", async () => {
    const { handle, calls } = await makeServer();

    const missing = await request(handle, { path: "/page" });
    const foreign = await request(handle, { path: "/page", host: `example.test:${handle.port}` });

    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("bootstraps a port-specific host-only cookie and redirects without the token", async () => {
    const { handle } = await makeServer();

    const response = await request(handle, {
      path: `/page?keep=yes&t=${handle.security.token}`,
      host: `127.0.0.1:${handle.port}`,
    });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/page?keep=yes");
    expect(response.headers["set-cookie"]).toEqual([
      `codedeck_ui_token_${handle.port}=${handle.security.token}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
  });

  it("does not set a cookie for HTML GETs without the current token and adds the framing policy", async () => {
    const { handle } = await makeServer();

    for (const path of ["/page", "/page?t=stale-token"]) {
      const response = await request(handle, { path, host: `127.0.0.1:${handle.port}` });
      expect(response.status).toBe(200);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    }
  });

  it("rejects POSTs without the current cookie and same-origin HTTP Origin before dispatch", async () => {
    const { handle, calls } = await makeServer();
    const host = `127.0.0.1:${handle.port}`;
    const validCookie = `codedeck_ui_token_${handle.port}=${handle.security.token}`;
    const cases = [
      { cookie: undefined, origin: `http://${host}` },
      { cookie: `codedeck_ui_token_${handle.port}=stale`, origin: `http://${host}` },
      { cookie: validCookie, origin: undefined },
      { cookie: validCookie, origin: `http://example.test:${handle.port}` },
      { cookie: validCookie, origin: `http://127.0.0.1:${handle.port + 1}` },
      { cookie: validCookie, origin: `https://${host}` },
    ];

    for (const value of cases) {
      const response = await request(handle, {
        method: "POST",
        path: "/action",
        host,
        cookie: value.cookie,
        origin: value.origin,
      });
      expect(response.status).toBe(403);
    }

    expect(calls).toEqual([]);

    const accepted = await request(handle, {
      method: "POST",
      path: "/action",
      host,
      cookie: validCookie,
      origin: `http://${host}`,
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ saved: true });
    expect(calls).toEqual(["action"]);
  });
});
