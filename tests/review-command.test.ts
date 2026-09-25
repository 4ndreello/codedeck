import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFetch } from "./helpers/web-session.js";
import { parseReviewPort, registerReviewCommand } from "../src/cli/commands/review.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";
import { EventEmitter } from "node:events";

afterEach(() => vi.restoreAllMocks());

describe("parseReviewPort", () => {
  it("defaults to 3100", () => {
    expect(parseReviewPort(undefined)).toBe(3100);
  });

  it("accepts a valid port", () => {
    expect(parseReviewPort("8080")).toBe(8080);
  });

  it("rejects non-numeric, zero, and out-of-range ports", () => {
    for (const raw of ["abc", "0", "-1", "65536", "3.5", ""]) {
      expect(() => parseReviewPort(raw)).toThrow("--port must be a positive integer");
    }
  });
});

describe("registerReviewCommand", () => {
  it("registers review instead of the removed web command", () => {
    const program = new Command();
    registerReviewCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual(["review"]);
    expect(program.commands[0].description()).toContain("local review");
  });

  it("starts the shared server with the review aliases and API route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    let started: WebServerHandle | undefined;
    registerReviewCommand(program, {
      startServer: async (options) => {
        started = await startWebServer({
          ...options,
          port: 0,
          signalTarget: new EventEmitter(),
          exit: () => {},
        });
        return started;
      },
      loadReview: async (_root, ref, file) => ({ ref, file }),
    });

    await program.parseAsync(["node", "codedeck", "review", "--no-open"], { from: "node" });

    const initial = new URL(started?.initialUrl ?? "");
    expect(initial.searchParams.get("t")).toBe(started?.security.token);
    expect(initial.pathname).toBe("/review");
    expect(initial.searchParams.get("repo")).toBe(process.cwd());
    expect(log.mock.calls.flat().join(" ")).toContain(started?.initialUrl);
    const root = await sessionFetch(started)(`${started?.baseUrl}/`);
    const alias = await sessionFetch(started)(`${started?.baseUrl}/review`);
    expect(root.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(await root.text()).toContain("Review local");
    expect(await alias.text()).toContain("Review local");

    const repo = encodeURIComponent(process.cwd());
    const api = await sessionFetch(started)(`${started?.baseUrl}/api/review?file=src/web/server.ts&repo=${repo}`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ref: "HEAD", file: "src/web/server.ts" });

    await started?.close();
  });
});
