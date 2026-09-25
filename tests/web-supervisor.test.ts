import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnWebChild, WebSupervisor, type WebChildProcess, type WebSupervisorOptions } from "../src/daemon/web-supervisor.js";

const ENTRY = "/opt/codedeck/dist/web/child.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly signals: string[] = [];
  exitOn: string[] = ["SIGTERM", "SIGKILL"];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.exitOn.includes(signal)) queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  handshake(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function harness(overrides: Partial<WebSupervisorOptions> = {}) {
  const children: FakeChild[] = [];
  const spawns: { entry: string; args: string[] }[] = [];
  const lines: string[] = [];
  const supervisor = new WebSupervisor({
    log: (line) => lines.push(line),
    defaultEntry: ENTRY,
    entryExists: () => true,
    spawnChild: (entry, args) => {
      spawns.push({ entry, args });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as WebChildProcess;
    },
    ...overrides,
  });
  return { supervisor, children, spawns, lines };
}

const ok = (port = 4100, token = "tok-1", build = "b1") => ({ port, token, build });

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSupervisor.ensure", () => {
  it("spawns once and resolves the handshake result", async () => {
    const { supervisor, children, spawns } = harness();

    const pending = supervisor.ensure({ build: "b1" });
    children[0].handshake(ok());

    await expect(pending).resolves.toEqual({ baseUrl: "http://127.0.0.1:4100", port: 4100, token: "tok-1" });
    expect(spawns).toEqual([{ entry: ENTRY, args: ["--web-child"] }]);
  });

  it("reuses the running child for the same build or no build, and shares a start in flight", async () => {
    const { supervisor, children, spawns } = harness();

    const first = supervisor.ensure({ build: "b1" });
    const concurrent = supervisor.ensure({ build: "b1" });
    children[0].handshake(ok());
    const [a, b] = await Promise.all([first, concurrent]);

    expect(b).toEqual(a);
    await expect(supervisor.ensure({ build: "b1" })).resolves.toEqual(a);
    await expect(supervisor.ensure({})).resolves.toEqual(a);
    await expect(supervisor.ensure({ entry: ENTRY })).resolves.toEqual(a);
    expect(spawns).toHaveLength(1);
  });

  it("passes an explicit port and maps an error line to WEB_LISTEN_FAILED", async () => {
    const { supervisor, children, spawns } = harness();

    const pending = supervisor.ensure({ port: 4567 });
    children[0].handshake({ error: { message: "listen EADDRINUSE: address already in use 127.0.0.1:4567", port: 4567 } });

    await expect(pending).rejects.toMatchObject({
      code: "WEB_LISTEN_FAILED",
      message: "listen EADDRINUSE: address already in use 127.0.0.1:4567",
      details: { port: 4567 },
    });
    expect(spawns[0].args).toEqual(["--web-child", "--port", "4567"]);
  });

  it("fails the start when the child exits before its handshake", async () => {
    const { supervisor, children } = harness();

    const pending = supervisor.ensure({});
    children[0].emit("exit", 1, null);

    await expect(pending).rejects.toMatchObject({ code: "WEB_START_FAILED" });
  });

  it("kills the child and fails the start when no handshake arrives within 5000 ms", async () => {
    vi.useFakeTimers();
    const { supervisor, children } = harness();

    let outcome: unknown = "pending";
    supervisor.ensure({}).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(outcome).toBe("pending");
    expect(children[0].signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ code: "WEB_START_FAILED" });
    expect(children[0].signals).toEqual(["SIGKILL"]);
  });

  it("parses a handshake split across chunks and keeps the stream flowing afterwards", async () => {
    const { supervisor, children } = harness();

    const pending = supervisor.ensure({});
    children[0].stdout.write('{"port":4100,');
    children[0].stdout.write('"token":"tok-1","build":"b1"}\n');

    await expect(pending).resolves.toMatchObject({ port: 4100, token: "tok-1" });
    children[0].stdout.write("later output\n");
    expect(children[0].stdout.readableFlowing).toBe(true);
  });

  it.each([
    ["a non-JSON line", "listening on 4100\n"],
    ["a line without token", '{"port":4100}\n'],
  ])("kills the child and fails the start on %s", async (_label, line) => {
    const { supervisor, children } = harness();

    const pending = supervisor.ensure({});
    children[0].stdout.write(line);

    await expect(pending).rejects.toMatchObject({ code: "WEB_START_FAILED" });
    expect(children[0].signals).toEqual(["SIGKILL"]);
  });

  it("spawns the requested entry as the script", async () => {
    const other = "/home/me/codedeck/dist/web/child.js";
    const { supervisor, children, spawns } = harness();

    const pending = supervisor.ensure({ entry: other });
    children[0].handshake(ok());
    await pending;

    expect(spawns[0].entry).toBe(other);
  });

  it.each([
    ["a relative entry", "dist/web/child.js", true],
    ["an entry that is not the web child", "/opt/codedeck/dist/daemon/daemon.js", true],
    ["a missing entry", "/gone/dist/web/child.js", false],
  ])("rejects %s with WEB_BAD_ENTRY and spawns nothing", async (_label, entry, exists) => {
    const { supervisor, spawns } = harness({ entryExists: () => exists });

    await expect(supervisor.ensure({ entry })).rejects.toMatchObject({ code: "WEB_BAD_ENTRY" });
    expect(spawns).toEqual([]);
  });

  it("replaces the child when the same build comes from another entry", async () => {
    const other = "/home/me/codedeck/dist/web/child.js";
    const { supervisor, children, spawns } = harness();
    const first = supervisor.ensure({ build: "b1" });
    children[0].handshake(ok());
    await first;

    const second = supervisor.ensure({ build: "b1", entry: other });
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].handshake(ok(4101, "tok-2", "b1"));

    await expect(second).resolves.toMatchObject({ port: 4101, token: "tok-2" });
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(spawns.map((spawned) => spawned.entry)).toEqual([ENTRY, other]);
  });

  it("logs a child exit after the handshake and spawns again on the next ensure", async () => {
    const { supervisor, children, spawns, lines } = harness();
    const first = supervisor.ensure({});
    children[0].handshake(ok());
    await first;

    children[0].emit("exit", 7, null);
    const second = supervisor.ensure({});
    children[1].handshake(ok(4101, "tok-2"));

    await expect(second).resolves.toMatchObject({ port: 4101 });
    expect(lines).toContain("web child exited code=7");
    expect(spawns).toHaveLength(2);
  });

  it("stops an old build with SIGTERM, escalates to SIGKILL after the stop timeout, and returns the new child", async () => {
    vi.useFakeTimers();
    const { supervisor, children } = harness();
    const first = supervisor.ensure({ build: "b1" });
    children[0].handshake(ok());
    await first;
    children[0].exitOn = ["SIGKILL"];

    const second = supervisor.ensure({ build: "b2" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].handshake(ok(4101, "tok-2", "b2"));

    await expect(second).resolves.toMatchObject({ port: 4101, token: "tok-2" });
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("logs the listening port and never the token", async () => {
    const { supervisor, children, lines } = harness();

    const pending = supervisor.ensure({});
    children[0].handshake(ok(4100, "secret-token"));
    await pending;

    expect(lines).toEqual(["web listening port=4100"]);
    expect(lines.join("\n")).not.toContain("secret-token");
  });
});

describe("WebSupervisor port rules", () => {
  async function running(t: ReturnType<typeof harness>, params: Parameters<WebSupervisor["ensure"]>[0], port = 4100) {
    const pending = t.supervisor.ensure(params);
    await vi.waitFor(() => expect(t.children.length).toBeGreaterThan(0));
    t.children[t.children.length - 1].handshake(ok(port, `tok-${port}`));
    return pending;
  }

  it("passes a preferred port as --preferred-port", async () => {
    const t = harness();

    await running(t, { preferredPort: 7777 });

    expect(t.spawns[0].args).toEqual(["--web-child", "--preferred-port", "7777"]);
  });

  it.each([
    ["another preferred port", { preferredPort: 7777 }],
    ["an explicit port", { port: 8000 }],
    ["no port argument", {}],
  ])("restarts a child started for %s when a request brings preferred port 7788", async (_label, first) => {
    const t = harness();
    await running(t, first);

    const second = t.supervisor.ensure({ preferredPort: 7788 });
    await vi.waitFor(() => expect(t.children).toHaveLength(2));
    t.children[1].handshake(ok(7788, "tok-2"));

    await expect(second).resolves.toMatchObject({ port: 7788, token: "tok-2" });
    expect(t.children[0].signals).toEqual(["SIGTERM"]);
    expect(t.spawns[1].args).toEqual(["--web-child", "--preferred-port", "7788"]);
  });

  it("reuses a child started for the same preferred port, even when it fell back to another port", async () => {
    const t = harness();
    const first = await running(t, { preferredPort: 7777 }, 40123);

    await expect(t.supervisor.ensure({ preferredPort: 7777 })).resolves.toEqual(first);

    expect(t.spawns).toHaveLength(1);
    expect(t.children[0].signals).toEqual([]);
  });

  it.each([
    ["an explicit port", { port: 8000 }],
    ["neither port field", {}],
  ])("reuses a child started for a preferred port when a request brings %s", async (_label, request) => {
    const t = harness();
    const first = await running(t, { preferredPort: 7777 });

    await expect(t.supervisor.ensure(request)).resolves.toEqual(first);

    expect(t.spawns).toHaveLength(1);
  });

  it("runs the starts that waiting requests need one after the other, never two children at once", async () => {
    const alive = new Set<FakeChild>();
    const aliveAtSpawn: number[] = [];
    const t = harness({
      spawnChild: (entry, args) => {
        aliveAtSpawn.push(alive.size);
        t.spawns.push({ entry, args });
        const child = new FakeChild();
        alive.add(child);
        child.once("exit", () => alive.delete(child));
        t.children.push(child);
        return child as unknown as WebChildProcess;
      },
    });

    const a = t.supervisor.ensure({ preferredPort: 7777 });
    const b = t.supervisor.ensure({ preferredPort: 7788 });
    const c = t.supervisor.ensure({ preferredPort: 7799 });
    for (const [index, port] of [7777, 7788, 7799].entries()) {
      await vi.waitFor(() => expect(t.children).toHaveLength(index + 1));
      t.children[index].handshake(ok(port, `tok-${port}`));
    }

    await expect(a).resolves.toMatchObject({ port: 7777 });
    await expect(b).resolves.toMatchObject({ port: 7788 });
    await expect(c).resolves.toMatchObject({ port: 7799 });
    expect(t.spawns.map((spawned) => spawned.args[2])).toEqual(["7777", "7788", "7799"]);
    expect(aliveAtSpawn).toEqual([0, 0, 0]);
  });
});

describe("WebSupervisor default entry", () => {
  it("spawns the web child next to the supervisor module when no entry is given", async () => {
    const spawns: string[] = [];
    const child = new FakeChild();
    const supervisor = new WebSupervisor({
      log: () => {},
      spawnChild: (entry) => {
        spawns.push(entry);
        return child as unknown as WebChildProcess;
      },
    });

    const pending = supervisor.ensure({});
    child.handshake(ok());
    await pending;

    expect(spawns).toEqual([path.join(import.meta.dirname, "..", "src", "web", "child.js")]);
  });
});

describe("WebSupervisor.close", () => {
  it("sends SIGTERM to the running child and returns without waiting", async () => {
    const { supervisor, children } = harness();
    const pending = supervisor.ensure({});
    children[0].handshake(ok());
    await pending;
    children[0].exitOn = [];

    expect(supervisor.close()).toBeUndefined();
    expect(children[0].signals).toEqual(["SIGTERM"]);
  });
});

describe("spawnWebChild", () => {
  it("appends the child's stderr to logs/web-child.log", () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-web-child-log-"));
    const logFile = path.join(logsDir, "web-child.log");
    fs.writeFileSync(logFile, "old\n");
    const fakeSpawn = vi.fn((_command: string, args: readonly string[], options: { stdio: unknown[] }) => {
      fs.writeSync(options.stdio[2] as number, "new\n");
      return { args } as never;
    });

    try {
      spawnWebChild(ENTRY, ["--web-child"], { spawn: fakeSpawn as unknown as typeof spawn, logsDir });

      expect(fakeSpawn).toHaveBeenCalledWith(process.execPath, [ENTRY, "--web-child"], expect.objectContaining({
        stdio: ["pipe", "pipe", expect.any(Number)],
      }));
      expect(fs.readFileSync(logFile, "utf8")).toBe("old\nnew\n");
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe("daemon import boundary", () => {
  function localImports(file: string): string[] {
    const source = fs.readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);
    return specifiers.map((specifier) => path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")));
  }

  it.each(["src/daemon/web-supervisor.ts", "src/daemon/daemon.ts"])("%s reaches nothing in src/web or src/cli", (file) => {
    const root = path.join(import.meta.dirname, "..");
    const seen = new Set<string>();
    const queue = [path.join(root, file)];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next) || !fs.existsSync(next)) continue;
      seen.add(next);
      queue.push(...localImports(next));
    }

    const reached = [...seen].map((module) => path.relative(root, module));
    expect(reached.length).toBeGreaterThan(1);
    expect(reached.filter((module) => module.startsWith("src/web/") || module.startsWith("src/cli/"))).toEqual([]);
  });
});
