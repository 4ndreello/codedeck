import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let configDir: string;
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  errors = [];
  configDir = mkdtempSync(path.join(tmpdir(), "codedeck-run-sandbox-"));
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
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
  rmSync(configDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
});

function writeConfig(config: unknown): void {
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config), "utf-8");
}

async function created(argv: string[]): Promise<Record<string, unknown>> {
  await expect(runProgram([...argv, "--effort", "high", "--bg"])).rejects.toThrow(Exited);
  const [, params] = request.mock.calls[0] as [string, Record<string, unknown>];
  return params;
}

describe("codedeck run sandbox resolution", () => {
  it("uses an explicit sandbox flag over a different valid global default", async () => {
    writeConfig({ defaultAgent: "codex", defaultSandbox: "danger-full-access" });

    const params = await created(["do the thing", "--agent", "codex", "--sandbox", "read-only"]);

    expect(params.sandbox).toBe("read-only");
  });

  it("uses a valid global default when the flag is absent", async () => {
    writeConfig({ defaultAgent: "codex", defaultSandbox: "danger-full-access" });

    const params = await created(["do the thing", "--agent", "codex"]);

    expect(params.sandbox).toBe("danger-full-access");
  });

  it.each([
    ["absent", { defaultAgent: "codex" }],
    ["invalid", { defaultAgent: "codex", defaultSandbox: "network" }],
  ])("leaves the sandbox unset when the global default is %s", async (_label, config) => {
    writeConfig(config);

    const params = await created(["do the thing", "--agent", "codex"]);

    expect(params.sandbox).toBeUndefined();
  });

  it("lets an explicit flag win when the global default is invalid", async () => {
    writeConfig({ defaultAgent: "codex", defaultSandbox: "network" });

    const params = await created(["do the thing", "--agent", "codex", "--sandbox", "read-only"]);

    expect(params.sandbox).toBe("read-only");
  });

  it("preserves the bypass conflict behavior for an explicit sandbox", async () => {
    writeConfig({ defaultAgent: "codex" });
    const params = await created([
      "do the thing",
      "--agent",
      "codex",
      "--sandbox",
      "workspace-write",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);

    expect(params.sandbox).toBe("danger-full-access");
    expect(params.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(errors.join("\n")).toContain("implies --sandbox danger-full-access");
  });

  it.each(["claude", "opencode", "omp", "antigravity"])("clears a global sandbox for %s and warns", async (agent) => {
    writeConfig({ defaultAgent: agent, defaultSandbox: "danger-full-access" });

    const params = await created(["do the thing", "--agent", agent]);

    expect(params.sandbox).toBeUndefined();
    expect(errors.join("\n")).toContain(`--sandbox has no effect on ${agent}`);
  });
});
