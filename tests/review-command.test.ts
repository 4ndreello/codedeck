import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionFetch } from "./helpers/web-session.js";
import { createReviewRoutes, parseReviewPort, registerReviewCommand } from "../src/cli/commands/review.js";
import { startWebServer } from "../src/web/server.js";
import { EventEmitter } from "node:events";

afterEach(() => vi.restoreAllMocks());

describe("parseReviewPort", () => {
  it("defaults to 7777", () => {
    expect(parseReviewPort(undefined)).toBe(7777);
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

  it("opens the review page for the current repo through the launcher", async () => {
    const launch = vi.fn(async () => 0);
    const program = new Command();
    registerReviewCommand(program, { launch });

    await program.parseAsync(["node", "codedeck", "review", "--no-open"], { from: "node" });

    expect(launch).toHaveBeenCalledWith({
      path: "/review",
      query: { repo: process.cwd() },
      title: "CodeDeck review",
      port: undefined,
      open: false,
    });
  });

  it("rejects an invalid port without launching", async () => {
    const launch = vi.fn(async () => 0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command();
    registerReviewCommand(program, { launch });
    const exitCode = process.exitCode;

    try {
      await program.parseAsync(["node", "codedeck", "review", "--port", "abc"], { from: "node" });

      expect(launch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
    }
  });
});

describe("review route table", () => {
  it("serves the review aliases and the API route", async () => {
    const started = await startWebServer({
      routes: createReviewRoutes({ loadReview: async (_root, ref, file) => ({ ref, file }) }),
      port: 0,
      initialPath: "/review",
      open: false,
      log: () => {},
      signalTarget: new EventEmitter(),
      exit: () => {},
    });

    try {
      const root = await sessionFetch(started)(`${started.baseUrl}/`);
      const alias = await sessionFetch(started)(`${started.baseUrl}/review`);
      expect(root.status).toBe(200);
      expect(alias.status).toBe(200);
      expect(await root.text()).toContain("Review local");
      expect(await alias.text()).toContain("Review local");

      const repo = encodeURIComponent(process.cwd());
      const api = await sessionFetch(started)(`${started.baseUrl}/api/review?file=src/web/server.ts&repo=${repo}`);
      expect(api.status).toBe(200);
      expect(await api.json()).toEqual({ ref: "HEAD", file: "src/web/server.ts" });
    } finally {
      await started.close();
    }
  });
});
