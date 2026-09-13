import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();

vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = vi.fn(async () => {});
    request = request;
  },
}));

const { registerRunCommand, runIdFromEnvironment } = await import("../src/cli/commands/run.js");

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
const originalTopConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

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
  const dir = mkdtempSync(path.join(tmpdir(), "codedeck-run-effort-"));
  process.env.RUN_AGENT_CONFIG_DIR = dir;
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({}), "utf-8");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTopConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalTopConfigDir;
});

// The helpers are covered directly in roles.test.ts. What is only covered here
// is that `run` actually calls them and sends the result: dropping the wiring
// leaves every helper test green.
describe("codedeck run --role", () => {
  it("passes the inherited run id to session.create", async () => {
    const previousRunId = process.env.CODEDECK_RUN_ID;
    process.env.CODEDECK_RUN_ID = "run-from-open";

    try {
      await expect(runProgram(["do the thing", "--agent", "codex", "--effort", "high", "--bg"]))
        .rejects.toThrow(Exited);
    } finally {
      if (previousRunId === undefined) delete process.env.CODEDECK_RUN_ID;
      else process.env.CODEDECK_RUN_ID = previousRunId;
    }

    const [, params] = request.mock.calls[0];
    expect(params.runId).toBe("run-from-open");
  });

  it("maps a missing run id to null", () => {
    expect(runIdFromEnvironment({})).toBeNull();
  });

  it("maps an empty run id to null", () => {
    expect(runIdFromEnvironment({ CODEDECK_RUN_ID: "" })).toBeNull();
  });

  it("sends the composed prompt to session.create", async () => {
    await expect(runProgram(["do the thing", "--agent", "codex", "--role", "reviewer", "--effort", "high", "--bg"]))
      .rejects.toThrow(Exited);

    expect(request).toHaveBeenCalledWith("session.create", expect.any(Object));
    const [, params] = request.mock.calls[0];
    expect(params.prompt).toMatch(/^# CodeDeck Ultra\n\nYou are running inside a CodeDeck session\./);
    expect(params.prompt).toContain("You are the CodeDeck reviewer.");
    expect(params.prompt).toMatch(/\n\n---\n\ndo the thing$/);
    expect(params.prompt).not.toMatch(/^---/);
  });

  it("sends the prompt untouched without the flag", async () => {
    await expect(runProgram(["do the thing", "--agent", "codex", "--effort", "high", "--bg"]))
      .rejects.toThrow(Exited);

    const [, params] = request.mock.calls[0];
    expect(params.prompt).toBe("do the thing");
  });

  it("derives the session name from the raw task prompt", async () => {
    await expect(runProgram(["Fix OAuth login!!!", "--agent", "codex", "--effort", "high", "--bg"]))
      .rejects.toThrow(Exited);

    const [, params] = request.mock.calls[0];
    expect(params.name).toBe("fix-oauth-login");
  });

  it("derives the session name from the raw prompt before role composition", async () => {
    await expect(runProgram(["Fix OAuth login!!!", "--agent", "codex", "--role", "reviewer", "--effort", "high", "--bg"]))
      .rejects.toThrow(Exited);

    const [, params] = request.mock.calls[0];
    expect(params.name).toBe("fix-oauth-login");
    expect(params.prompt).toContain("You are the CodeDeck reviewer.");
    expect(params.name).not.toContain("reviewer");
  });

  it("keeps an explicitly supplied session name verbatim", async () => {
    await expect(runProgram(["Fix OAuth login!!!", "--agent", "codex", "--name", "OAuth / v2", "--effort", "high", "--bg"]))
      .rejects.toThrow(Exited);

    const [, params] = request.mock.calls[0];
    expect(params.name).toBe("OAuth / v2");
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

// A binding is two halves, and this is where they are spent. The wizard writing
// them and the resolver reading them are both covered elsewhere; only here does
// a wrong pairing actually reach a harness.
describe("the harness and model a role is bound to", () => {
  const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

  function writeConfig(config: unknown): void {
    const dir = mkdtempSync(path.join(tmpdir(), "codedeck-run-role-"));
    process.env.RUN_AGENT_CONFIG_DIR = dir;
    writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf-8");
  }
  const bound = {
    defaultAgent: "claude",
    models: { claude: "claude-configured" },
    agents: { reviewer: { harness: "codex", model: "gpt-5.6-luna", effort: "max" } },
  };

  async function created(argv: string[]): Promise<{ agent: string; model?: string }> {
    await expect(runProgram([...argv, "--effort", "high", "--bg"])).rejects.toThrow(Exited);
    const [, params] = request.mock.calls[0];
    return { agent: params.agent, model: params.model };
  }

  it("takes both halves from the binding when no flag says otherwise", async () => {
    writeConfig(bound);

    expect(await created(["do the thing", "--role", "reviewer"])).toEqual({
      agent: "codex",
      model: "gpt-5.6-luna",
    });
  });

  // A worker used to force the run onto its own harness by appending --agent.
  // A bound role now owns the harness, so the flag is ignored with a warning.
  it("ignores --agent for a bound role, keeping the binding", async () => {
    writeConfig(bound);

    expect(await created(["do the thing", "--role", "reviewer", "--agent", "claude"])).toEqual({
      agent: "codex",
      model: "gpt-5.6-luna",
    });
    expect(errors.join("\n")).toMatch(/--agent .*ignored/);
  });

  // The model belongs to the harness, so a bound role owns that half too:
  // --model cannot swap it either.
  it("ignores --model for a bound role, keeping the binding", async () => {
    writeConfig(bound);

    expect(await created(["do the thing", "--role", "reviewer", "--model", "gpt-6"])).toEqual({
      agent: "codex",
      model: "gpt-5.6-luna",
    });
    expect(errors.join("\n")).toMatch(/--model .*ignored/);
  });

  // Skipping an agent in setup leaves it unbound, and an unbound role is not an
  it("falls back to the per-harness model for a role nobody bound", async () => {
    writeConfig({ defaultAgent: "claude", models: { claude: "claude-configured" }, agents: {} });

    expect(await created(["do the thing", "--role", "auditor"])).toEqual({
      agent: "claude",
      model: "claude-configured",
    });
    expect(errors.join("\n")).toMatch(/role "auditor" is not bound/);
  });
});
