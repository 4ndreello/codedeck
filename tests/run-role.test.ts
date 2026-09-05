import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();

vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = vi.fn(async () => {});
    request = request;
  },
}));

const { registerRunCommand } = await import("../src/cli/commands/run.js");

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function runProgram(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program);
  return program.parseAsync(["node", "codedeck", "run", ...argv]);
}

let errors: string[];

beforeEach(() => {
  errors = [];
  request.mockReset();
  request.mockResolvedValue({ session: { id: "abcd", agent: "codex" } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The helpers are covered directly in roles.test.ts. What is only covered here
// is that `run` actually calls them and sends the result: dropping the wiring
// leaves every helper test green.
describe("codedeck run --role", () => {
  it("sends the composed prompt to session.create", async () => {
    await expect(runProgram(["do the thing", "--agent", "codex", "--role", "reviewer", "--bg"]))
      .rejects.toThrow(Exited);

    expect(request).toHaveBeenCalledWith("session.create", expect.any(Object));
    const [, params] = request.mock.calls[0];
    expect(params.prompt).toMatch(/^You are the CodeDeck reviewer\./);
    expect(params.prompt).toMatch(/\n\n---\n\ndo the thing$/);
    expect(params.prompt).not.toMatch(/^---/);
  });

  it("sends the prompt untouched without the flag", async () => {
    await expect(runProgram(["do the thing", "--agent", "codex", "--bg"]))
      .rejects.toThrow(Exited);

    const [, params] = request.mock.calls[0];
    expect(params.prompt).toBe("do the thing");
  });

  it.each([
    ["an unknown role", "implementer"],
    ["an empty value", ""],
  ])("refuses %s before reaching the daemon", async (_label, role) => {
    await expect(runProgram(["do the thing", `--role=${role}`]))
      .rejects.toThrow(expect.objectContaining({ code: 3 }));

    expect(request).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/Invalid role/);
  });
});
