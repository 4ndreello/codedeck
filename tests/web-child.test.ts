import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeBuildId } from "../src/daemon/build-id.js";
import { runWebChild, type RunWebChildOptions } from "../src/web/child.js";

vi.mock("../src/daemon/build-id.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/daemon/build-id.js")>();
  return { ...actual, computeBuildId: vi.fn(actual.computeBuildId) };
});
import type { ListeningWebServer, WebRoute } from "../src/web/server.js";

interface Handshake { port: number; token: string; build: string }

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function firstLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end >= 0) resolve(buffer.slice(0, end));
    });
  });
}

async function startChild(overrides: Partial<RunWebChildOptions> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signalTarget = new EventEmitter();
  const exit = vi.fn();
  const line = firstLine(stdout);
  await runWebChild({ port: 0, stdin, stdout, exit, signalTarget, build: "build-1", ...overrides });
  const handshake = JSON.parse(await line) as Record<string, unknown>;
  cleanups.push(() => stdin.end());
  return { stdin, stdout, signalTarget, exit, handshake };
}

function cookieFor(handshake: Handshake): string {
  return `codedeck_ui_token_${handshake.port}=${handshake.token}`;
}

function fakeListening(): ListeningWebServer {
  const server = http.createServer();
  return {
    server,
    address: { address: "127.0.0.1", family: "IPv4", port: 3100 },
    port: 3100,
    baseUrl: "http://127.0.0.1:3100",
    security: { token: "fake-token", port: 3100, cookieName: "codedeck_ui_token_3100" } as ListeningWebServer["security"],
    close: async () => {},
  };
}

describe("runWebChild", () => {
  it("prints one handshake line and serves the console pages after the token redirect", async () => {
    const { handshake } = await startChild();
    const { port, token, build } = handshake as unknown as Handshake;

    expect(Object.keys(handshake).sort()).toEqual(["build", "port", "token"]);
    expect(port).toBeGreaterThan(0);
    expect(typeof token).toBe("string");
    expect(build).toBe("build-1");

    const redirect = await fetch(`http://127.0.0.1:${port}/?t=${token}`, { redirect: "manual" });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("set-cookie")).toContain(cookieFor(handshake as unknown as Handshake));

    for (const path of ["/", "/review", "/setup", "/usage"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { cookie: cookieFor(handshake as unknown as Handshake) },
      });
      expect(response.status, path).toBe(200);
    }
  });

  it("computes its build identity from its dist tree when none is given", async () => {
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-child-dist-"));
    cleanups.push(() => fs.rmSync(distRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(distRoot, "web"));
    fs.writeFileSync(path.join(distRoot, "web", "child.js"), "");
    fs.utimesSync(path.join(distRoot, "web", "child.js"), 4_000, 4_000);

    const { handshake } = await startChild({ build: undefined, distRoot, routes: () => [] });

    expect(handshake.build).toBe("4000000");
  });

  it("computes its build identity from its own dist root by default", async () => {
    vi.mocked(computeBuildId).mockReturnValueOnce("own-tree");

    const { handshake } = await startChild({ build: undefined, routes: () => [] });

    expect(computeBuildId).toHaveBeenLastCalledWith(path.join(import.meta.dirname, "..", "src"));
    expect(handshake.build).toBe("own-tree");
  });

  it("asks for the ephemeral fallback only when no port was given", async () => {
    const listen = vi.fn(async () => fakeListening());

    await startChild({ port: undefined, listen, routes: () => [] });
    await startChild({ port: 4567, listen, routes: () => [] });

    expect(listen.mock.calls.map(([options]) => [options.port, options.fallbackToEphemeral])).toEqual([
      [undefined, true],
      [4567, false],
    ]);
  });

  it("prints an error handshake and exits 1 when listening fails", async () => {
    const listen = vi.fn(async () => { throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:4567"); });
    const stdout = new PassThrough();
    const exit = vi.fn();
    const line = firstLine(stdout);

    await runWebChild({ port: 4567, stdin: new PassThrough(), stdout, exit, listen, routes: () => [], build: "b" });

    expect(JSON.parse(await line)).toEqual({
      error: { message: "listen EADDRINUSE: address already in use 127.0.0.1:4567", port: 4567 },
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it.each([
    ["stdin ends", (child: Awaited<ReturnType<typeof startChild>>) => child.stdin.end()],
    ["SIGTERM arrives", (child: Awaited<ReturnType<typeof startChild>>) => child.signalTarget.emit("SIGTERM")],
  ])("stops serving and exits 0 when %s, without waiting for an in-flight request", async (_label, trigger) => {
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const hang: WebRoute = { path: "/hang", kind: "page", handler: () => { entered(); } };
    const child = await startChild({ routes: () => [hang] });
    const { port } = child.handshake as unknown as Handshake;

    const pending = new Promise<string>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/hang", headers: { cookie: cookieFor(child.handshake as unknown as Handshake) } });
      req.on("response", () => resolve("response"));
      req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    await inFlight;

    trigger(child);

    await vi.waitFor(() => expect(child.exit).toHaveBeenCalledWith(0));
    expect(await pending).toBe("ECONNRESET");
    await expect(fetch(`http://127.0.0.1:${port}/hang`)).rejects.toThrow();
  });

  it("ignores EPIPE on stdout", async () => {
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const stdin = new PassThrough();
    const exit = vi.fn();

    await runWebChild({ port: 0, stdin, stdout, exit, signalTarget: new EventEmitter(), build: "b", routes: () => [] });
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
