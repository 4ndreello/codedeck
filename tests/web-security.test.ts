import http from "node:http";
import os from "node:os";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webBaseUrl } from "../src/config/web-host.js";
import { createWebServer, startWebServer, type WebRoute, type WebServerHandle } from "../src/web/server.js";
import { createWebSecurity, type WebSecurity } from "../src/web/security.js";

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
  options: { method?: string; path: string; host?: string; origin?: string; cookie?: string; connectHost?: string },
): Promise<ResponseValue> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers.host = options.host;
    if (options.origin !== undefined) headers.origin = options.origin;
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    const req = http.request(
      {
        hostname: options.connectHost ?? "127.0.0.1",
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

async function makeServer(listenHost = "127.0.0.1"): Promise<{ handle: WebServerHandle; calls: string[] }> {
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
    host: listenHost,
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

function makeInterfaces(
  addresses: Array<{ address: string; family: "IPv4" | "IPv6"; internal?: boolean }>,
): ReturnType<typeof os.networkInterfaces> {
  return {
    tailscale0: addresses.map(({ address, family, internal = false }) => ({
      address,
      family,
      internal,
      netmask: family === "IPv4" ? "255.255.255.255" : "ffff:ffff:ffff:ffff::",
      mac: "00:00:00:00:00:00",
      cidr: null,
      ...(family === "IPv6" ? { scopeid: 0 } : {}),
    })),
  };
}

async function makeExtendedServer(
  networkInterfaces: typeof os.networkInterfaces,
  hostname: typeof os.hostname = () => "deck-host",
  options: { host?: string; listenHost?: string } = {},
): Promise<{ handle: WebServerHandle; calls: string[] }> {
  const calls: string[] = [];
  const routes: WebRoute[] = [
    {
      path: "/page",
      kind: "page",
      handler: (_request, response) => {
        calls.push("page");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("page");
      },
    },
    {
      path: "/action",
      kind: "api",
      handler: (_request, response) => {
        calls.push("action");
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ saved: true }));
      },
    },
  ];
  let security: WebSecurity | undefined;
  const server = createWebServer({ routes, getSecurity: () => security });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.listenHost ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  security = createWebSecurity(address.port, "test-token", {
    host: options.host ?? "100.101.102.103",
    networkInterfaces,
    hostname,
  });
  const handle: WebServerHandle = {
    server,
    address,
    port: address.port,
    baseUrl: webBaseUrl(options.host ?? "100.101.102.103", address.port),
    initialUrl: `${webBaseUrl(options.host ?? "100.101.102.103", address.port)}/page?t=test-token`,
    security,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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

  it("redirects localhost to 127.0.0.1 for a wildcard bind", async () => {
    const { handle } = await makeServer("0.0.0.0");

    const response = await request(handle, {
      path: "/page?repo=%2Fx",
      host: `localhost:${handle.port}`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`http://127.0.0.1:${handle.port}/page?repo=%2Fx`);
  });

  it("does not redirect localhost to 127.0.0.1 for a specific non-loopback bind", async () => {
    const networkInterfaces = vi.fn(() => makeInterfaces([{ address: "100.101.102.103", family: "IPv4" }]));
    const { handle } = await makeExtendedServer(networkInterfaces);

    const response = await request(handle, {
      path: "/page",
      host: `localhost:${handle.port}`,
    });

    expect(response.status).toBe(403);
    expect(response.body).toBe(PAGE_FORBIDDEN);
    expect(response.headers.location).toBeUndefined();
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

  it("allows current interface addresses, the machine hostname, and its MagicDNS suffix", async () => {
    const networkInterfaces = vi.fn(() => makeInterfaces([
      { address: "100.101.102.103", family: "IPv4" },
      { address: "fd7a:115c:a1e0::1", family: "IPv6" },
      { address: "fe80::1%tailscale0", family: "IPv6" },
    ]));
    const { handle } = await makeExtendedServer(networkInterfaces);
    const port = handle.port;
    const tokenPath = `/page?t=${handle.security.token}`;

    for (const host of [
      `100.101.102.103:${port}`,
      `[fd7a:115c:a1e0::1]:${port}`,
      `deck-host:${port}`,
      `DECK-HOST.tail1234.ts.net:${port}`,
    ]) {
      const response = await request(handle, { path: tokenPath, host });
      expect(response.status).toBe(303);
      expect(response.headers.location).toBe("/page");
    }

    for (const host of [
      `evil.example:${port}`,
      `deck-host.evil.com:${port}`,
      `deck-hostile:${port}`,
      `deck-hostile.tail1234.ts.net:${port}`,
      `deck-host.ts.net:${port}`,
      `deck-host..ts.net:${port}`,
      `deck-host.a_b.ts.net:${port}`,
      `100.101.102.103:${port + 1}`,
      `[deck-host]:${port}`,
      `[fe80::1%tailscale0]:${port}`,
      `[100.101.102.103]:${port}`,
      `fd7a:115c:a1e0::1:${port}`,
    ]) {
      const response = await request(handle, { path: tokenPath, host });
      expect(response.status).toBe(403);
      expect(response.body).toBe("forbidden");
    }
  });

  it.each([
    { bindHost: "0.0.0.0", connectHost: "127.0.0.1", hostHeader: (port: number) => `0.0.0.0:${port}` },
    { bindHost: "::", connectHost: "::1", hostHeader: (port: number) => `[::]:${port}` },
  ])("rejects wildcard bind $bindHost as a Host header", async ({ bindHost, connectHost, hostHeader }) => {
    const networkInterfaces = vi.fn(() => makeInterfaces([]));
    const { handle, calls } = await makeExtendedServer(networkInterfaces, () => "deck-host", {
      host: bindHost,
      listenHost: bindHost,
    });
    const response = await request(handle, {
      path: `/page?t=${handle.security.token}`,
      host: hostHeader(handle.port),
      connectHost,
    });

    expect(response.status).toBe(403);
    expect(response.body).toBe("forbidden");
    expect(calls).toEqual([]);
  });

  it("accepts the specific bind address when it is missing from local interfaces", async () => {
    const networkInterfaces = vi.fn(() => makeInterfaces([]));
    const { handle } = await makeExtendedServer(networkInterfaces, () => "deck-host", {
      host: "127.0.0.2",
      listenHost: "127.0.0.2",
    });
    const link = new URL("/page", handle.baseUrl);
    link.searchParams.set("t", handle.security.token);

    const response = await request(handle, {
      path: `${link.pathname}${link.search}`,
      host: `127.0.0.2:${handle.port}`,
      connectHost: "127.0.0.2",
    });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/page");
  });

  it("rejects machine hostname and non-loopback interface Hosts on the default bind", async () => {
    const { handle, calls } = await makeServer();
    handle.security.hostname = () => "deck-host";
    handle.security.networkInterfaces = () => makeInterfaces([{ address: "192.168.1.25", family: "IPv4" }]);

    const hostname = await request(handle, { path: `/page?t=${handle.security.token}`, host: `deck-host:${handle.port}` });
    const interfaceAddress = await request(handle, {
      path: `/page?t=${handle.security.token}`,
      host: `192.168.1.25:${handle.port}`,
    });

    expect(hostname.status).toBe(403);
    expect(hostname.body).toBe("forbidden");
    expect(interfaceAddress.status).toBe(403);
    expect(interfaceAddress.body).toBe("forbidden");
    expect(calls).toEqual([]);
  });

  it("evaluates interface addresses on each request", async () => {
    let interfaces = makeInterfaces([{ address: "100.101.102.103", family: "IPv4" }]);
    const networkInterfaces = vi.fn(() => interfaces);
    const { handle } = await makeExtendedServer(networkInterfaces, () => "deck-host", { host: "100.101.102.99" });
    const tokenPath = `/page?t=${handle.security.token}`;

    const beforeChange = await request(handle, { path: tokenPath, host: `100.101.102.103:${handle.port}` });
    interfaces = makeInterfaces([{ address: "100.101.102.104", family: "IPv4" }]);
    const removedAddress = await request(handle, { path: tokenPath, host: `100.101.102.103:${handle.port}` });
    const addedAddress = await request(handle, { path: tokenPath, host: `100.101.102.104:${handle.port}` });

    expect(beforeChange.status).toBe(303);
    expect(removedAddress.status).toBe(403);
    expect(addedAddress.status).toBe(303);
    expect(networkInterfaces).toHaveBeenCalledTimes(3);
  });

  it("keeps page tokens, API cookies, and same-origin POST checks on an accepted interface Host", async () => {
    const networkInterfaces = vi.fn(() => makeInterfaces([{ address: "100.101.102.103", family: "IPv4" }]));
    const { handle, calls } = await makeExtendedServer(networkInterfaces);
    const host = `100.101.102.103:${handle.port}`;
    const token = handle.security.token;
    const cookie = `codedeck_ui_token_${handle.port}=${token}`;

    const barePage = await request(handle, { path: "/page", host });
    const tokenPage = await request(handle, { path: `/page?t=${token}`, host });
    const apiWithoutCookie = await request(handle, { path: "/action", host });
    const apiWithCookie = await request(handle, { path: "/action", host, cookie });
    const crossOriginPost = await request(handle, {
      method: "POST",
      path: "/action",
      host,
      cookie,
      origin: `http://evil.example:${handle.port}`,
    });
    const sameOriginPost = await request(handle, {
      method: "POST",
      path: "/action",
      host,
      cookie,
      origin: `http://${host}`,
    });

    expect(barePage.status).toBe(403);
    expect(barePage.body).toBe(PAGE_FORBIDDEN);
    expect(tokenPage.status).toBe(303);
    expect(tokenPage.headers["set-cookie"]).toEqual([
      `${cookie}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
    ]);
    expect(apiWithoutCookie.status).toBe(403);
    expect(apiWithoutCookie.body).toBe("forbidden");
    expect(apiWithCookie.status).toBe(200);
    expect(crossOriginPost.status).toBe(403);
    expect(crossOriginPost.body).toBe("forbidden");
    expect(sameOriginPost.status).toBe(200);
    expect(JSON.parse(sameOriginPost.body)).toEqual({ saved: true });
    expect(calls).toEqual(["action", "action"]);
  });
});
