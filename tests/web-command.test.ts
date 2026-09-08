import http from "node:http";
import { Command } from "commander";
import { describe, expect, it, afterEach, vi } from "vitest";
import { CANVAS_PAGE } from "../src/web/canvas-page.js";
import {
  createWebHandler,
  parseSessionSubpath,
  parseWebPort,
  registerWebCommand,
  sseComment,
  sseData,
  sseNamed,
  type WebBridge,
} from "../src/cli/commands/web.js";

function bridge(overrides: Partial<WebBridge> = {}): WebBridge & { calls: string[] } {
  const calls: string[] = [];
  const base: WebBridge & { calls: string[] } = {
    calls,
    request: async (method: string) => {
      calls.push(method);
      if (method === "session.list") return { sessions: [] };
      if (method === "session.get") return { session: { id: "a1" } };
      if (method === "session.logs") return { events: [] };
      if (method === "daemon.status") return { ok: true };
      if (method === "usage.query") return { totals: {} };
      throw new Error(`unexpected method ${method}`);
    },
    subscribe: (_id, _onEvent, _onDone) => () => {},
    ...overrides,
  };
  return base;
}

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  servers = [];
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

describe("parseWebPort", () => {
  it("defaults to 3100", () => {
    expect(parseWebPort(undefined)).toBe(3100);
  });

  it("accepts a valid port", () => {
    expect(parseWebPort("8080")).toBe(8080);
  });

  it("rejects non-numeric, zero, and out-of-range ports", () => {
    for (const raw of ["abc", "0", "-1", "65536", "3.5", ""]) {
      expect(() => parseWebPort(raw)).toThrow("--port must be a positive integer");
    }
  });
});

describe("parseSessionSubpath", () => {
  it("matches get, stream, and logs", () => {
    expect(parseSessionSubpath(["api", "sessions", "a1"])).toEqual({ action: "get", id: "a1" });
    expect(parseSessionSubpath(["api", "sessions", "a1", "stream"])).toEqual({
      action: "stream",
      id: "a1",
    });
    expect(parseSessionSubpath(["api", "sessions", "a1", "logs"])).toEqual({
      action: "logs",
      id: "a1",
    });
  });

  it("decodes the session id", () => {
    expect(parseSessionSubpath(["api", "sessions", "a%201", "logs"])).toEqual({
      action: "logs",
      id: "a 1",
    });
  });

  it("rejects anything else", () => {
    expect(parseSessionSubpath(["api", "sessions"])).toBeNull();
    expect(parseSessionSubpath(["api", "sessions", "", "stream"])).toBeNull();
    expect(parseSessionSubpath(["api", "sessions", "a1", "send"])).toBeNull();
    expect(parseSessionSubpath(["api", "sessions", "a1", "stream", "x"])).toBeNull();
    expect(parseSessionSubpath(["api", "other", "a1"])).toBeNull();
  });
});

describe("sse framing", () => {
  it("frames data, named events, and comments", () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(sseNamed("done", {})).toBe("event: done\ndata: {}\n\n");
    expect(sseComment()).toBe(": conectado\n\n");
  });
});

describe("web handler", () => {
  it("serves the canvas page at /", async () => {
    const base = await listen(createWebHandler(bridge()));
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Canvas das runs");
  });

  it("answers health and unknown routes", async () => {
    const base = await listen(createWebHandler(bridge()));
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
  });

  it("proxies session list and get", async () => {
    const base = await listen(createWebHandler(bridge()));
    const list = await fetch(`${base}/api/sessions`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ sessions: [] });

    const get = await fetch(`${base}/api/sessions/a1`);
    expect(get.status).toBe(200);
  });

  it("returns 404 on the stream pre-flight when the session is unknown", async () => {
    const b = bridge();
    const inner = b.request;
    b.request = async (method: string, params: unknown) => {
      b.calls.push(method);
      if (method === "session.get") throw new Error("gone");
      return inner(method, params);
    };
    const base = await listen(createWebHandler(b));
    const res = await fetch(`${base}/api/sessions/zz/stream`);
    expect(res.status).toBe(404);
    expect(b.calls).toContain("session.get");
    expect(b.calls).not.toContain("session.subscribe");
  });

  it("streams one event then done, and unsubscribes on disconnect", async () => {
    let offCalled = false;
    const b = bridge({
      subscribe: (id, onEvent, onDone) => {
        expect(id).toBe("a1");
        const timer = setTimeout(() => {
          onEvent({ type: "text.delta", delta: "hi" });
          onDone?.();
        }, 10);
        return () => {
          offCalled = true;
          clearTimeout(timer);
        };
      },
    });
    const base = await listen(createWebHandler(b));
    const res = await fetch(`${base}/api/sessions/a1/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 4; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: done")) break;
    }
    await reader.cancel();
    expect(text).toContain(": conectado");
    expect(text).toContain('"text.delta"');
    expect(text).toContain("event: done");
    // Give the server close handler a tick to run the unsubscribe.
    await vi.waitFor(() => expect(offCalled).toBe(true));
  });
});

describe("canvas page", () => {
  it("wires the realtime endpoints", () => {
    expect(CANVAS_PAGE).toContain("api/sessions");
    expect(CANVAS_PAGE).toContain("new EventSource");
    expect(CANVAS_PAGE).toContain("text.delta");
  });

  it("makes no external requests", () => {
    const externals = CANVAS_PAGE.match(/https?:\/\/[^"'\s>]+/g) ?? [];
    expect(externals).toEqual([]);
  });

  it("keeps the template literal intact (no backticks or interpolation)", () => {
    expect(CANVAS_PAGE).not.toContain("`");
    expect(CANVAS_PAGE).not.toContain("${");
  });
});

describe("registerWebCommand", () => {
  it("registers the web command", () => {
    const program = new Command();
    registerWebCommand(program);
    expect(program.commands.map((c) => c.name())).toContain("web");
  });
});
