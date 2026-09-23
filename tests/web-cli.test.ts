import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createCliProgram } from "../src/cli/index.js";
import { registerUiCommand } from "../src/cli/commands/ui.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";

const handles: WebServerHandle[] = [];
const originalExitCode = process.exitCode;

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("ui CLI command", () => {
  it("appears in root help and serves only its registered home and review pages", async () => {
    const root = createCliProgram();
    expect(root.helpInformation()).toContain("ui");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let started: WebServerHandle | undefined;
    const program = new Command();
    registerUiCommand(program, {
      startServer: async (options) => {
        started = await startWebServer({
          ...options,
          port: 0,
          signalTarget: new EventEmitter(),
          exit: vi.fn(),
        });
        handles.push(started);
        return started;
      },
    });
    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    expect(started).toBeDefined();
    expect(started?.initialUrl).toContain("?t=");
    expect(log.mock.calls.flat().join(" ")).toContain(started?.initialUrl);
    const rootResponse = await fetch(`${started?.baseUrl}/`);
    const rootHtml = await rootResponse.text();
    expect(rootResponse.status).toBe(200);
    expect(rootHtml).toContain('href="/review"');
    expect(rootHtml).not.toContain('href="/setup"');
    expect(rootHtml).not.toContain('href="/usage"');

    const reviewResponse = await fetch(`${started?.baseUrl}/review`);
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(await reviewResponse.text()).toContain("Review local");
  });

  it("rejects an invalid port without starting a server", async () => {
    const startServer = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerUiCommand(program, { startServer });

    await program.parseAsync(["node", "codedeck", "ui", "--port", "0"], { from: "node" });

    expect(startServer).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("--port must be a positive integer");
    expect(process.exitCode).toBe(1);
  });

  it("reports a listen failure without printing a started URL", async () => {
    const startServer = vi.fn(async () => {
      throw new Error("EADDRINUSE");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerUiCommand(program, { startServer });

    await program.parseAsync(["node", "codedeck", "ui", "--no-open"], { from: "node" });

    expect(startServer).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Failed to listen on 127.0.0.1:3100: EADDRINUSE");
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
