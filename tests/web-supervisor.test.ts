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

  it("kills the child and fails the start when no handshake arrives in time", async () => {
    vi.useFakeTimers();
    const { supervisor, children } = harness({ startTimeoutMs: 5000 });

    const pending = supervisor.ensure({});
    const settled = expect(pending).rejects.toMatchObject({ code: "WEB_START_FAILED" });
    await vi.advanceTimersByTimeAsync(5000);

    await settled;
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
    const { supervisor, children } = harness({ stopTimeoutMs: 3000 });
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
  it.each(["src/daemon/web-supervisor.ts", "src/daemon/daemon.ts"])("%s imports nothing from web or cli", (file) => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\.\/(web|cli)\//);
    expect(source).not.toMatch(/import\(\s*["']\.\.\/(web|cli)\//);
  });
});
