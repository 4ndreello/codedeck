import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureDaemonStarted = vi.fn(async () => {});
const request = vi.fn();

vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = ensureDaemonStarted;
    request = request;
  },
}));

const { registerClaimsCommand } = await import("../src/cli/commands/claims.js");

const claim = {
  id: 7,
  sessionId: "session-a",
  pathGlob: "src/auth/*",
  reason: "refactor login flow",
  createdAt: "2026-09-06T12:00:00.000Z",
  active: true,
};

function runProgram(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClaimsCommand(program);
  return program.parseAsync(["node", "codedeck", "claims", ...argv], { from: "node" });
}

let logs: string[];
let errors: string[];
const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = undefined;
  logs = [];
  errors = [];
  ensureDaemonStarted.mockClear();
  request.mockReset();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("claims argv wiring", () => {
  it("maps add to claims.add with the path, reason, and session", async () => {
    request.mockResolvedValue({ claim });

    await runProgram([
      "add",
      "src/auth/*",
      "--reason",
      "refactor login flow",
      "--session",
      "session-a",
    ]);

    expect(ensureDaemonStarted).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("claims.add", {
      sessionId: "session-a",
      pathGlob: "src/auth/*",
      reason: "refactor login flow",
    });
  });

  it("maps list without a path to claims.query with only the session", async () => {
    request.mockResolvedValue({ claims: [] });

    await runProgram(["list", "--session", "session-a"]);

    expect(request).toHaveBeenCalledWith("claims.query", { sessionId: "session-a" });
  });

  it("maps a list path to the query path parameter", async () => {
    request.mockResolvedValue({ claims: [claim] });

    await runProgram(["list", "src/auth/login.ts", "--session", "session-b"]);

    expect(request).toHaveBeenCalledWith("claims.query", {
      sessionId: "session-b",
      path: "src/auth/login.ts",
    });
  });

  it("maps release to claims.release with a numeric claim id", async () => {
    request.mockResolvedValue({ claim: { ...claim, active: false } });

    await runProgram(["release", "7", "--session", "session-a"]);

    expect(request).toHaveBeenCalledWith("claims.release", {
      sessionId: "session-a",
      claimId: 7,
    });
  });
});

describe("claims JSON envelopes", () => {
  it("wraps an added claim as { claim }", async () => {
    request.mockResolvedValue({ claim });

    await runProgram(["add", "src/auth/*", "--reason", claim.reason, "--session", claim.sessionId, "--json"]);

    expect(JSON.parse(logs[0]!)).toEqual({ claim });
    expect(Object.keys(JSON.parse(logs[0]!))).toEqual(["claim"]);
  });

  it("wraps listed claims as { claims }", async () => {
    request.mockResolvedValue({ claims: [claim] });

    await runProgram(["list", "--session", claim.sessionId, "--json"]);

    expect(JSON.parse(logs[0]!)).toEqual({ claims: [claim] });
    expect(Object.keys(JSON.parse(logs[0]!))).toEqual(["claims"]);
  });

  it("wraps a released claim as { claim }", async () => {
    const released = { ...claim, active: false };
    request.mockResolvedValue({ claim: released });

    await runProgram(["release", String(claim.id), "--session", claim.sessionId, "--json"]);

    expect(JSON.parse(logs[0]!)).toEqual({ claim: released });
    expect(Object.keys(JSON.parse(logs[0]!))).toEqual(["claim"]);
  });

  it("writes the error envelope to stderr and sets a nonzero exit code", async () => {
    const error = Object.assign(new Error("Claim \"7\" not found"), {
      code: "CLAIM_NOT_FOUND",
    });
    request.mockRejectedValue(error);

    await runProgram(["release", "7", "--session", claim.sessionId, "--json"]);

    expect(errors).toEqual([
      JSON.stringify({ error: { code: "CLAIM_NOT_FOUND", message: "Claim \"7\" not found" } }),
    ]);
    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("requires an explicit session when no session-id environment mechanism exists", async () => {
    request.mockResolvedValue({ claims: [] });

    await runProgram(["list", "--json"]);

    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(errors[0]!)).toEqual({
      error: {
        code: "SESSION_REQUIRED",
        message: expect.stringContaining("--session <id> is required"),
      },
    });
    expect(process.exitCode).toBe(1);
  });
});
