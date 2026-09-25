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
const PAGE_FORBIDDEN = 'Run "codedeck ui" once in a terminal to open CodeDeck in this browser.';

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

    const cookie = `codedeck_ui_token_${handle.port}=${handle.security.token}`;
    const accepted = await request(handle, { path: "/action", host: `LOCALHOST:${handle.port}`, cookie });
    expect(accepted.status).toBe(200);

    const acceptedIp = await request(handle, { path: "/page", host: `127.0.0.1:${handle.port}`, cookie });
    expect(acceptedIp.status).toBe(200);
  });

  it("rejects a missing or unapproved Host before route dispatch", async () => {
    const { handle, calls } = await makeServer();

    const missing = await request(handle, { path: "/page" });
    const foreign = await request(handle, { path: "/page", host: `example.test:${handle.port}` });

    expect(missing.status).toBe(403);
    expect(missing.body).toBe("forbidden");
    expect(foreign.status).toBe(403);
    expect(foreign.body).toBe("forbidden");
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
      `codedeck_ui_token_${handle.port}=${handle.security.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
    ]);
  });

  it("keeps the remaining query when the token redirect drops t", async () => {
    const { handle } = await makeServer();

    const response = await request(handle, {
      path: `/page?repo=%2Fx&t=${handle.security.token}`,
      host: `127.0.0.1:${handle.port}`,
    });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/page?repo=%2Fx");
  });

  it("rejects HTML GETs without the current token or cookie, sets no cookie, and adds the framing policy", async () => {
    const { handle, calls } = await makeServer();

    for (const path of ["/page", "/page?t=stale-token"]) {
      const response = await request(handle, { path, host: `127.0.0.1:${handle.port}` });
      expect(response.status).toBe(403);
      expect(response.body).toBe(PAGE_FORBIDDEN);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    }
    const stale = await request(handle, {
      path: "/page",
      host: `127.0.0.1:${handle.port}`,
      cookie: `codedeck_ui_token_${handle.port}=stale`,
    });
    expect(stale.status).toBe(403);
    expect(stale.body).toBe(PAGE_FORBIDDEN);
    expect(calls).toEqual([]);
  });

  it("serves an HTML GET that carries the current cookie", async () => {
    const { handle, calls } = await makeServer();

    const response = await request(handle, {
      path: "/page",
      host: `127.0.0.1:${handle.port}`,
      cookie: `codedeck_ui_token_${handle.port}=${handle.security.token}`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("page");
    expect(calls).toEqual(["page"]);
  });

  it("renews the year-long cookie on a page GET served with a valid cookie, with or without an invalid t", async () => {
    const { handle, calls } = await makeServer();
    const cookie = `codedeck_ui_token_${handle.port}=${handle.security.token}`;

    for (const path of ["/page", "/page?t=stale-token"]) {
      const response = await request(handle, { path, host: `127.0.0.1:${handle.port}`, cookie });
      expect(response.status).toBe(200);
      expect(response.headers["set-cookie"]).toEqual([
        `codedeck_ui_token_${handle.port}=${handle.security.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
      ]);
    }
    expect(calls).toEqual(["page", "page"]);
  });

  it("sends a localhost page GET to 127.0.0.1 with its path and query before any credential check", async () => {
    const { handle, calls } = await makeServer();
    const base = `http://127.0.0.1:${handle.port}`;

    const bare = await request(handle, { path: "/page?repo=%2Fx", host: `LocalHost:${handle.port}` });
    const withToken = await request(handle, { path: `/page?t=${handle.security.token}`, host: `localhost:${handle.port}` });
    const absolute = await request(handle, { path: "http://evil.test/page?keep=1", host: `localhost:${handle.port}` });

    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe(`${base}/page?repo=%2Fx`);
    expect(bare.headers["set-cookie"]).toBeUndefined();
    expect(withToken.status).toBe(302);
    expect(withToken.headers.location).toBe(`${base}/page?t=${handle.security.token}`);
    expect(absolute.status).toBe(302);
    expect(absolute.headers.location).toBe(`${base}/page?keep=1`);
    expect(calls).toEqual([]);
  });

  it("rejects API GETs without the current cookie before dispatch", async () => {
    const { handle, calls } = await makeServer();
    const host = `127.0.0.1:${handle.port}`;

    for (const cookie of [undefined, `codedeck_ui_token_${handle.port}=stale`]) {
      const response = await request(handle, { path: "/action", host, cookie });
      expect(response.status).toBe(403);
      expect(response.body).toBe("forbidden");
    }
    expect(calls).toEqual([]);

    const accepted = await request(handle, {
      path: "/action",
      host,
      cookie: `codedeck_ui_token_${handle.port}=${handle.security.token}`,
    });
    expect(accepted.status).toBe(200);
    expect(calls).toEqual(["action"]);
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
      expect(response.body).toBe("forbidden");
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
